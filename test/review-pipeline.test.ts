import { describe, expect, test } from "vitest";
import {
  ATOMIC_OBSERVATIONS,
  ATOMIC_QUESTIONS,
  JEV_API_KEY_ENV,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JevClient,
  JevRequestError,
  MAX_STATE_CHARS,
  OUTCOME_CHOICES,
  buildJevState,
  type AtomicObservation,
  type AtomicQuestion,
  type JevJson,
  type JevObject,
  type JevRequest,
  type OutcomeChoice,
} from "../src/review/jev.js";
import {
  BASE_PRIORITY,
  CHANGED_OUTCOME_PRIORITY,
  MAX_CONCURRENT_REQUESTS,
  MOCK_MODE_WARNING,
  SINGLE_SAMPLE_WARNING,
  TEST_FILE_ORDER_REASON,
  reviewUnits,
} from "../src/review/pipeline.js";
import { MAX_CONTEXT_NODES } from "../src/review/context-plan.js";
import type { ReviewContextNode, ReviewItem, ReviewUnit } from "../src/review/types.js";

const SECRET_BODY = "SERVER-BODY-SECRET-9f2";
const SECRET_ANSWER_TEXT = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
/** Every question the request must carry: the outcome and the six atomic ones. */
const QUESTION_KEYS = ["outcome", ...ATOMIC_QUESTIONS];

interface UnitSpec {
  readonly id: string;
  readonly diff: string;
  readonly file?: string;
  readonly added?: number;
  readonly removed?: number;
  readonly special?: string;
  readonly nodes?: readonly ReviewContextNode[];
}

function makeUnit(spec: UnitSpec): ReviewUnit {
  return {
    id: spec.id,
    file: spec.file ?? "src/app.ts",
    header: "@@ -1,3 +1,5 @@",
    diff: spec.diff,
    added: spec.added ?? 1,
    removed: spec.removed ?? 0,
    oldStart: 1,
    newStart: 1,
    special: spec.special,
    contextNodes: spec.nodes,
  };
}

/** One context node with its whole detail, as the extractor supplies it. */
function contextNode(key: string, detail: string): ReviewContextNode {
  return { key, label: `${key}(arg)`, file: "src/app.ts", line: 1, detail };
}

interface ObservationSpec {
  readonly outcome: OutcomeChoice;
  /** Atomic answers, by question; a question this omits is answered "no". */
  readonly atomic?: Partial<Record<AtomicQuestion, AtomicObservation>>;
  readonly confidence?: number;
  /** Weight on the returned outcome option; under the floor the answer reads as unseparated. */
  readonly outcomeTop?: number;
  /** Weight on each returned choice option; under the floor that answer reads as unseparated. */
  readonly choiceTop?: number;
  /** Exact distributions, when a case needs a shape the knobs above cannot express. */
  readonly outcomeProbabilities?: Readonly<Record<string, number>>;
  readonly atomicProbabilities?: Partial<Record<AtomicQuestion, Readonly<Record<string, number>>>>;
}

/** Weighted-style distribution: the returned option holds `top`, the rest share the remainder. */
function distribution(chosen: string, options: readonly string[], top: number): Record<string, number> {
  const remainder = options.length > 1 ? (1 - top) / (options.length - 1) : 0;
  return Object.fromEntries(options.map((option) => [option, option === chosen ? top : remainder]));
}

/** Mutable wire payload, including deliberately missing or invalid answers. */
interface FixtureAnswers {
  [question: string]: JevJson;
}

/**
 * One documented response body. Every question is a closed Choice, every answer
 * names the peak of its own distribution, and all seven are answered, because a
 * body missing one is malformed rather than an implicit "no".
 */
function answersOf(spec: ObservationSpec): JevObject {
  const confidence = spec.confidence ?? 0.9;
  const choiceTop = spec.choiceTop ?? 0.9;
  const answers: FixtureAnswers = {
    outcome: {
      type: "choice",
      choice: spec.outcome,
      probabilities: spec.outcomeProbabilities
        ?? distribution(spec.outcome, OUTCOME_CHOICES, spec.outcomeTop ?? 0.9),
      confidence,
    },
  };
  for (const question of ATOMIC_QUESTIONS) {
    const answer = spec.atomic?.[question] ?? "no";
    answers[question] = {
      type: "choice",
      choice: answer,
      probabilities: spec.atomicProbabilities?.[question]
        ?? distribution(answer, ATOMIC_OBSERVATIONS, choiceTop),
      confidence,
    };
  }
  return answers;
}

function answerBody(spec: ObservationSpec): string {
  return JSON.stringify({ model: JEV_MODEL, answers: answersOf(spec) });
}

/** The same body with one answer removed, for the strict-parsing cases. */
function bodyWithoutAnswer(spec: ObservationSpec, id: string): string {
  const answers: FixtureAnswers = { ...answersOf(spec) };
  delete answers[id];
  return JSON.stringify({ model: JEV_MODEL, answers });
}

/** The same body with one answer replaced, for the strict-parsing cases. */
function bodyWithAnswer(spec: ObservationSpec, id: string, answer: JevJson): string {
  const answers: FixtureAnswers = { ...answersOf(spec) };
  answers[id] = answer;
  return JSON.stringify({ model: JEV_MODEL, answers });
}

/** Override one atomic answer; the normal fixture supplies "no" for the others. */
function unknownAtomic(question: AtomicQuestion) {
  return { [question]: "unknown" as const };
}

interface FetchLog {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly request: JevRequest;
  readonly body: string;
}

interface FetchHost {
  readonly fetch: typeof globalThis.fetch;
  readonly log: FetchLog[];
}

function installFetch(
  reply: (request: JevRequest, callIndex: number) => Response | Promise<Response>,
): FetchHost {
  const log: FetchLog[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    // SAFETY: the adapter serializes this request; the stub only reads it back.
    const request = JSON.parse(body) as JevRequest;
    log.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      request,
      body,
    });
    return reply(request, log.length - 1);
  };
  return { fetch: fetchImpl, log };
}

function scriptedFetch(script: Readonly<Record<string, ObservationSpec>>): FetchHost {
  return installFetch((request) => {
    const spec = script[request.state.file];
    if (spec === undefined) throw new Error(`no scripted answer for ${request.state.file}`);
    return new Response(answerBody(spec), { status: 200 });
  });
}

function bodyFetch(bodies: Readonly<Record<string, string>>): FetchHost {
  return installFetch((request) => {
    const body = bodies[request.state.file];
    // A missing key would silently answer with an empty body and hide a
    // routing regression behind an unrelated parse error.
    if (body === undefined) throw new Error(`no scripted body for ${request.state.file}`);
    return new Response(body, { status: 200 });
  });
}

function itemById(items: readonly ReviewItem[], id: string): ReviewItem {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

/** Failure notes are the run-level warnings that are not the fixed sample notice. */
function failureWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => warning !== SINGLE_SAMPLE_WARNING && warning !== MOCK_MODE_WARNING);
}

function withMissingApiKeyEnv(): () => void {
  const saved = process.env[JEV_API_KEY_ENV];
  delete process.env[JEV_API_KEY_ENV];
  return () => {
    if (saved === undefined) delete process.env[JEV_API_KEY_ENV];
    else process.env[JEV_API_KEY_ENV] = saved;
  };
}

function stateCharsOf(unit: ReviewUnit): number {
  return JSON.stringify(buildJevState(unit)).length;
}

const CODE_HUNK = "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;";

describe("one request per hunk", () => {
  test("ranks deterministic observations and posts exactly one documented request per hunk", async () => {
    const units = [
      makeUnit({ id: "high", file: "src/high.ts", diff: CODE_HUNK }),
      makeUnit({ id: "clean", file: "src/clean.ts", diff: CODE_HUNK }),
      makeUnit({ id: "mid", file: "src/mid.ts", diff: CODE_HUNK }),
    ];
    const host = scriptedFetch({
      "src/high.ts": {
        outcome: "changed",
        atomic: { limitChanged: "yes", failureDiscarded: "yes" },
      },
      "src/mid.ts": { outcome: "changed" },
      "src/clean.ts": { outcome: "unchanged" },
    });

    const result = await reviewUnits(units, { apiKey: "test-key", fetch: host.fetch });

    // One HTTP attempt per judged hunk: no ensemble, no second round, no retry.
    expect(result.modelCalls).toBe(units.length);
    expect(host.log).toHaveLength(units.length);
    expect(result.warnings).toContain(SINGLE_SAMPLE_WARNING);

    expect(result.items.map((item) => item.id)).toEqual(["high", "mid", "clean"]);
    expect(result.items.map((item) => item.status)).toEqual(["attention", "attention", "low"]);
    // base 5 + changed 10 + max boundary 15 (limit) + max failure 15 (discarded),
    // then base 5 + changed 10, then base 5 alone for an unchanged outcome.
    expect(result.items.map((item) => item.priority)).toEqual([45, 15, 5]);

    expect(host.log[0].url).toBe(JEV_ENDPOINT);
    expect(host.log[0].method).toBe("POST");
    expect(host.log[0].authorization).toBe("Bearer test-key");
    const request = host.log[0].request;
    expect(request.model).toBe(JEV_MODEL);
    expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
    // Exactly the seven questions: the outcome and the six atomic properties.
    // No score question and no outcome-context question survive the redesign.
    expect(Object.keys(request.questions)).toEqual(QUESTION_KEYS);
    expect(Object.keys(request.questions).sort()).toEqual([...QUESTION_KEYS].sort());
    // The outcome is one unordered Choice and every atomic question is a closed
    // Choice whose option set is the constant the adapter validates against.
    expect(request.questions.outcome.type).toBe("choice");
    expect(Object.keys(request.questions.outcome.criteria)).toEqual([...OUTCOME_CHOICES]);
    for (const question of ATOMIC_QUESTIONS) {
      const atomic = request.questions[question];
      expect(atomic.type).toBe("choice");
      expect(Object.keys(atomic.criteria)).toEqual([...ATOMIC_OBSERVATIONS]);
      expect(atomic.instructions.length).toBeGreaterThan(0);
      // Each atomic question names the one place it may be answered from.
      expect(atomic.instructions).toContain("`diff`");
      // Independent existence questions: every one says so, so no question invites
      // the model to treat a yes elsewhere as a reason to answer unknown here.
      expect(atomic.instructions).toMatch(/independent|no reason to answer unknown/u);
    }
    // State is exactly what the questions refer to, plus the presence counts the
    // extractor established, with no answer field the adapter already knows.
    expect(Object.keys(request.state).sort()).toEqual([
      "contextNote",
      "contextPresence",
      "diff",
      "file",
      "hunk",
    ]);
    // A hunk that supplied no node carries zero counts, not an absent field.
    expect(request.state.contextPresence).toEqual({
      before: { changedDefinitions: 0, callerDefinitions: 0, calleeDefinitions: 0, contracts: 0 },
      after: { changedDefinitions: 0, callerDefinitions: 0, calleeDefinitions: 0, contracts: 0 },
      unclassifiedNodes: 0,
    });

    const high = itemById(result.items, "high");
    // Every one of the seven answers is recorded as returned.
    expect(high.judgment).toEqual({
      outcome: "changed",
      comparisonChanged: "no",
      limitChanged: "yes",
      validationChanged: "no",
      failurePropagated: "no",
      failureDeferred: "no",
      failureDiscarded: "yes",
      confidence: 0.9,
    });
    const reasons = high.reasons.join(" | ");
    expect(reasons).toMatch(/outcome for a consumer: changed/u);
    expect(reasons).toMatch(/limit changed: yes/u);
    expect(reasons).toMatch(/failure discarded: yes/u);
    expect(reasons).toMatch(/comparison changed: no/u);
    expect(reasons).toMatch(/routed to attention/u);
    // The key travels in the Authorization header only, never in the body.
    for (const entry of host.log) {
      expect(entry.authorization).toBe("Bearer test-key");
      expect(entry.body).not.toContain("test-key");
    }
  });

  test("sends the same request body for the same hunk, so no answer drives a random order", async () => {
    const unit = makeUnit({ id: "hunk", file: "src/a.ts", diff: CODE_HUNK });
    const first = scriptedFetch({ "src/a.ts": { outcome: "changed" } });
    const second = scriptedFetch({ "src/a.ts": { outcome: "changed" } });

    await reviewUnits([unit], { apiKey: "k", fetch: first.fetch });
    await reviewUnits([unit], { apiKey: "k", fetch: second.fetch });

    expect(first.log).toHaveLength(1);
    expect(second.log).toHaveLength(1);
    expect(second.log[0].body).toBe(first.log[0].body);
    // The question criteria are in one canonical order on every request.
    expect(second.log[0].authorization).toBe(first.log[0].authorization);
  });

  test("keeps the input units untouched and reports one item per unit", async () => {
    const units = [
      makeUnit({ id: "judged", file: "src/a.ts", diff: CODE_HUNK }),
      makeUnit({ id: "trivial", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
    ];
    const snapshot = structuredClone(units);
    const host = scriptedFetch({ "src/a.ts": { outcome: "unchanged" } });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id).sort()).toEqual(["judged", "trivial"]);
    const trivial = itemById(result.items, "trivial");
    expect(trivial.status).toBe("passed");
    expect(trivial.reasons.join("\n")).toMatch(/exact no-op/);
    const judged = itemById(result.items, "judged");
    expect(judged.judgment?.outcome).toBe("unchanged");
    expect(judged.reasons.join("\n")).toMatch(/routed to low/);
    expect(units).toEqual(snapshot);
    expect(host.log).toHaveLength(1);
  });
});

describe("deterministic status and priority", () => {
  test.each([
    { outcome: "unchanged", status: "low", priority: BASE_PRIORITY },
    { outcome: "changed", status: "attention", priority: BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY },
    { outcome: "unknown", status: "uncertain", priority: BASE_PRIORITY },
  ] as const)("routes outcome $outcome to $status with priority $priority", async (row) => {
    const host = scriptedFetch({ "src/a.ts": { outcome: row.outcome } });
    const result = await reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });
    expect(result.items[0].status).toBe(row.status);
    expect(result.items[0].priority).toBe(row.priority);
  });

  test("raises priority for a limit change or a discarded failure without inventing a new status", async () => {
    const host = scriptedFetch({
      "src/limit.ts": { outcome: "unchanged", atomic: { limitChanged: "yes" } },
      "src/discarded.ts": { outcome: "unchanged", atomic: { failureDiscarded: "yes" } },
      "src/plain.ts": { outcome: "unchanged" },
    });
    const result = await reviewUnits([
      makeUnit({ id: "limit", file: "src/limit.ts", diff: CODE_HUNK }),
      makeUnit({ id: "discarded", file: "src/discarded.ts", diff: CODE_HUNK }),
      makeUnit({ id: "plain", file: "src/plain.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "limit").status).toBe("attention");
    expect(itemById(result.items, "discarded").status).toBe("attention");
    expect(itemById(result.items, "plain").status).toBe("low");
    expect(itemById(result.items, "limit").priority).toBe(BASE_PRIORITY + 15);
    expect(itemById(result.items, "discarded").priority).toBe(BASE_PRIORITY + 15);
    expect(itemById(result.items, "plain").priority).toBe(BASE_PRIORITY);
  });

  test("escalates an outcome the vote did not separate, without claiming a defect", async () => {
    const host = scriptedFetch({
      "src/settled.ts": { outcome: "unchanged" },
      "src/split.ts": { outcome: "changed", outcomeProbabilities: { changed: 0.4, unchanged: 0.35, unknown: 0.25 } },
      "src/unclear.ts": { outcome: "unknown" },
    });
    const result = await reviewUnits([
      makeUnit({ id: "settled", file: "src/settled.ts", diff: CODE_HUNK }),
      makeUnit({ id: "split", file: "src/split.ts", diff: CODE_HUNK }),
      makeUnit({ id: "unclear", file: "src/unclear.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    const settled = itemById(result.items, "settled");
    // An outcome the answer separated leaves the reading as it was.
    expect(settled.status).toBe("low");
    expect(settled.priority).toBe(BASE_PRIORITY);
    expect(settled.judgment?.outcome).toBe("unchanged");

    for (const id of ["split", "unclear"]) {
      const item = itemById(result.items, id);
      // An outcome this run cannot separate is unresolved, and it adds no weight:
      // missing evidence is not a bonus and not a defect claim.
      expect(item.status).toBe("uncertain");
      expect(item.priority).toBe(BASE_PRIORITY);
      expect(item.judgment?.outcome).toBe("unknown");
      expect(item.reasons.join(" ")).not.toMatch(/defect in the change|is a defect/u);
    }
    // Only the split answer was named above the floor, and the raw share is
    // retained beside the normalized answer: the record still says what the
    // response gave the option it named before the answer became unknown.
    const splitReasons = itemById(result.items, "split").reasons.join(" ");
    expect(splitReasons).toContain("outcome answer did not separate its options");
    expect(splitReasons).toContain("40%");
    expect(splitReasons).toContain("recorded as unknown");
    // The answer that was simply unknown says so, and says it adds no weight.
    const unclearReasons = itemById(result.items, "unclear").reasons.join(" ");
    expect(unclearReasons).toContain("the outcome answer was unknown");
    expect(unclearReasons).toMatch(/adds no reading weight/u);
  });

  test.each(ATOMIC_QUESTIONS)(
    "escalates an unknown %s answer instead of reading it as an absence",
    async (question) => {
      const atomic = unknownAtomic(question);
      const host = scriptedFetch({ "src/unclear.ts": { outcome: "changed", atomic } });
      const result = await reviewUnits([makeUnit({ id: "unclear", file: "src/unclear.ts", diff: CODE_HUNK })], {
        apiKey: "k", fetch: host.fetch,
      });

      const item = result.items[0];
      // Unknown is an escalation with no reading weight: the hunk is not ranked as
      // attention and not ranked as a clean low, so it cannot be read as "these
      // lines do not do this".
      expect(item.status).toBe("uncertain");
      expect(item.priority).toBe(BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY);
      // Only the question that could not be settled is unknown; the other
      // properties keep the answers the response gave them.
      expect(item.judgment).toMatchObject(atomic);
      expect(item.reasons.join(" ")).toContain("was unknown");
      expect(item.reasons.join(" ")).toMatch(/adds no reading weight/u);
    },
  );

  test("escalates an exact tie instead of ranking the option the list order happens to name first", async () => {
    // Two options share the top weight. No option was voted for, so the option the
    // canonical order names must not be read as a separated answer.
    const host = scriptedFetch({
      "src/tie.ts": { outcome: "changed", outcomeProbabilities: { changed: 0.5, unchanged: 0.5 } },
      // One vote above the floor still decides.
      "src/decided.ts": { outcome: "changed", outcomeProbabilities: { changed: 0.6, unchanged: 0.4 } },
    });
    const result = await reviewUnits([
      makeUnit({ id: "tie", file: "src/tie.ts", diff: CODE_HUNK }),
      makeUnit({ id: "decided", file: "src/decided.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    const tie = itemById(result.items, "tie");
    expect(tie.status).toBe("uncertain");
    // The named option is not recorded as the answer: the tie is recorded as
    // unknown, so a tied vote can never read as a supported finding.
    expect(tie.judgment?.outcome).toBe("unknown");
    expect(tie.reasons.some((reason) => reason.includes("did not separate its options"))).toBe(true);

    const decided = itemById(result.items, "decided");
    expect(decided.status).toBe("attention");
    expect(decided.judgment?.outcome).toBe("changed");
    expect(decided.reasons.join(" ")).not.toContain("did not separate its options");
  });

  test("escalates a tie that only the sum tolerance makes exceed a half", async () => {
    // 0.505/0.505 is accepted by the distribution sum tolerance, so the raw peak
    // is above 0.5. Normalizing by the accounted total shows the even split it is.
    const host = scriptedFetch({
      "src/tolerance-tie.ts": {
        outcome: "changed",
        outcomeProbabilities: { changed: 0.505, unchanged: 0.505 },
      },
    });
    const result = await reviewUnits([makeUnit({ id: "tol-tie", file: "src/tolerance-tie.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].judgment?.outcome).toBe("unknown");
    expect(result.items[0].reasons.some((reason) => reason.includes("did not separate its options"))).toBe(true);
  });

  test("escalates a plurality that most of the vote did not back", async () => {
    // The reported option is the plurality of the outcome vote but no option holds
    // a majority of it: the answer was not separated, so this run does not rank it.
    const host = scriptedFetch({
      "src/plurality.ts": {
        outcome: "changed",
        outcomeProbabilities: { changed: 0.45, unchanged: 0.35, unknown: 0.2 },
      },
    });
    const result = await reviewUnits([makeUnit({ id: "plurality", file: "src/plurality.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    const item = result.items[0];
    // `changed` holds the plurality, so it is the option reported — and the answer
    // is still recorded as unknown, because a plurality is not a majority.
    expect(item.judgment?.outcome).toBe("unknown");
    expect(item.status).toBe("uncertain");
    expect(item.reasons.some((reason) => reason.includes("did not separate its options"))).toBe(true);
  });

  test("escalates an exact tie on an atomic answer too", async () => {
    const host = scriptedFetch({
      "src/atomic-tie.ts": {
        outcome: "changed",
        atomic: { comparisonChanged: "yes" },
        atomicProbabilities: { comparisonChanged: { yes: 0.5, no: 0.5 } },
      },
    });
    const result = await reviewUnits([makeUnit({ id: "atomic-tie", file: "src/atomic-tie.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    const item = result.items[0];
    // A tied answer cannot be read as "these lines do change a comparison" or as
    // "they do not": neither side was voted for, so it is recorded as unknown and
    // adds nothing to the rank.
    expect(item.status).toBe("uncertain");
    expect(item.judgment?.comparisonChanged).toBe("unknown");
    expect(item.priority).toBe(BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY);
    expect(item.reasons.some((reason) => reason.includes("comparison answer did not separate its options"))).toBe(true);
  });

  test("escalates an answer named within float slack of its rival, where the maximum is not the reported option", async () => {
    // The winner identity is checked with float slack, so naming `yes` beside a
    // marginally larger `no` is accepted. The maximum crosses 0.5 while the
    // reported option does not, so the reported option's own share decides.
    const host = scriptedFetch({
      "src/slack-tie.ts": {
        outcome: "unchanged",
        atomic: { comparisonChanged: "yes" },
        atomicProbabilities: { comparisonChanged: { yes: 0.4999997, no: 0.5000003 } },
      },
    });
    const result = await reviewUnits([makeUnit({ id: "slack", file: "src/slack-tie.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    const item = result.items[0];
    expect(item.judgment?.comparisonChanged).toBe("unknown");
    expect(item.status).toBe("uncertain");
    expect(item.reasons.some((reason) => reason.includes("comparison answer did not separate its options"))).toBe(true);
  });

  test("does not rank on vendor confidence", async () => {
    const host = scriptedFetch({
      "src/low.ts": { outcome: "unchanged", confidence: 0.1 },
      "src/high.ts": { outcome: "unchanged", confidence: 1 },
    });
    const result = await reviewUnits([
      makeUnit({ id: "low", file: "src/low.ts", diff: CODE_HUNK }),
      makeUnit({ id: "high", file: "src/high.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "low").priority).toBe(itemById(result.items, "high").priority);
    expect(itemById(result.items, "low").status).toBe("low");
    // Confidence is reported as the returned lowest value, and is not a gate.
    expect(itemById(result.items, "low").judgment?.confidence).toBeCloseTo(0.1);
    expect(itemById(result.items, "low").reasons.join(" ")).toMatch(/informational, not a ranking gate/u);
  });

  test("records every answer that did not separate its options as unknown, keeping the raw share", async () => {
    // 0.4 against two options sharing 0.3 keeps the named option the peak while
    // staying under the floor: every answer here is scattered, not tied.
    const host = scriptedFetch({
      "src/flat.ts": {
        outcome: "changed",
        outcomeTop: 0.4,
        atomic: { failureDiscarded: "yes" },
        choiceTop: 0.4,
      },
    });
    const result = await reviewUnits([makeUnit({ id: "flat", file: "src/flat.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    const item = result.items[0];
    expect(item.status).toBe("uncertain");
    // No raw yes survives into the judgment: an answer the vote did not separate is
    // unknown, so it is never reported as a supported property, and neither is the
    // outcome the same fixture named changed.
    expect(item.judgment?.outcome).toBe("unknown");
    expect(item.judgment?.failureDiscarded).toBe("unknown");
    // Unknown earns nothing: no changed weight, and no bonus for the missing
    // evidence either.
    expect(item.priority).toBe(BASE_PRIORITY);
    // The unseparated answer is reported once per affected question: this fixture
    // scatters all seven answers, and each one explains itself with its own share.
    const reported = item.reasons.filter((reason) => reason.includes("did not separate its options"));
    expect(reported).toHaveLength(QUESTION_KEYS.length);
    expect(reported.join(" ")).toContain("failure discard answer did not separate its options");
    expect(reported.join(" ")).toContain("outcome answer did not separate its options");
    expect(reported.every((reason) => reason.includes("so it is recorded as unknown"))).toBe(true);
    // A scattered answer is explained by its share once, never also as a plain
    // unknown, because the two templates would say the same thing twice. The
    // routing sentence is not one of those per-answer sentences.
    expect(
      item.reasons.filter((reason) => reason.includes("answer was unknown") && !reason.startsWith("routed to")),
    ).toHaveLength(0);
  });

  test("bounds the rank by its fixed parts, with no bonus for an unknown answer", async () => {
    // The largest rank a judgment can reach is the base plus the changed outcome
    // plus the heaviest boundary answer plus the heaviest failure answer. Nothing
    // else adds weight: no unknown bonus, and no unseparated answer leaks in.
    const host = scriptedFetch({
      "src/top.ts": {
        outcome: "changed",
        atomic: { limitChanged: "yes", failureDiscarded: "yes" },
      },
      "src/bottom.ts": {
        outcome: "unknown",
        atomic: { limitChanged: "unknown", failureDiscarded: "unknown" },
      },
      "src/middle.ts": {
        outcome: "unchanged",
        atomic: { comparisonChanged: "yes", failureDiscarded: "yes" },
      },
    });
    const result = await reviewUnits([
      makeUnit({ id: "top", file: "src/top.ts", diff: CODE_HUNK }),
      makeUnit({ id: "bottom", file: "src/bottom.ts", diff: CODE_HUNK }),
      makeUnit({ id: "middle", file: "src/middle.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    const top = itemById(result.items, "top");
    expect(top.priority).toBe(
      BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY + 15 + 15,
    );
    expect(top.status).toBe("attention");
    // Unknown answers sit at the floor: the outcome adds nothing, and an unknown
    // atomic answer adds nothing, so uncertainty is never rewarded.
    expect(itemById(result.items, "bottom").priority).toBe(BASE_PRIORITY);
    // An unchanged outcome still ranks on what its atomic answers found.
    expect(itemById(result.items, "middle").priority).toBe(BASE_PRIORITY + 6 + 15);
    for (const item of result.items) {
      expect(item.priority).toBeGreaterThanOrEqual(BASE_PRIORITY);
      expect(item.priority).toBeLessThanOrEqual(BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY + 15 + 15);
    }
  });
});

describe("report order", () => {
  test("puts unjudged work first, then judged hunks by priority, and passes last", async () => {
    // Input order deliberately disagrees with every part of the contract: a passed
    // hunk first, the judged hunks interleaved, and the two unjudged shapes last.
    const units = [
      makeUnit({ id: "no-op", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
      makeUnit({ id: "attention", file: "src/attention.ts", diff: CODE_HUNK }),
      makeUnit({ id: "binary", file: "assets/logo.png", diff: "Binary files differ", special: "binary" }),
      makeUnit({ id: "unknown", file: "src/unknown.ts", diff: CODE_HUNK }),
      makeUnit({ id: "failed", file: "src/failed.ts", diff: CODE_HUNK }),
      makeUnit({ id: "strong", file: "src/strong.ts", diff: CODE_HUNK }),
    ];
    const host = installFetch((request) => {
      if (request.state.file === "src/failed.ts") return new Response(SECRET_BODY, { status: 500 });
      const spec =
        request.state.file === "src/strong.ts"
          ? { outcome: "changed" as const, atomic: { limitChanged: "yes" as const } }
          : { outcome: request.state.file === "src/attention.ts" ? ("changed" as const) : ("unknown" as const) };
      return new Response(answerBody(spec), { status: 200 });
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    // Unjudged work comes first because nothing ranked it and a person must read
    // it, highest priority first inside that group: the failed call above the
    // oversized/special unit. Judged hunks follow by numeric priority, whatever
    // their status: an uncertain hunk at the base rank sits behind attention. The
    // deterministic pass is last, and input order breaks the remaining ties.
    expect(result.items.map((item) => item.id)).toEqual([
      "failed",
      "binary",
      "strong",
      "attention",
      "unknown",
      "no-op",
    ]);
    expect(result.items.map((item) => item.status)).toEqual([
      "uncertain",
      "uncertain",
      "attention",
      "attention",
      "uncertain",
      "passed",
    ]);
    // A status-first sort would have put the attention hunks above the failed call
    // and the manual unit; that is exactly what this order refuses to do.
    expect(result.items.findIndex((item) => item.id === "failed")).toBeLessThan(
      result.items.findIndex((item) => item.status === "attention"),
    );
  });

  test("reads judged test-file hunks after the code they exercise, keeping their priority", async () => {
    // The shape of a real fix PR: the fix and its docs are `changed`, and so is the
    // type test, whose assertions also read as a validation change. By priority
    // alone the type test (21) would outrank the fix (15) it only exercises.
    const units = [
      makeUnit({ id: "type-test", file: "index.test-d.ts", diff: CODE_HUNK }),
      makeUnit({ id: "suite", file: "test.js", diff: CODE_HUNK }),
      makeUnit({ id: "fix", file: "index.js", diff: CODE_HUNK }),
      makeUnit({ id: "readme", file: "readme.md", diff: CODE_HUNK }),
    ];
    const host = scriptedFetch({
      "index.test-d.ts": { outcome: "changed", atomic: { validationChanged: "yes" } },
      "test.js": { outcome: "unchanged", atomic: { failureDeferred: "yes" } },
      "index.js": { outcome: "changed" },
      "readme.md": { outcome: "changed" },
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    // Documentation is not demoted: prose can be normative, so it ranks by its own
    // answers beside the fix. The test hunks follow, ordered among themselves.
    expect(result.items.map((item) => item.id)).toEqual(["fix", "readme", "type-test", "suite"]);
    expect(result.items.map((item) => item.priority)).toEqual([15, 15, 21, 11]);
    for (const id of ["type-test", "suite"]) {
      expect(itemById(result.items, id).reasons).toContain(TEST_FILE_ORDER_REASON);
    }
    for (const id of ["fix", "readme"]) {
      expect(itemById(result.items, id).reasons).not.toContain(TEST_FILE_ORDER_REASON);
    }
  });

  test("never lets a test-file hunk move ahead of unjudged work", async () => {
    const units = [
      makeUnit({ id: "test", file: "test/a.test.ts", diff: CODE_HUNK }),
      makeUnit({ id: "failed", file: "src/failed.ts", diff: CODE_HUNK }),
    ];
    const host = installFetch((request) =>
      request.state.file === "src/failed.ts"
        ? new Response(SECRET_BODY, { status: 500 })
        : new Response(answerBody({ outcome: "changed", atomic: { limitChanged: "yes" } }), { status: 200 }));

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(result.items.map((item) => item.id)).toEqual(["failed", "test"]);
  });
});

describe("independent atomic properties", () => {
  test("records several yes answers at once and counts each group once, never as a sum", async () => {
    const host = scriptedFetch({
      "src/overlap.ts": {
        outcome: "changed",
        atomic: {
          comparisonChanged: "yes",
          limitChanged: "yes",
          validationChanged: "yes",
          failureDeferred: "yes",
          failureDiscarded: "yes",
        },
      },
    });
    const result = await reviewUnits([makeUnit({ id: "overlap", file: "src/overlap.ts", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    const item = result.items[0];
    // Properties are independent existence questions, so a yes to one is never
    // rewritten as unknown or no by another, and all of them are recorded.
    expect(item.judgment).toMatchObject({
      outcome: "changed",
      comparisonChanged: "yes",
      limitChanged: "yes",
      validationChanged: "yes",
      failurePropagated: "no",
      failureDeferred: "yes",
      failureDiscarded: "yes",
    });
    // base 5 + changed 10 + max(6, 15, 6) + max(0, 6, 15) = 45: the overlapping
    // boundary properties are one reading signal about the line, not their sum,
    // and the failure ones likewise. Summing them would report 63.
    expect(item.priority).toBe(BASE_PRIORITY + CHANGED_OUTCOME_PRIORITY + 15 + 15);
    expect(item.status).toBe("attention");
  });

  test("keeps each property's own weight, so a rare yes is not read as a strong one", async () => {
    const host = scriptedFetch({
      "src/compare.ts": { outcome: "unchanged", atomic: { comparisonChanged: "yes" } },
      "src/propagate.ts": { outcome: "unchanged", atomic: { failurePropagated: "yes" } },
    });
    const result = await reviewUnits([
      makeUnit({ id: "compare", file: "src/compare.ts", diff: CODE_HUNK }),
      makeUnit({ id: "propagate", file: "src/propagate.ts", diff: CODE_HUNK }),
    ], { apiKey: "k", fetch: host.fetch });

    // comparison 6 and propagation 3 are different weights, and neither answer
    // routes to attention on its own.
    expect(itemById(result.items, "compare").priority).toBe(BASE_PRIORITY + 6);
    expect(itemById(result.items, "propagate").priority).toBe(BASE_PRIORITY + 3);
    for (const id of ["compare", "propagate"]) {
      expect(itemById(result.items, id).status).toBe("low");
    }
  });
});

describe("deterministic passes", () => {
  test("increment and decrement code is never mistaken for patch file headers", async () => {
    const host = installFetch(() => new Response(answerBody({ outcome: "unchanged" })));
    const result = await reviewUnits([
      makeUnit({ id: "operators", diff: "@@ -1 +1 @@\n---counter;\n+++counter;", added: 1, removed: 1 }),
    ], { apiKey: "test-key", fetch: host.fetch });
    expect(result.items[0].status).toBe("low");
    expect(result.modelCalls).toBe(1);
  });

  test("passes exact no-ops and blank-only text documents, and judges everything else", async () => {
    const units = [
      makeUnit({ id: "no-op", file: "src/app.ts", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
      makeUnit({ id: "blank-md", file: "docs/notes.md", diff: "@@ -1 +1,3 @@\n+ \n+  ", added: 2 }),
      makeUnit({ id: "blank-ts", file: "src/blank.ts", diff: "@@ -1 +1,3 @@\n+ \n+  ", added: 2 }),
      makeUnit({ id: "comment", file: "src/comment.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = scriptedFetch({
      "src/blank.ts": { outcome: "unchanged" },
      "src/comment.ts": { outcome: "unchanged" },
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "no-op").status).toBe("passed");
    expect(itemById(result.items, "blank-md").status).toBe("passed");
    expect(itemById(result.items, "blank-md").judgment).toBeUndefined();
    expect(itemById(result.items, "blank-ts").status).toBe("low");
    expect(itemById(result.items, "comment").status).toBe("low");
    expect(host.log.map((entry) => entry.request.state.file).sort()).toEqual([
      "src/blank.ts",
      "src/comment.ts",
    ]);
    expect(result.modelCalls).toBe(2);
  });
});

describe("manual-review fallbacks", () => {
  test("sends special units and oversized states to manual review without a call", async () => {
    const huge = `@@ -1 +1 @@\n+${"x".repeat(MAX_STATE_CHARS + 500)}`;
    const units = [
      makeUnit({ id: "binary", file: "assets/logo.png", diff: "Binary files differ", special: "binary" }),
      makeUnit({ id: "meta", file: "package-lock.json", diff: "similarity index 98%", special: "metadata" }),
      makeUnit({ id: "huge", file: "src/huge.ts", diff: huge, added: 1 }),
    ];
    const host = installFetch(() => {
      throw new Error("the model must not be called for these hunks");
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(host.log).toHaveLength(0);
    expect(result.modelCalls).toBe(0);
    for (const id of ["binary", "meta", "huge"]) {
      const item = itemById(result.items, id);
      expect(item.status).toBe("uncertain");
      expect(item.judgment).toBeUndefined();
    }
  });
});

/** A hunk whose essential state is exactly `chars` characters, or a thrown error. */
function unitAtEssentialChars(chars: number): ReviewUnit {
  const file = "src/boundary.ts";
  const probe = stateCharsOf(makeUnit({ id: "boundary", file, diff: `${CODE_HUNK}\n+` }));
  const unit = makeUnit({ id: "boundary", file, diff: `${CODE_HUNK}\n+${"x".repeat(chars - probe)}` });
  const actual = stateCharsOf(unit);
  if (actual !== chars) throw new Error(`fixture is ${actual} serialized characters, not ${chars}`);
  return unit;
}

describe("serialized state budget", () => {
  test("drops a node that cannot fit whole and still judges the hunk", async () => {
    const detail = "d".repeat(9_000);
    const nodes = [contextNode("after:a", detail), contextNode("after:b", detail), contextNode("after:c", detail)];
    const unit = makeUnit({ id: "nodes", file: "src/nodes.ts", diff: CODE_HUNK, nodes });
    const host = scriptedFetch({ "src/nodes.ts": { outcome: "changed" } });

    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });

    expect(host.log).toHaveLength(1);
    const state = host.log[0].request.state;
    const sent = state.contextNodes ?? [];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(nodes.length);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    // Whole nodes in the supplied priority order, never reordered or shortened.
    expect(sent.map((node) => node.key)).toEqual(nodes.slice(0, sent.length).map((node) => node.key));
    for (const node of sent) {
      expect(node.detail).toBe(nodes.find((supplied) => supplied.key === node.key)?.detail);
    }

    const item = result.items[0];
    expect(item.routing).toBeUndefined();
    expect(item.judgment?.outcome).toBe("changed");
    // The item still carries every node the extraction side supplied, for the report.
    expect(item.contextNodes).toEqual(nodes);
    expect(item.reasons.join(" ")).toContain(`${sent.length} of ${nodes.length} definitions were sent`);
  });

  test("carries at most the node limit", async () => {
    const nodes = Array.from({ length: MAX_CONTEXT_NODES + 2 }, (_value, index) =>
      contextNode(`after:n${index}`, "d".repeat(10)));
    const unit = makeUnit({ id: "many", file: "src/many.ts", diff: CODE_HUNK, nodes });
    const host = scriptedFetch({ "src/many.ts": { outcome: "changed" } });

    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });

    // The cap bounds what reaches the model, and the item keeps every node the
    // extraction side supplied for the report.
    expect(host.log[0].request.state.contextNodes).toHaveLength(MAX_CONTEXT_NODES);
    expect(result.items[0].contextNodes).toHaveLength(nodes.length);
  });

  test("caps on the serialized JSON, so escaping counts, at an exact boundary", async () => {
    const host = installFetch(() => new Response(answerBody({ outcome: "changed" })));

    const atCap = unitAtEssentialChars(MAX_STATE_CHARS);
    const inside = await reviewUnits([atCap], { apiKey: "k", fetch: host.fetch });
    expect(host.log).toHaveLength(1);
    expect(JSON.stringify(host.log[0].request.state)).toHaveLength(MAX_STATE_CHARS);
    expect(inside.items[0].judgment).toBeDefined();
    expect(inside.items[0].routing).toBeUndefined();

    const overCap = unitAtEssentialChars(MAX_STATE_CHARS + 1);
    const beyond = await reviewUnits([overCap], { apiKey: "k", fetch: host.fetch });
    // The cap reads the state the model would receive, which carries the note.
    const measured = stateCharsOf(overCap);
    expect(measured).toBe(MAX_STATE_CHARS + 1);
    expect(beyond.modelCalls).toBe(0);
    expect(beyond.items[0].judgment).toBeUndefined();
    expect(beyond.items[0].routing).toEqual({
      evaluation: "not_evaluated",
      reasonCode: "context_limit_exceeded",
      requiredChars: measured,
      limitChars: MAX_STATE_CHARS,
    });

    // Same raw diff length as the hunk that does not fit, but its tail is quotes:
    // escaped in the JSON the model would receive, so it is over the cap by more.
    const quotes = makeUnit({
      id: "boundary",
      file: "src/boundary.ts",
      diff: overCap.diff.replaceAll("x", '"'),
    });
    expect(quotes.diff).toHaveLength(overCap.diff.length);
    expect(quotes.diff.length).toBeLessThan(stateCharsOf(quotes));
    expect(stateCharsOf(quotes)).toBeGreaterThan(MAX_STATE_CHARS);

    const rejected = await reviewUnits([quotes], { apiKey: "k", fetch: host.fetch });
    expect(rejected.items[0].routing?.requiredChars).toBe(stateCharsOf(quotes));
  });

  test("measures an essential overflow with every optional node left out", async () => {
    const withoutNodes = unitAtEssentialChars(MAX_STATE_CHARS + 2_000);
    const withNodes = makeUnit({
      id: "boundary",
      file: "src/boundary.ts",
      diff: withoutNodes.diff,
      nodes: Array.from({ length: 4 }, (_value, index) => contextNode(`after:n${index}`, "d".repeat(9_000))),
    });
    const host = installFetch(() => {
      throw new Error("the model must not be called for this hunk");
    });

    const result = await reviewUnits([withNodes], { apiKey: "k", fetch: host.fetch });

    expect(host.log).toHaveLength(0);
    // Every optional node is left out before the state is measured, so neither the
    // extra context nor the longer note inflates the reported size.
    expect(stateCharsOf(withNodes)).toBe(stateCharsOf(withoutNodes));
    expect(result.items[0].routing).toEqual({
      evaluation: "not_evaluated",
      reasonCode: "context_limit_exceeded",
      requiredChars: stateCharsOf(withoutNodes),
      limitChars: MAX_STATE_CHARS,
    });
    expect(result.items[0].reasons.join(" ")).toMatch(/every optional context node was left out/u);
  });

  test("sends an essential overflow to exactly one human item, with no key and no model fields", async () => {
    const restore = withMissingApiKeyEnv();
    try {
      const oversized = unitAtEssentialChars(MAX_STATE_CHARS + 1);
      const binary = makeUnit({
        id: "binary",
        file: "assets/logo.png",
        diff: "Binary files differ",
        special: "binary",
      });
      const host = installFetch(() => {
        throw new Error("neither hunk may reach the model");
      });

      // No apiKey and no environment key: nothing here needs the model at all.
      const result = await reviewUnits([binary, oversized], { fetch: host.fetch });

      expect(host.log).toHaveLength(0);
      expect(result.modelCalls).toBe(0);
      expect(result.items).toHaveLength(2);
      const routed = result.items.filter((item) => item.routing !== undefined);
      expect(routed).toHaveLength(1);
      expect(routed[0].id).toBe("boundary");
      expect(itemById(result.items, "binary").routing).toBeUndefined();

      const item = routed[0];
      expect(item.status).toBe("uncertain");
      // Not evaluated means no judgment at all: nothing is invented for a hunk the
      // model never saw, and no confidence or observation field appears.
      expect(Object.hasOwn(item, "judgment")).toBe(false);
      expect(JSON.stringify(item)).not.toMatch(/"judgment"|"confidence"|"outcome"/u);
      expect(item.routing?.requiredChars).toBe(stateCharsOf(oversized));
      expect(item.reasons.join(" ")).toContain(String(MAX_STATE_CHARS));
    } finally {
      restore();
    }
  });
});

describe("failing closed", () => {
  test("fails closed per hunk on HTTP errors, with one attempt each and no body echo", async () => {
    const units = [
      makeUnit({ id: "server-error", file: "src/server.ts", diff: CODE_HUNK }),
      makeUnit({ id: "unauthorized", file: "src/auth.ts", diff: CODE_HUNK }),
      makeUnit({ id: "network", file: "src/net.ts", diff: CODE_HUNK }),
    ];
    const host = installFetch((request) => {
      if (request.state.file === "src/server.ts") return new Response(SECRET_BODY, { status: 500 });
      if (request.state.file === "src/auth.ts") return new Response(SECRET_BODY, { status: 401 });
      return Promise.reject(new Error(SECRET_BODY));
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });
    const output = [...result.warnings, ...result.items.flatMap((item) => item.reasons)].join(" | ");

    // Exactly one request per hunk, failures included: nothing is sent again.
    expect(host.log).toHaveLength(units.length);
    expect(result.modelCalls).toBe(units.length);
    expect(failureWarnings(result.warnings)).toHaveLength(units.length);
    expect(output).not.toContain(SECRET_BODY);
    for (const item of result.items) {
      expect(item.status).toBe("uncertain");
      expect(item.priority).toBe(80);
      expect(item.judgment).toBeUndefined();
    }
    expect(output).toContain("HTTP 500");
    expect(output).toContain("HTTP 401");
    expect(output).toContain(JEV_API_KEY_ENV);
    expect(output).toMatch(/fails closed/u);
  });

  test.each([
    [429, "rate limited"],
    [503, "HTTP 503"],
    [408, "request timeout"],
  ] as const)("never retries a transient status (%i)", async (status, expected) => {
    const host = installFetch(() => new Response(SECRET_BODY, {
      status,
      headers: { "retry-after": "0" },
    }));
    const result = await reviewUnits([makeUnit({ id: "transient", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    expect(host.log).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
    expect(result.items[0].judgment).toBeUndefined();
    expect(result.items[0].reasons.join(" ")).toContain(expected);
  });

  test("reports a timeout as a failed call instead of waiting for a second attempt", async () => {
    const host = installFetch(() => Promise.reject(new DOMException("The operation was aborted.", "TimeoutError")));
    const result = await reviewUnits([makeUnit({ id: "slow", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });
    expect(host.log).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].reasons.join(" ")).toContain(`${JEV_TIMEOUT_MS} ms deadline`);
  });

  test.each(QUESTION_KEYS)("fails closed when the %s answer is missing", async (question) => {
    const host = installFetch(() => new Response(bodyWithoutAnswer({ outcome: "changed" }, question)));

    const result = await reviewUnits([makeUnit({ id: "incomplete", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });

    // An absent answer is not an observation and never reads as "no": the hunk
    // fails closed with no judgment recorded.
    expect(host.log).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].priority).toBe(80);
    expect(result.items[0].judgment).toBeUndefined();
    expect(result.items[0].reasons.join(" ")).toMatch(/the live answer was malformed/u);
  });

  test("fails closed per hunk on malformed answers, with one request each", async () => {
    const base = { outcome: "changed" } as const;
    const cases = {
      // The outcome question is a Choice now: the legacy Score shape is malformed.
      "src/legacy-score.ts": bodyWithAnswer(base, "outcome", {
        type: "score",
        score: 1.5,
        probabilities: { "0": 0.5, "1": 0.5 },
        confidence: 0.9,
      }),
      "src/wrong-type.ts": bodyWithAnswer(base, "outcome", { type: "choice", noul: 0.5 }),
      "src/atomic-wrong-type.ts": bodyWithAnswer(base, "limitChanged", {
        type: "score",
        choice: "yes",
        probabilities: { yes: 1 },
        confidence: 0.9,
      }),
      "src/out-of-range.ts": bodyWithAnswer(base, "comparisonChanged", {
        type: "choice",
        choice: "yes",
        probabilities: { yes: 1.4 },
        confidence: 0.9,
      }),
      "src/bad-sum.ts": bodyWithAnswer(base, "outcome", {
        type: "choice",
        choice: "changed",
        probabilities: { changed: 0.5, unchanged: 0.5, unknown: 0.5 },
        confidence: 0.9,
      }),
      // An option outside the closed set: "maybe" is not one of yes/no/unknown.
      "src/unknown-key.ts": bodyWithAnswer(base, "failureDiscarded", {
        type: "choice",
        choice: "maybe",
        probabilities: { maybe: 0.5, no: 0.5 },
        confidence: 0.9,
      }),
      // An option outside the outcome set: "riskier" is not an outcome.
      "src/bad-option.ts": bodyWithAnswer(base, "outcome", {
        type: "choice",
        choice: "riskier",
        probabilities: { riskier: 1 },
        confidence: 0.9,
      }),
      "src/text-field.ts": bodyWithAnswer(base, "outcome", {
        type: "choice",
        choice: SECRET_ANSWER_TEXT,
        probabilities: { [SECRET_ANSWER_TEXT]: 1 },
        confidence: 0.9,
      }),
      // The chosen option has to be the distribution's highest-probability option.
      "src/loser-choice.ts": bodyWithAnswer(base, "comparisonChanged", {
        type: "choice",
        choice: "yes",
        probabilities: { yes: 0.1, no: 0.9 },
        confidence: 0.9,
      }),
      // A legacy outcome-context answer is no longer part of the contract, so an
      // extra answer id is refused rather than silently ignored.
      "src/legacy-context.ts": bodyWithAnswer(base, "outcomeContext", {
        type: "choice",
        choice: "sufficient",
        probabilities: { sufficient: 1 },
        confidence: 0.9,
      }),
      "src/no-confidence.ts": bodyWithAnswer(base, "validationChanged", {
        type: "choice",
        choice: "yes",
        probabilities: { yes: 0.9, no: 0.1 },
      }),
      // A non-object, non-string answer body for an atomic question.
      "src/atomic-not-object.ts": bodyWithAnswer(base, "failureDeferred", []),
      "src/answers-not-object.ts": JSON.stringify({ model: JEV_MODEL, answers: [] }),
      "src/body-not-object.ts": JSON.stringify([1, 2, 3]),
      "src/body-not-json.ts": `{ not json ${SECRET_BODY}`,
    };
    const units = Object.keys(cases).map((file, index) =>
      makeUnit({ id: `bad-${index}`, file, diff: CODE_HUNK }),
    );
    const host = bodyFetch(cases);

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });
    const output = [...result.warnings, ...result.items.flatMap((item) => item.reasons)].join(" | ");

    expect(host.log).toHaveLength(units.length);
    expect(result.modelCalls).toBe(units.length);
    expect(failureWarnings(result.warnings)).toHaveLength(units.length);
    expect(output).not.toContain(SECRET_ANSWER_TEXT);
    expect(output).not.toContain(SECRET_BODY);
    expect(output).toMatch(/the live answer was malformed/u);
    for (const item of result.items) {
      expect(item.status).toBe("uncertain");
      expect(item.judgment).toBeUndefined();
    }
  });
});

describe("mock mode", () => {
  test("routes every status from deterministic fixtures and makes no calls", async () => {
    const units = [
      makeUnit({
        id: "risky",
        file: "src/login.ts",
        diff: "@@ -1 +1,4 @@\n+const password = readPassword();",
        added: 3,
        removed: 1,
      }),
      makeUnit({ id: "large", file: "src/big.ts", diff: fillerHunk(10), added: 10 }),
      makeUnit({ id: "deletion", file: "src/old.ts", diff: deletionHunk(), added: 0, removed: 3 }),
      makeUnit({ id: "bounded", file: "src/bound.ts", diff: "@@ -1 +1,2 @@\n+if (count >= limit) return;", added: 1 }),
      makeUnit({ id: "ambiguous", file: "src/ambig.ts", diff: "@@ -1 +1,2 @@\n+const n = items.length;", added: 1 }),
      makeUnit({ id: "medium", file: "src/mid.ts", diff: fillerHunk(5), added: 5 }),
      makeUnit({ id: "tiny", file: "src/tiny.ts", diff: fillerHunk(2), added: 2 }),
      makeUnit({ id: "blank", file: "notes.txt", diff: "@@ -1 +1,2 @@\n text\n+", added: 1 }),
    ];
    const host = installFetch(() => {
      throw new Error("mock mode must not reach the network");
    });

    const first = await reviewUnits(units, { mock: true, fetch: host.fetch });
    const second = await reviewUnits(units, { mock: true, fetch: host.fetch });

    expect(host.log).toHaveLength(0);
    expect(first.modelCalls).toBe(0);
    expect(first.warnings).toEqual([MOCK_MODE_WARNING]);
    // The fixture is presented as a fixture: no reason reads as a judgment of the
    // code, and the run-level notice says so too.
    for (const item of first.items) {
      if (item.judgment === undefined) continue;
      expect(item.reasons.join(" ")).toContain("not a live Jev judgment");
    }
    // A risky-looking change is the fixture's own guess at a consumer-visible
    // change, and it is a majority answer, so it ranks as the fixture reports it.
    expect(itemById(first.items, "risky").judgment?.outcome).toBe("changed");
    expect(itemById(first.items, "risky").status).toBe("attention");
    expect(itemById(first.items, "bounded").judgment?.limitChanged).toBe("yes");
    expect(itemById(first.items, "bounded").status).toBe("attention");
    expect(itemById(first.items, "large").judgment?.outcome).toBe("changed");
    expect(itemById(first.items, "large").status).toBe("attention");
    // A tiny change is the one shape the fixture reads as equivalent, and it stays
    // low instead of being passed.
    expect(itemById(first.items, "tiny").judgment?.outcome).toBe("unchanged");
    expect(itemById(first.items, "tiny").status).toBe("low");
    expect(itemById(first.items, "tiny").reasons.join(" ")).toContain("mock mode");
    // The fixture answers unknown where it cannot classify, and that escalates
    // rather than ranking as clean.
    const ambiguous = itemById(first.items, "ambiguous");
    expect(ambiguous.judgment?.comparisonChanged).toBe("unknown");
    expect(ambiguous.status).toBe("uncertain");
    expect(ambiguous.reasons.join(" ")).toContain("was unknown");
    // The outcome the fixture cannot classify is the one it spreads, so that a
    // non-majority answer is normalized to unknown on the same path.
    expect(ambiguous.judgment?.outcome).toBe("unknown");
    expect(itemById(first.items, "blank").status).toBe("passed");
    // Mock fixtures are a pure function of the hunk: two runs are identical.
    expect(second.items).toEqual(first.items);
  });
});

describe("api key handling", () => {
  test("uses the environment key as a fallback and prefers the explicit option", async () => {
    const restore = withMissingApiKeyEnv();
    try {
      process.env[JEV_API_KEY_ENV] = "env-key-value";
      const fromEnvironment = scriptedFetch({ "src/a.ts": { outcome: "changed" } });
      await reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK })], {
        fetch: fromEnvironment.fetch,
      });
      expect(fromEnvironment.log[0].authorization).toBe("Bearer env-key-value");

      const explicit = scriptedFetch({ "src/a.ts": { outcome: "changed" } });
      await reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK })], {
        apiKey: "option-key-value",
        fetch: explicit.fetch,
      });
      expect(explicit.log[0].authorization).toBe("Bearer option-key-value");
    } finally {
      restore();
    }
  });

  test("refuses a live run with no key only when a hunk needs the model", async () => {
    const restore = withMissingApiKeyEnv();
    try {
      const needed = installFetch(() => new Response(answerBody({ outcome: "unchanged" })));
      await expect(
        reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK })], { fetch: needed.fetch }),
      ).rejects.toThrow(/TYPESAFE_API_KEY/u);
      expect(needed.log).toHaveLength(0);

      const skipped = installFetch(() => {
        throw new Error("no hunk here needs the model");
      });
      const result = await reviewUnits([
        makeUnit({ id: "no-op", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
        makeUnit({ id: "binary", file: "a.png", diff: "Binary files differ", special: "binary" }),
      ], { fetch: skipped.fetch });
      expect(skipped.log).toHaveLength(0);
      expect(result.modelCalls).toBe(0);
      expect(result.warnings).toEqual([]);
      expect(result.items.map((item) => item.status)).toEqual(["uncertain", "passed"]);
    } finally {
      restore();
    }
  });
});

describe("live request bounds", () => {
  test("keeps at most the configured number of requests in flight", async () => {
    const files = ["a", "b", "c", "d", "e", "f"].map((name) => `src/${name}.ts`);
    const units = files.map((file) => makeUnit({ id: file, file, diff: CODE_HUNK }));
    let inFlight = 0;
    let peak = 0;
    const host = installFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(answerBody({ outcome: "changed" }), { status: 200 });
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(result.modelCalls).toBe(files.length);
    expect(result.items).toHaveLength(files.length);
    expect(peak).toBe(MAX_CONCURRENT_REQUESTS);
  });
});

describe("direct client use", () => {
  test("refuses an oversized state before spending a request", async () => {
    let calls = 0;
    const client = new JevClient("k", async () => {
      calls += 1;
      return new Response(answerBody({ outcome: "unchanged" }));
    });
    const state = buildJevState(
      makeUnit({ id: "huge", diff: `@@ -1 +1 @@\n+${"x".repeat(MAX_STATE_CHARS + 1)}` }),
    );

    await expect(client.judge(state)).rejects.toBeInstanceOf(JevRequestError);
    expect(calls).toBe(0);
    expect(client.requestCount).toBe(0);
  });
});

function fillerHunk(lines: number): string {
  const body = Array.from({ length: lines }, (_value, index) => `+const value${index} = ${index};`);
  return ["@@ -1 +1 @@", ...body].join("\n");
}

function deletionHunk(): string {
  return "@@ -1,3 +1 @@\n-const a = 1;\n-const b = 2;\n-const c = 3;";
}
