/**
 * Hunk routing and ranking for a diffninja review run.
 *
 * Every input unit comes back as exactly one ReviewItem. A unit is judged by
 * the model only when the deterministic checks cannot settle it:
 *
 *   - a unit the input parser marked special never reaches the model;
 *   - an exact no-op hunk and a blank-only change to a .md/.txt document pass
 *     deterministically;
 *   - a hunk whose essential state (file, hunk, diff, presence counts, and the
 *     context note) exceeds the size cap goes to manual review uncalled, never
 *     truncated and never auto-passed, and reports why through `routing`; optional
 *     context nodes are measured and dropped whole to fit first, so context size
 *     alone never costs a hunk its model call;
 *   - anything else gets exactly one Jev request, and a failed or malformed
 *     response fails closed (uncertain) instead of degrading into a pass;
 *   - an answer that did not separate its own options is recorded as `unknown` by
 *     the adapter and escalates here, because a scattered distribution is no
 *     observation at all;
 *   - an answer of `unknown`, the outcome included, escalates, because the state
 *     did not settle that one answer and a missing observation is not an absence.
 *
 * Priority is computed deterministically from the returned observations, by the
 * fixed tables below: a rerun that returned the same observations would rank the
 * hunk identically. The tables express reading order, not a probability, and
 * model self-reported confidence is never a ranking input.
 *
 * The report order puts the work a model did not settle first, then the judged
 * hunks by numeric priority descending regardless of status — those outside test
 * files before those in test files — and the deterministic passes last; input
 * order breaks ties. Status is a label the reader filters on,
 * so it never reorders what priority and manual review decided.
 */

import {
  JevClient,
  JevRequestError,
  JevResponseError,
  MAX_STATE_CHARS,
  OBSERVATION_PROBABILITY_FLOOR,
  buildJevState,
  missingApiKeyError,
  mockAssessment,
  resolveJevApiKey,
  type AtomicObservation,
  type AtomicQuestion,
  type JevAssessment,
  type JevObservation,
  type JevState,
} from "./jev.js";
import { buildContextState } from "./context-plan.js";
import { testLikeFile } from "./file-role.js";
import type {
  ReviewItem,
  ReviewOptions,
  ReviewRouting,
  ReviewStatus,
  ReviewUnit,
} from "./types.js";

/**
 * Deterministic priority every judged hunk starts from, before its own
 * observations are read: the base of the 0..100 reading order.
 */
export const BASE_PRIORITY = 5;

/**
 * Weight of an outcome the model separated as `changed`. Only `changed`
 * contributes: `unchanged` needs no reading, and `unknown` is a statement about
 * the supplied state rather than about the change, so neither adds weight. The
 * outcome is one unordered Choice, so there is no scale position to convert.
 */
export const CHANGED_OUTCOME_PRIORITY = 10;

/**
 * Deterministic weight of a `yes` per atomic question. Only a `yes` the answer's
 * own vote separated contributes; `no` adds nothing, and `unknown` adds nothing
 * whether the state could not settle it or the vote did not separate it, because
 * a property the state settles as absent and an answer that was not established
 * are both zero reading weight.
 */
export const ATOMIC_PRIORITY = {
  comparisonChanged: 6,
  limitChanged: 15,
  validationChanged: 6,
  failurePropagated: 3,
  failureDeferred: 6,
  failureDiscarded: 15,
} satisfies Record<AtomicQuestion, number>;

/**
 * Weight of one atomic answer: the question's own weight for a separated `yes`,
 * and nothing else. The value passed here is already the normalized answer, so a
 * raw `yes` the vote did not back arrives as `unknown` and earns nothing.
 */
function atomicWeight(
  question: AtomicQuestion,
  observation: JevObservation<AtomicObservation>,
): number {
  return observation.choice === "yes" ? ATOMIC_PRIORITY[question] : 0;
}

/**
 * Human label per answered question, used in the fixed reason templates.
 */
const QUESTION_LABEL = {
  outcome: "outcome",
  comparisonChanged: "comparison",
  limitChanged: "limit",
  validationChanged: "validation",
  failurePropagated: "failure propagation",
  failureDeferred: "failure deferral",
  failureDiscarded: "failure discard",
} satisfies Record<"outcome" | AtomicQuestion, string>;

type AnsweredQuestion = keyof typeof QUESTION_LABEL;

/**
 * Sentence appended for each answer the adapter recorded as `unknown` because no
 * option held a majority. It states the share the answer gave its own reported
 * option and the floor it missed, and says what was recorded instead, without
 * claiming the opposite answer is correct.
 */
function unseparatedAnswerReason(label: AnsweredQuestion, observation: JevObservation<string>): string {
  return (
    `the ${QUESTION_LABEL[label]} answer did not separate its options: the option it reported ` +
    `holds ${percent(observation.reportedShare)} of the accounted distribution, at or under the ` +
    `${percent(OBSERVATION_PROBABILITY_FLOOR)} floor, so it is recorded as unknown`
  );
}

/**
 * Sentence appended when an answer came back `unknown` with a separated vote. The
 * model said the supplied state does not settle this one answer — not that another
 * answer applies — so the answer contributes no reading weight and the hunk needs a
 * human. The sentence names the answer that could not be settled: the atomic
 * properties are independent existence questions rather than one classification,
 * and the outcome is asked on its own.
 */
function unknownAnswerReason(question: AnsweredQuestion): string {
  const unsettled =
    question === "outcome"
      ? "whether these lines change anything a consumer of this code can observe or rely on"
      : "whether these lines do this";
  return (
    `the ${QUESTION_LABEL[question]} answer was unknown: the supplied state does not settle ${unsettled}, ` +
    "so it adds no reading weight and a human has to decide"
  );
}

/** Fixed priorities for hunks that were not judged by a model. */
export const FAILED_CALL_PRIORITY = 80;
export const MANUAL_REVIEW_PRIORITY = 70;
export const TRIVIAL_PRIORITY = 5;

/**
 * Report position of one item: the work no model settled, then the judged hunks
 * outside test files, then the judged hunks in test files, then the deterministic
 * passes. Sorting by this first is what keeps a status label from reordering the
 * report behind the numeric priority.
 *
 * Test files come after the code they exercise because the model's answers do not
 * separate them: a regression test for a fix changes what the suite enforces, so
 * it is honestly `changed` too, and an atomic `yes` in its assertions could outrank
 * the fix itself. Which file is a test is a deterministic path fact, so the order
 * uses it instead of asking the model. A test hunk keeps its own priority and is
 * still ranked by it among the other test hunks; documentation is not demoted.
 */
export const REPORT_PLACEMENT = {
  unjudged: 0,
  judged: 1,
  judgedTest: 2,
  passed: 3,
} satisfies Record<"unjudged" | "judged" | "judgedTest" | "passed", number>;

/** Reason attached to a judged hunk the report reads after the non-test hunks. */
export const TEST_FILE_ORDER_REASON =
  "read after the judged hunks outside test files: the path looks like a test file (a path " +
  "convention, not coverage), and its priority orders it among the other test hunks";

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
  attention:
    "routed to attention: the outcome is changed, a limit changed, or a failure was discarded",
  uncertain:
    "routed to uncertain: an answer did not separate its own options or an answer was unknown, so a human has to decide",
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
 * The seven answered questions, each with its label, in a fixed order. The outcome
 * is included because it is an answer like any other: it is normalized by the same
 * majority rule, so an outcome the vote did not separate reads as `unknown`.
 */
function observationsOf(
  assessment: JevAssessment,
): readonly (readonly [AnsweredQuestion, JevObservation<string>])[] {
  return [
    ["outcome", assessment.outcome],
    ["comparisonChanged", assessment.comparisonChanged],
    ["limitChanged", assessment.limitChanged],
    ["validationChanged", assessment.validationChanged],
    ["failurePropagated", assessment.failurePropagated],
    ["failureDeferred", assessment.failureDeferred],
    ["failureDiscarded", assessment.failureDiscarded],
  ];
}

/**
 * Status from the validated observations. An answer of `unknown` is the escalation
 * and it is the only one: the adapter records `unknown` both for an answer the state
 * could not settle and for an answer whose own distribution did not separate an
 * option, so a scattered or tied answer can never rank as a signal. `unknown` is
 * never read as `no`.
 *
 * Otherwise, only three observations route to attention on their own: an outcome
 * the model separated as `changed` — a change a consumer can observe or rely on —
 * a limit change, and a discarded failure. Everything else is `low`.
 */
function statusFor(assessment: JevAssessment): ReviewStatus {
  for (const [, observation] of observationsOf(assessment)) {
    if (observation.choice === "unknown") return "uncertain";
  }
  if (assessment.outcome.choice === "changed") return "attention";
  if (assessment.limitChanged.choice === "yes") return "attention";
  if (assessment.failureDiscarded.choice === "yes") return "attention";
  return "low";
}

/**
 * Deterministic 0..100 priority: the fixed tables over the returned observations.
 *
 * The base is fixed, a separated `changed` outcome adds its own weight, and the
 * comparison, limit, and validation answers share one contribution as the three
 * failure answers share another: each group contributes the maximum affirmative
 * weight any of its answers carried, never the sum. The properties are independent,
 * so a line that both compares and bounds, or that both retries and then discards,
 * is one reading signal about that line and not several. `unknown` contributes
 * nothing anywhere: it is a fact about the supplied state, never a bonus.
 */
function priorityFor(assessment: JevAssessment): number {
  const boundary = Math.max(
    atomicWeight("comparisonChanged", assessment.comparisonChanged),
    atomicWeight("limitChanged", assessment.limitChanged),
    atomicWeight("validationChanged", assessment.validationChanged),
  );
  const failure = Math.max(
    atomicWeight("failurePropagated", assessment.failurePropagated),
    atomicWeight("failureDeferred", assessment.failureDeferred),
    atomicWeight("failureDiscarded", assessment.failureDiscarded),
  );
  const outcome = assessment.outcome.choice === "changed" ? CHANGED_OUTCOME_PRIORITY : 0;
  return clampPriority(BASE_PRIORITY + outcome + boundary + failure);
}

/**
 * Reasons are fixed templates filled with the returned observations and this
 * file's own rubric text. No model-authored text is ever quoted, so a reason can
 * only restate an option name, a number, and a named gate. Every answer is
 * reported — the outcome included — so a reader sees which individual choices the
 * status rests on instead of a defect probability.
 */
function reasonsFor(
  unit: ReviewUnit,
  assessment: JevAssessment,
  status: ReviewStatus,
  carriedNodes: number,
): string[] {
  const { judgment } = assessment;
  const reasons = [
    `outcome for a consumer: ${judgment.outcome}`,
    `comparison changed: ${judgment.comparisonChanged}`,
    `limit changed: ${judgment.limitChanged}`,
    `validation changed: ${judgment.validationChanged}`,
    `failure propagated: ${judgment.failurePropagated}`,
    `failure deferred: ${judgment.failureDeferred}`,
    `failure discarded: ${judgment.failureDiscarded}`,
    `model confidence ${percent(judgment.confidence)} (self-reported by one response; informational, not a ranking gate)`,
  ];
  // One sentence per answer, and never two: an answer that did not separate its
  // options is already recorded as unknown, so the share explains it and the
  // unknown template would only repeat it.
  for (const [label, observation] of observationsOf(assessment)) {
    if (!observation.separated) reasons.push(unseparatedAnswerReason(label, observation));
    else if (observation.choice === "unknown") reasons.push(unknownAnswerReason(label));
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
  if (testLikeFile(unit.file)) reasons.push(TEST_FILE_ORDER_REASON);
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

/**
 * Where an item belongs in the report. Unjudged work — a hunk no model saw, either
 * because its own size or shape routed it or because its call failed closed — comes
 * first, because nothing ranked it and a person has to; a judged hunk follows, at
 * its numeric priority, judged test-file hunks after the rest; a deterministic
 * pass is last. This reads `judgment`, not
 * `status`: the status label is for filtering, and letting it order the report
 * would put a scattered `uncertain` above a ranked `attention`.
 */
export function placementOf(item: ReviewItem): number {
  if (item.judgment !== undefined) {
    return testLikeFile(item.file) ? REPORT_PLACEMENT.judgedTest : REPORT_PLACEMENT.judged;
  }
  return item.status === "passed" ? REPORT_PLACEMENT.passed : REPORT_PLACEMENT.unjudged;
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
      placementOf(left.item) - placementOf(right.item) ||
      right.item.priority - left.item.priority ||
      left.index - right.index,
  );

  return {
    items: routed.map((entry) => entry.item),
    modelCalls,
    warnings,
  };
}
