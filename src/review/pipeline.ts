/**
 * Hunk routing and ranking for a diffninja review run.
 *
 * Every input unit comes back as exactly one ReviewItem. A unit is judged by
 * the model only when the deterministic checks cannot settle it:
 *
 *   - a unit the input parser marked special never reaches the model;
 *   - an exact no-op hunk and a blank-only change to a .md/.txt document pass
 *     deterministically;
 *   - a hunk whose serialized state exceeds the size cap goes to manual review
 *     uncalled, never truncated and never auto-passed;
 *   - anything else gets repeated Jev calls, and a failed or malformed call fails
 *     closed (uncertain) instead of degrading into a pass. A transient failure
 *     is retried with the documented backoff before that happens;
 *   - a judgment is only trusted when the averaged distributions have a clear
 *     winner and the runs agree, so flat or unstable answers escalate to a human.
 *
 * Items are returned sorted by status (attention, uncertain, low, passed) and
 * then by priority, descending, with input order breaking ties.
 */

import {
  JevClient,
  JevRequestError,
  JevResponseError,
  MAX_STATE_CHARS,
  MAX_RISK_LEVEL,
  RISK_LEVELS,
  buildJevState,
  isReviewCategory,
  missingApiKeyError,
  mockAssessment,
  resolveJevApiKey,
  type JevAssessment,
  type JevState,
  type ReviewCategory,
} from "./jev.js";
import type { Judgment, ReviewItem, ReviewOptions, ReviewStatus, ReviewUnit } from "./types.js";

/** How much each model answer weighs in the 0..100 priority. Sums to 100. */
export const PRIORITY_WEIGHTS = { risk: 50, bug: 30, needsHuman: 20 } as const;

/** Category boost on top of the weighted score, capped by the final clamp. */
export const CATEGORY_PRIORITY = {
  security: 12,
  "bug-risk": 10,
  "api-change": 8,
  "error-handling": 6,
  performance: 4,
  "test-gap": 3,
  refactor: 0,
  style: 0,
  docs: 0,
  other: 0,
} satisfies Record<ReviewCategory, number>;

/** A bug probability strictly inside this band is a split vote, so the hunk is uncertain. */
export const GRAY_BAND_LOW = 0.35;
export const GRAY_BAND_HIGH = 0.65;
/**
 * The averaged risk distribution must put at least this much weight on one level,
 * and the category distribution this much on one option. A flatter distribution
 * means the state did not separate the alternatives, which is the documented
 * signal to escalate rather than act.
 */
export const TOP_LEVEL_PROBABILITY_FLOOR = 0.6;
export const TOP_CATEGORY_PROBABILITY_FLOOR = 0.6;
/** Maximum run-to-mean total variation at or above this signals unstable judgments. */
export const DIVERGENCE_THRESHOLD = 0.35;
/** At or above this, the model itself says the context is insufficient. */
export const NEEDS_HUMAN_GATE = 0.6;
/** At or above these, the hunk is ranked for attention. */
export const RISK_ATTENTION_GATE = 2;
export const BUG_ATTENTION_GATE = 0.65;

/** Fixed priorities for hunks that were not judged by a model. */
export const FAILED_CALL_PRIORITY = 80;
export const MANUAL_REVIEW_PRIORITY = 70;
export const TRIVIAL_PRIORITY = 5;

/** Sort order for statuses: attention first, passed last. */
export const STATUS_RANK = {
  attention: 0,
  uncertain: 1,
  low: 2,
  passed: 3,
} satisfies Record<ReviewStatus, number>;

/** At most this many live requests are in flight at once. */
export const MAX_CONCURRENT_REQUESTS = 4;

/** Run-level notice attached whenever any judgment came from mock fixtures. */
export const MOCK_MODE_WARNING =
  "Mock mode: no API call was made. Every judgment in this run is a deterministic local fixture " +
  "used to exercise routing and ranking, not an assessment of the code.";

const ROUTING_REASON = {
  attention: "routed to attention: an attention gate was crossed",
  uncertain: "routed to uncertain: an uncertainty gate fired, so a human has to decide",
  low: "routed to low: no gate fired and the change reads as minor",
  passed: "routed to passed: no gate fired and no signal was found",
} satisfies Record<ReviewStatus, string>;

const UNJUDGED_NOTE = "no model judgment was recorded for this hunk; a human has to read it";

export interface ReviewPipelineResult {
  readonly items: ReviewItem[];
  readonly modelCalls: number;
  /** Run-level notices for the report; per-hunk detail stays in `reasons`. */
  readonly warnings: string[];
}

type UnitRoute =
  | { readonly kind: "judge"; readonly state: JevState }
  | { readonly kind: "pass"; readonly reason: string }
  | { readonly kind: "manual"; readonly reason: string };

/** One input unit paired with its position, so ties keep input order. */
interface RoutedItem {
  readonly index: number;
  readonly item: ReviewItem;
}

/** A unit waiting on its live judgment runs. */
interface PendingUnit {
  readonly index: number;
  readonly state: JevState;
}

function percent(probability: number): string {
  return `${Math.round(clampProbability(probability) * 100)}%`;
}

function clampProbability(probability: number): number {
  return Math.max(0, Math.min(1, probability));
}

function clampPriority(priority: number): number {
  return Math.max(0, Math.min(100, Math.round(priority)));
}

/**
 * Count added and removed lines in the hunk text. File headers (---/+++) are
 * not changes, and a `\ No newline` marker scores as neither. A body line whose
 * content itself starts with `++` is indistinguishable from a header here and
 * is treated as one, which can only ever make a hunk look smaller.
 */
function countChangedLines(diff: string) {
  let added = 0;
  let removed = 0;
  let nonBlank = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) {
      added += 1;
      if (line.slice(1).trim() !== "") nonBlank += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      if (line.slice(1).trim() !== "") nonBlank += 1;
    }
  }
  return { added, removed, nonBlank };
}

/**
 * Deterministic pass rules. Only two shapes qualify: a hunk with no added or
 * removed lines at all, and a change whose added and removed lines are all
 * blank in a text document (.md/.txt). Whitespace or comment churn in code
 * never qualifies.
 */
function deterministicPassReason(unit: ReviewUnit): string | null {
  const changed = countChangedLines(unit.diff);
  if (changed.added === 0 && changed.removed === 0) {
    return "exact no-op: the hunk adds and removes no lines";
  }
  if (changed.nonBlank > 0) return null;
  const path = unit.file.toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".txt")) {
    return `blank-only change to a text document (${changed.added} added, ${changed.removed} removed blank line(s))`;
  }
  return null;
}

function routeUnit(unit: ReviewUnit): UnitRoute {
  if (unit.special !== undefined && unit.special !== "") {
    return {
      kind: "manual",
      reason: `special unit (${unit.special}): not sent to the model, needs manual review`,
    };
  }
  if (unit.diff.trim() === "") {
    return { kind: "manual", reason: "no diff text was supplied for this hunk; needs manual review" };
  }
  const passReason = deterministicPassReason(unit);
  if (passReason !== null) return { kind: "pass", reason: passReason };
  const state = buildJevState(unit);
  const stateChars = JSON.stringify(state).length;
  if (stateChars > MAX_STATE_CHARS) {
    return {
      kind: "manual",
      reason:
        `state is ${stateChars} characters, above the ${MAX_STATE_CHARS} character cap; ` +
        "not truncated and not sent to the model, so it needs manual review",
    };
  }
  return { kind: "judge", state };
}

/** Status from the validated answers, gates first so a split vote never ranks as attention. */
function statusFor(assessment: JevAssessment): ReviewStatus {
  const { judgment, riskTopProbability, categoryTopProbability } = assessment;
  if (assessment.divergence >= DIVERGENCE_THRESHOLD) return "uncertain";
  if (judgment.bug > GRAY_BAND_LOW && judgment.bug < GRAY_BAND_HIGH) return "uncertain";
  if (judgment.needsHuman > GRAY_BAND_LOW && judgment.needsHuman < GRAY_BAND_HIGH) return "uncertain";
  if (riskTopProbability < TOP_LEVEL_PROBABILITY_FLOOR) return "uncertain";
  if (categoryTopProbability < TOP_CATEGORY_PROBABILITY_FLOOR) return "uncertain";
  if (judgment.needsHuman >= NEEDS_HUMAN_GATE) return "uncertain";
  if (judgment.risk >= RISK_ATTENTION_GATE || judgment.bug >= BUG_ATTENTION_GATE) return "attention";
  return "low";
}

/** Weighted 0..100 priority: model answers plus the category boost, clamped. */
function priorityFor(judgment: Judgment): number {
  const weighted =
    (clampProbability(judgment.risk / MAX_RISK_LEVEL) * PRIORITY_WEIGHTS.risk) +
    clampProbability(judgment.bug) * PRIORITY_WEIGHTS.bug +
    clampProbability(judgment.needsHuman) * PRIORITY_WEIGHTS.needsHuman;
  const boost = isReviewCategory(judgment.category) ? CATEGORY_PRIORITY[judgment.category] : 0;
  return clampPriority(weighted + boost);
}

/**
 * Reasons are fixed templates filled with the returned values and this file's
 * own rubric text. No model-authored text is ever quoted, so a reason can only
 * restate a number, a category, and a named gate.
 */
function reasonsFor(unit: ReviewUnit, assessment: JevAssessment, status: ReviewStatus): string[] {
  const judgment = assessment.judgment;
  const level = Math.min(MAX_RISK_LEVEL, Math.max(0, Math.round(judgment.risk)));
  const reasons = [
    `impact risk ${Math.round(judgment.risk * 10) / 10}/3 (nearest rubric level: ${RISK_LEVELS[level]})`,
    `likely bug ${percent(judgment.bug)} against the ${percent(BUG_ATTENTION_GATE)} attention gate`,
    `category: ${judgment.category}`,
    `model confidence ${percent(judgment.confidence)} (informational only)`,
    `needs human ${percent(judgment.needsHuman)} against the ${percent(NEEDS_HUMAN_GATE)} gate`,
  ];
  if (assessment.riskTopProbability < TOP_LEVEL_PROBABILITY_FLOOR) {
    reasons.push(
      `risk levels are split: the strongest level holds ${percent(assessment.riskTopProbability)} of the vote, under the ${percent(TOP_LEVEL_PROBABILITY_FLOOR)} floor`,
    );
  }
  if (assessment.categoryTopProbability < TOP_CATEGORY_PROBABILITY_FLOOR) {
    reasons.push(
      `no category stands out: the likeliest holds ${percent(assessment.categoryTopProbability)} of the vote, under the ${percent(TOP_CATEGORY_PROBABILITY_FLOOR)} floor`,
    );
  }
  if (assessment.divergence >= DIVERGENCE_THRESHOLD) {
    reasons.push(
      `judgment runs disagree: maximum distribution divergence ${percent(assessment.divergence)} meets the ${percent(DIVERGENCE_THRESHOLD)} threshold`,
    );
  }
  if (unit.callFlow === undefined || unit.callFlow.length === 0) {
    reasons.push("no call flow was supplied, so this judgment used the hunk alone");
  }
  reasons.push(ROUTING_REASON[status]);
  return reasons;
}

function judgedItem(unit: ReviewUnit, assessment: JevAssessment, mock: boolean): ReviewItem {
  const status = statusFor(assessment);
  const reasons = reasonsFor(unit, assessment, status);
  if (mock) {
    reasons.unshift("mock mode: these values are a deterministic local fixture, not a live Jev judgment");
  }
  return {
    ...unit,
    status,
    priority: priorityFor(assessment.judgment),
    reasons,
    judgment: assessment.judgment,
  };
}

function unjudgedItem(unit: ReviewUnit, reason: string, priority: number): ReviewItem {
  return { ...unit, status: "uncertain", priority, reasons: [reason, UNJUDGED_NOTE] };
}

function passedItem(unit: ReviewUnit, reason: string): ReviewItem {
  return {
    ...unit,
    status: "passed",
    priority: TRIVIAL_PRIORITY,
    reasons: [
      reason,
      "deterministic routing: no model call was made for this hunk, and a human may still want to skim it",
    ],
  };
}

function failureReason(error: JevRequestError | JevResponseError): string {
  const kind = error instanceof JevRequestError ? "the live model call failed" : "the live answer was malformed";
  return `${kind}, so this hunk fails closed: ${error.message}`;
}

/** Run `run` over `entries` with at most `limit` in flight at once. */
async function forEachConcurrent<Entry>(
  entries: readonly Entry[],
  limit: number,
  run: (entry: Entry) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next];
      next += 1;
      await run(entry);
    }
  });
  await Promise.all(workers);
}

/**
 * Review every unit and rank the results.
 *
 * `modelCalls` counts HTTP requests attempted, including retries and failures.
 * Mock runs make no network calls and report zero. A live
 * run with no usable key throws `JevConfigurationError` before any request when
 * at least one hunk needs the model.
 */
export async function reviewUnits(
  units: ReviewUnit[],
  options: ReviewOptions = {},
): Promise<ReviewPipelineResult> {
  const warnings: string[] = [];
  const routes = units.map(routeUnit);
  const routed: RoutedItem[] = [];
  const failureNotes = new Map<number, string>();
  const pending: PendingUnit[] = [];
  let modelCalls = 0;

  routes.forEach((route, index) => {
    const unit = units[index];
    if (route.kind === "pass") {
      routed.push({ index, item: passedItem(unit, route.reason) });
    } else if (route.kind === "manual") {
      routed.push({ index, item: unjudgedItem(unit, route.reason, MANUAL_REVIEW_PRIORITY) });
    } else {
      pending.push({ index, state: route.state });
    }
  });

  const mockRun = options.mock === true;
  if (mockRun) {
    if (pending.length > 0) warnings.push(MOCK_MODE_WARNING);
    for (const entry of pending) {
      routed.push({
        index: entry.index,
        item: judgedItem(units[entry.index], mockAssessment(units[entry.index]), true),
      });
    }
  } else if (pending.length > 0) {
    const apiKey = resolveJevApiKey(options);
    if (apiKey === null) throw missingApiKeyError(pending.length);
    const client = new JevClient(apiKey, options.fetch ?? globalThis.fetch);
    await forEachConcurrent(pending, MAX_CONCURRENT_REQUESTS, async (entry) => {
      const unit = units[entry.index];
      try {
        const item = judgedItem(unit, await client.judge(entry.state), false);
        routed.push({ index: entry.index, item });
      } catch (error) {
        if (!(error instanceof JevRequestError) && !(error instanceof JevResponseError)) throw error;
        routed.push({
          index: entry.index,
          item: unjudgedItem(unit, failureReason(error), FAILED_CALL_PRIORITY),
        });
        failureNotes.set(entry.index, `${unit.file} ${unit.header}: ${error.message}`);
      }
    });
    modelCalls = client.requestCount;
  }

  units.forEach((_unit, index) => {
    const note = failureNotes.get(index);
    if (note !== undefined) warnings.push(note);
  });

  routed.sort(
    (left, right) =>
      STATUS_RANK[left.item.status] - STATUS_RANK[right.item.status] ||
      right.item.priority - left.item.priority ||
      left.index - right.index,
  );

  return {
    items: routed.map((entry) => entry.item),
    modelCalls,
    warnings,
  };
}
