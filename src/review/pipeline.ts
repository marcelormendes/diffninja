/**
 * Hunk routing and ranking for a diffninja review run.
 *
 * Every input unit comes back as exactly one ReviewItem. A unit is judged by
 * the model only when the deterministic checks cannot settle it:
 *
 *   - a unit the input parser marked special never reaches the model;
 *   - an exact no-op hunk and a blank-only change to a .md/.txt document pass
 *     deterministically;
 *   - a hunk whose essential state (file, hunk, diff, and the context note)
 *     exceeds the size cap goes to manual review uncalled, never truncated and
 *     never auto-passed, and reports why through `routing`; optional context
 *     nodes are measured and dropped whole to fit first, so context size alone
 *     never costs a hunk its model call;
 *   - anything else gets exactly one Jev request, and a failed or malformed
 *     response fails closed (uncertain) instead of degrading into a pass;
 *   - an answer that did not separate its own options escalates to a human,
 *     because a flat distribution is no observation at all.
 *
 * Priority is computed deterministically from the returned observations, by the
 * fixed tables below: a rerun that returned the same observations would rank the
 * hunk identically. The tables express reading order, not a probability, and
 * model self-reported confidence is never a ranking input.
 *
 * Items are returned sorted by status (attention, uncertain, low, passed) and
 * then by priority, descending, with input order breaking ties.
 */

import {
  CALLER_VISIBLE_LEVEL,
  JevClient,
  JevRequestError,
  JevResponseError,
  MAX_STATE_CHARS,
  buildJevState,
  missingApiKeyError,
  mockAssessment,
  resolveJevApiKey,
  type BoundaryObservation,
  type EvidenceScope,
  type FailureObservation,
  type JevAssessment,
  type JevObservation,
  type JevState,
} from "./jev.js";
import { buildContextState } from "./context-plan.js";
import type {
  ReviewItem,
  ReviewOptions,
  ReviewRouting,
  ReviewStatus,
  ReviewUnit,
} from "./types.js";

/**
 * Deterministic reading weight per outcome level, indexed by level 0..3 in the
 * adapter's `OUTCOME_LEVELS` order (none, internal, caller-visible, contract):
 * what changed about observable behavior decides the base of the 0..100 priority.
 */
export const OUTCOME_PRIORITY: readonly number[] = [5, 25, 55, 75];

/** Deterministic weight per boundary observation, added to the outcome base. */
export const BOUNDARY_PRIORITY = {
  none: 0,
  unknown: 0,
  comparison: 6,
  validation: 6,
  limit: 15,
} satisfies Record<BoundaryObservation, number>;

/** Deterministic weight per failure observation, added to the outcome base. */
export const FAILURE_PRIORITY = {
  untouched: 0,
  unknown: 0,
  propagated: 3,
  deferred: 6,
  swallowed: 15,
} satisfies Record<FailureObservation, number>;

/**
 * Deterministic weight per evidence scope. Missing evidence raises the reading
 * priority — a hunk whose callers are not shown is worth a look — and never vetoes
 * or lowers it: `not-established` is a fact about the state, not a defect.
 */
export const EVIDENCE_PRIORITY = {
  "not-established": 6,
  "changed-code": 0,
  "direct-callers": 2,
  contracts: 4,
} satisfies Record<EvidenceScope, number>;

/**
 * The reported option must hold more than this share of the accounted probability
 * for the answer to count as decisive. A share at or below the floor — an exact
 * half included, where the option that gets *named* is decided by the canonical
 * option order rather than by the vote — is not a choice between the reported
 * option and its rival, so the hunk escalates to a human instead of being ranked
 * from a peak nobody voted for.
 */
export const OBSERVATION_PROBABILITY_FLOOR = 0.5;

/**
 * Float slack on {@link OBSERVATION_PROBABILITY_FLOOR}. The adapter accepts a
 * distribution with a small sum tolerance and accepts a named winner within float
 * slack of its rival, so a share that exceeds the floor by less than this is
 * numerical noise rather than support: it is treated as the tie it is, and the
 * hunk escalates. Same 1e-6 scale the adapter uses to decide two options are
 * indistinguishable, and the conservative direction is deliberate.
 */
export const OBSERVATION_TIE_TOLERANCE = 1e-6;

/** Human label per answered observation, used in the fixed reason templates. */
const OBSERVATION_LABEL = {
  outcome: "outcome",
  boundary: "boundary",
  failureHandling: "failure handling",
  evidenceScope: "evidence scope",
} as const;

/**
 * Sentence appended for each answer whose reported option did not hold a decisive
 * share. It states the share the answer gave its own reported option and the floor
 * it missed, without claiming the opposite answer is correct.
 */
function unseparatedAnswerReason(
  label: keyof typeof OBSERVATION_LABEL,
  observation: JevObservation<string>,
): string {
  return (
    `the ${OBSERVATION_LABEL[label]} answer did not separate its options: the reported option ` +
    `holds ${percent(observation.reportedShare)} of the accounted distribution, at or under the ` +
    `${percent(OBSERVATION_PROBABILITY_FLOOR)} floor`
  );
}

/**
 * Sentence appended when an observation came back as `unknown`. The model said
 * the lines touch this behavior but the state does not support one classification,
 * so the answer contributes no reading weight and the hunk needs a human.
 */
function unknownObservationReason(label: keyof typeof OBSERVATION_LABEL): string {
  return (
    `the ${label} answer was unknown: these lines touch this behavior but the supplied state does ` +
    "not support one of the defined options, so it adds no reading weight and a human has to decide"
  );
}

/**
 * Sentence appended when the supplied state did not show how the changed lines
 * are reached. It is a statement about the evidence, not about the change, so it
 * never claims a defect and never changes a status.
 */
const MISSING_EVIDENCE_REASON =
  "the supplied context did not establish how these lines are reached: missing evidence, not a " +
  "defect claim, and the reading priority was raised rather than the status";

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

/**
 * Run-level notice attached to every live run that judged at least one hunk. One
 * response per hunk is one sample: the observations are recorded as returned, and
 * no reason claims a rerun would report the same ones.
 */
export const SINGLE_SAMPLE_WARNING =
  "Live review sends one request per hunk: each judgment is a single sample from a stochastic " +
  "model and may differ on a rerun. Priority and ordering are computed deterministically from the " +
  "observations that were returned, not from a probability that they repeat.";

const ROUTING_REASON = {
  attention: "routed to attention: a caller-visible observation or a high-signal line fact was returned",
  uncertain: "routed to uncertain: an answer was not decisive about its own options, so a human has to decide",
  low: "routed to low: the returned observations read as minor",
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
  | { readonly kind: "manual"; readonly reason: string; readonly routing?: ReviewRouting };

/** One input unit paired with its position, so ties keep input order. */
interface RoutedItem {
  readonly index: number;
  readonly item: ReviewItem;
}

/** A unit waiting on its live judgment. */
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
  // The context is gathered here, before the one request: the base state plus as
  // many whole nodes as fit. Nothing is fetched or asked for afterwards.
  const suppliedNodes = unit.contextNodes ?? [];
  const state = buildContextState(buildJevState(unit), suppliedNodes);
  // buildContextState admits nodes only while they fit, so a state still above
  // the cap here is one whose essentials cannot fit at any trim.
  const stateChars = JSON.stringify(state).length;
  if (stateChars > MAX_STATE_CHARS) {
    const trimmed =
      suppliedNodes.length > 0
        ? `even after every optional context node was left out`
        : "with no optional context to omit";
    return {
      kind: "manual",
      reason:
        `essential state is ${stateChars} characters, above the ${MAX_STATE_CHARS} character cap ` +
        `${trimmed}; the hunk is not truncated and was not sent to the model, so it needs manual review`,
      routing: {
        evaluation: "not_evaluated",
        reasonCode: "context_limit_exceeded",
        requiredChars: stateChars,
        limitChars: MAX_STATE_CHARS,
      },
    };
  }
  return { kind: "judge", state };
}

/**
 * Whether a returned answer counted as decisive. The option this assessment
 * reports must hold more than {@link OBSERVATION_PROBABILITY_FLOOR} of the
 * probability the answer accounted for, by more than
 * {@link OBSERVATION_TIE_TOLERANCE} so numerical noise cannot decide.
 *
 * A strict majority is also a unique winner: two options cannot both hold more
 * than half of the same total, so this one comparison rules out an exact tie (the
 * reported option is then named by the canonical option order, not by the vote)
 * and a "win" produced only by the accepted sum tolerance or the winner slack. One
 * predicate serves both the routing decision and the reason text, so the escalation
 * and its explanation can never disagree.
 */
function isDecisive(observation: JevObservation<string>): boolean {
  return observation.reportedShare - OBSERVATION_PROBABILITY_FLOOR > OBSERVATION_TIE_TOLERANCE;
}

/** The four answered observations, each with its label, in a fixed order. */
function observationsOf(assessment: JevAssessment): readonly (readonly [keyof typeof OBSERVATION_LABEL, JevObservation<string>])[] {
  return [
    ["outcome", { choice: assessment.judgment.outcome, reportedShare: assessment.outcomeReportedShare }],
    ["boundary", assessment.boundary],
    ["failureHandling", assessment.failureHandling],
    ["evidenceScope", assessment.evidenceScope],
  ];
}

/**
 * Status from the validated observations, gates first so an answer that did not
 * separate its options never ranks as attention.
 *
 * An answer that came back `unknown` is treated the same way: the model said the
 * lines touch this behavior but the state does not support one classification, so
 * the run cannot rank it and a human decides. That is an escalation, not a signal:
 * `unknown` contributes no reading weight, and it exists so that unsupported lines
 * are never pushed into `none` or `untouched` and read as an absence claim.
 *
 * Otherwise, only two observations route to attention on their own: a change a
 * caller can observe, and a line fact that reads as an unhandled or unexamined
 * boundary (`limit`) or as a discarded failure (`swallowed`). Everything else is
 * `low`. Missing evidence (`not-established`) raises priority and appears in the
 * reasons, but never votes: it is not knowledge about the change.
 */
function statusFor(assessment: JevAssessment): ReviewStatus {
  if (assessment.boundary.choice === "unknown") return "uncertain";
  if (assessment.failureHandling.choice === "unknown") return "uncertain";
  for (const [, observation] of observationsOf(assessment)) {
    if (!isDecisive(observation)) return "uncertain";
  }
  if (assessment.outcomeLevel >= CALLER_VISIBLE_LEVEL) return "attention";
  if (assessment.failureHandling.choice === "swallowed") return "attention";
  if (assessment.boundary.choice === "limit") return "attention";
  return "low";
}

/** Deterministic 0..100 priority: the fixed tables over the returned observations. */
function priorityFor(assessment: JevAssessment): number {
  return clampPriority(
    OUTCOME_PRIORITY[assessment.outcomeLevel] +
      BOUNDARY_PRIORITY[assessment.boundary.choice] +
      FAILURE_PRIORITY[assessment.failureHandling.choice] +
      EVIDENCE_PRIORITY[assessment.evidenceScope.choice],
  );
}

/**
 * Reasons are fixed templates filled with the returned observations and this
 * file's own rubric text. No model-authored text is ever quoted, so a reason can
 * only restate an option name, a number, and a named gate.
 */
function reasonsFor(
  unit: ReviewUnit,
  assessment: JevAssessment,
  status: ReviewStatus,
  carriedNodes: number,
): string[] {
  const { judgment } = assessment;
  const reasons = [
    `observable outcome: ${judgment.outcome} (weight ${Math.round(assessment.outcomeScore * 10) / 10}/3; the reported level holds ${percent(assessment.outcomeReportedShare)} of the accounted distribution)`,
    `boundary observation: ${judgment.boundary}`,
    `failure handling: ${judgment.failureHandling}`,
    `evidence scope: ${judgment.evidenceScope}`,
    `model confidence ${percent(judgment.confidence)} (self-reported by one response; informational, not a ranking gate)`,
  ];
  for (const [label, observation] of observationsOf(assessment)) {
    if (isDecisive(observation)) continue;
    reasons.push(unseparatedAnswerReason(label, observation));
  }
  if (assessment.boundary.choice === "unknown") reasons.push(unknownObservationReason("boundary"));
  if (assessment.failureHandling.choice === "unknown") {
    reasons.push(unknownObservationReason("failureHandling"));
  }
  if (assessment.evidenceScope.choice === "not-established") {
    reasons.push(MISSING_EVIDENCE_REASON);
  }
  const suppliedNodes = unit.contextNodes ?? [];
  if (suppliedNodes.length === 0) {
    reasons.push("no context nodes were supplied, so this judgment used the hunk and its file alone");
  } else if (carriedNodes < suppliedNodes.length) {
    reasons.push(
      `context nodes were trimmed for the state size limit: ${carriedNodes} of ${suppliedNodes.length} definitions were sent, highest priority first and whole, and the rest were dropped rather than shortened, so an absent definition is not a safety claim`,
    );
  } else {
    reasons.push(`context nodes sent whole: ${carriedNodes} definition(s)`);
  }
  reasons.push(ROUTING_REASON[status]);
  return reasons;
}

function judgedItem(
  unit: ReviewUnit,
  state: JevState,
  assessment: JevAssessment,
  mock: boolean,
): ReviewItem {
  const status = statusFor(assessment);
  const reasons = reasonsFor(unit, assessment, status, state.contextNodes?.length ?? 0);
  if (mock) {
    reasons.unshift("mock mode: these values are a deterministic local fixture, not a live Jev judgment");
  }
  return {
    ...unit,
    status,
    priority: priorityFor(assessment),
    reasons,
    judgment: assessment.judgment,
  };
}

function unjudgedItem(
  unit: ReviewUnit,
  reason: string,
  priority: number,
  routing?: ReviewRouting,
): ReviewItem {
  const reasons = [reason, UNJUDGED_NOTE];
  if (routing === undefined) return { ...unit, status: "uncertain", priority, reasons };
  return { ...unit, status: "uncertain", priority, reasons, routing };
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
 * `modelCalls` counts HTTP requests attempted: at most one per judged hunk, and a
 * failed request is still a call. Mock runs make no network calls and report zero.
 * A live run with no usable key throws `JevConfigurationError` before any request
 * when at least one hunk needs the model.
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
      routed.push({
        index,
        item: unjudgedItem(unit, route.reason, MANUAL_REVIEW_PRIORITY, route.routing),
      });
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
        item: judgedItem(
          units[entry.index],
          entry.state,
          mockAssessment(units[entry.index]),
          true,
        ),
      });
    }
  } else if (pending.length > 0) {
    const apiKey = resolveJevApiKey(options);
    if (apiKey === null) throw missingApiKeyError(pending.length);
    const client = new JevClient(apiKey, options.fetch ?? globalThis.fetch);
    warnings.push(SINGLE_SAMPLE_WARNING);
    await forEachConcurrent(pending, MAX_CONCURRENT_REQUESTS, async (entry) => {
      const unit = units[entry.index];
      try {
        const assessment = await client.judge(entry.state);
        routed.push({ index: entry.index, item: judgedItem(unit, entry.state, assessment, false) });
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
