import { describe, expect, test, vi } from "vitest";
import {
  CONTEXT_CONFIDENCE_TARGET,
  JEV_MODEL,
  JEV_RETRY,
  JUDGMENT_RUNS,
  JevClient,
  JevRequestError,
  JevResponseError,
  MAX_ITERATIONS,
  MAX_JEV_CALLS_PER_HUNK,
  MAX_STATE_CHARS,
  REVIEW_CATEGORIES,
  RISK_LEVELS,
  buildJevState,
  toAssessment,
  type JevAssessment,
  type JevEvaluation,
  type JevObject,
  type JevRequest,
  type JevState,
  type ReviewCategory,
} from "../src/review/jev.js";
import {
  INITIAL_STATE_CHARS,
  MAX_ADDED_CONTEXT_BYTES,
  MAX_CONTEXT_NODES,
} from "../src/review/context-plan.js";
import { reviewUnits } from "../src/review/pipeline.js";
import type { ReviewContextNode, ReviewUnit } from "../src/review/types.js";

/**
 * Adaptive context expansion, driven end to end through the public adapter.
 *
 * Every fixture is hermetic: the model is a scripted fetch, retry delays are
 * injected, and the scripted fifth answer is derived from the request the
 * adapter actually sent (`questions.needs_more_context` and
 * `state.contextNodes`), so a fixture can only select a set the adapter really
 * offered. Nothing here pins source strings or call wiring: the contracts are
 * the offered option set, the keys actually expanded, the byte and state
 * bounds, the recorded trace, and the fail-closed behavior.
 */

const RISK_LEVEL_KEYS = RISK_LEVELS.map((_level, index) => String(index));
const CODE_HUNK = "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;";
const KEY = "context-key-9f2";

/** Weighted-style distribution: `chosen` holds `top`, the rest share the remainder. */
function distribution(chosen: string, keys: readonly string[], top: number): Record<string, number> {
  const remainder = keys.length > 1 ? (1 - top) / (keys.length - 1) : 0;
  return Object.fromEntries(keys.map((key) => [key, key === chosen ? top : remainder]));
}

/** ASCII node detail of exactly `bytes` characters, and so of that many UTF-8 bytes. */
function asciiDetail(key: string, bytes: number): string {
  const head = `definition ${key} snapshot=after\n`;
  return head + "x".repeat(Math.max(0, bytes - head.length));
}

/**
 * Node detail whose UTF-8 byte length exceeds its character length, so a budget
 * spent on characters instead of bytes is detectable.
 */
function utf8Detail(key: string, bytes: number): string {
  const head = `definition ${key} snapshot=after /// `;
  let body = "";
  while (Buffer.byteLength(head + body + "\u00e9", "utf8") < bytes) body += "\u00e9";
  return head + body;
}

interface NodeSpec {
  readonly key: string;
  /** Target size of the node's whole detail. */
  readonly bytes: number;
  readonly utf8?: boolean;
}

function contextNodesOf(specs: readonly NodeSpec[]): ReviewContextNode[] {
  return specs.map((spec, index) => ({
    key: spec.key,
    label: `${spec.key}(arg)`,
    file: "src/app.ts",
    line: index + 10,
    detail: spec.utf8 ? utf8Detail(spec.key, spec.bytes) : asciiDetail(spec.key, spec.bytes),
  }));
}

function makeUnit(spec: {
  readonly id?: string;
  readonly file?: string;
  readonly diff?: string;
  readonly nodes?: readonly NodeSpec[];
} = {}): ReviewUnit {
  const nodes = spec.nodes === undefined || spec.nodes.length === 0
    ? undefined
    : contextNodesOf(spec.nodes);
  return {
    id: spec.id ?? "hunk",
    file: spec.file ?? "src/app.ts",
    header: "@@ -1,2 +1,3 @@",
    diff: spec.diff ?? CODE_HUNK,
    added: 1,
    removed: 0,
    oldStart: 1,
    newStart: 1,
    contextNodes: nodes,
  };
}

/** The collapsed keys a request offers for expansion, in request order. */
function collapsedKeysOf(request: JevRequest): readonly string[] {
  return (request.state.contextNodes ?? [])
    .filter((node) => node.collapsed)
    .map((node) => node.key);
}

function collapsedByKey(state: JevState, key: string): boolean | undefined {
  return (state.contextNodes ?? []).find((node) => node.key === key)?.collapsed;
}

/** One scripted round: the four assessment answers plus the fifth answer's selection. */
interface RoundSpec {
  readonly risk: number;
  readonly bug: number;
  readonly category: ReviewCategory;
  readonly needsHuman?: number;
  readonly confidence?: number;
  readonly topLevelProbability?: number;
  readonly categoryProbability?: number;
  /** The collapsed keys to request, chosen from the sets this request offers. */
  readonly select?: (collapsed: readonly string[]) => readonly string[];
  /** Noul probability for the fifth question when no node is collapsed. */
  readonly contextNoul?: number;
}

function fifthObject(request: JevRequest, spec: RoundSpec): JevObject {
  const question = request.questions.needs_more_context;
  if (question.type === "noul") {
    return { type: "noul", noul: spec.contextNoul ?? 0 };
  }
  const selected = [...(spec.select?.(collapsedKeysOf(request)) ?? [])];
  const choice = JSON.stringify(selected);
  const options = Object.keys(question.criteria);
  // A fixture may only answer with a set this request offered, so a broken option
  // list surfaces as a loud fixture error rather than as a silent no-op.
  if (!options.includes(choice)) {
    throw new Error(`fixture selected ${choice}, which this request does not offer`);
  }
  return {
    type: "choice",
    choice,
    probabilities: distribution(choice, options, 0.7),
    confidence: 0.9,
  };
}

function answersObject(request: JevRequest, spec: RoundSpec): JevObject {
  const confidence = spec.confidence ?? 0.9;
  const riskProbabilities = distribution(
    String(Math.round(spec.risk)),
    RISK_LEVEL_KEYS,
    spec.topLevelProbability ?? 0.9,
  );
  let score = 0;
  for (const [level, probability] of Object.entries(riskProbabilities)) {
    score += Number(level) * probability;
  }
  return {
    impact_risk: { type: "score", score, probabilities: riskProbabilities, confidence },
    likely_bug: { type: "noul", noul: spec.bug },
    category: {
      type: "choice",
      choice: spec.category,
      probabilities: distribution(spec.category, REVIEW_CATEGORIES, spec.categoryProbability ?? 0.9),
      confidence,
    },
    needs_human: { type: "noul", noul: spec.needsHuman ?? 0.2 },
    needs_more_context: fifthObject(request, spec),
  };
}

type Reply =
  | { readonly kind: "spec"; readonly spec: RoundSpec }
  | { readonly kind: "body"; readonly answers: JevObject }
  | { readonly kind: "transient"; readonly status: number };

interface Harness {
  readonly log: JevRequest[];
  /** Delays the retry policy asked for; injecting them keeps tests off the clock. */
  readonly waits: number[];
  readonly fetch: typeof globalThis.fetch;
  readonly client: (key?: string) => JevClient;
}

/**
 * Scripted model. Fixtures derive their answers from the request itself —
 * typically from `state.contextNodes` — so a hunk's replies never depend on a
 * shared counter or on how concurrently running hunks interleave. A `transient`
 * reply settles at the current round count. `onWait` observes each injected
 * retry delay, which is how a test moves time without a real timer.
 */
function harness(
  reply: (callIndex: number, request: JevRequest) => Reply,
  onWait?: (ms: number) => void,
): Harness {
  const log: JevRequest[] = [];
  const waits: number[] = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    // SAFETY: this body was serialized by JevClient; the fixture decodes its own typed request.
    const request = JSON.parse(String(init?.body ?? "")) as JevRequest;
    const callIndex = log.length;
    log.push(request);
    const planned = reply(callIndex, request);
    if (planned.kind === "transient") {
      return new Response("", { status: planned.status, headers: { "retry-after": "0" } });
    }
    const answers = planned.kind === "body" ? planned.answers : answersObject(request, planned.spec);
    return new Response(JSON.stringify({ model: JEV_MODEL, answers }), { status: 200 });
  };
  return {
    log,
    waits,
    fetch: fetchImpl,
    client: (key = KEY) => new JevClient(key, fetchImpl, async (ms) => {
      waits.push(ms);
      onWait?.(ms);
    }),
  };
}

/** Every selection the adapter must offer for `keys`: none, one, or a pair. */
function expectedOptions(keys: readonly string[]): string[] {
  const options = ["[]"];
  for (let index = 0; index < keys.length; index += 1) {
    options.push(JSON.stringify([keys[index]]));
    for (let next = index + 1; next < keys.length; next += 1) {
      options.push(JSON.stringify([keys[index], keys[next]]));
    }
  }
  return options.sort();
}

function evaluationOf(assessment: JevAssessment): JevEvaluation {
  if (assessment.evaluation === undefined) throw new Error("the judgment carries no evaluation trace");
  return assessment.evaluation;
}

async function failedEvaluation(promise: Promise<unknown>): Promise<JevEvaluation> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JevRequestError || error instanceof JevResponseError) {
      if (error.evaluation === undefined) throw new Error("the failure carries no evaluation trace");
      return error.evaluation;
    }
    throw error;
  }
  throw new Error("the call was expected to fail closed");
}

/** A hunk whose four-fifths requests would expand: one node fits the initial target. */
function expandableUnit(): ReviewUnit {
  return makeUnit({
    nodes: [
      { key: "after:a", bytes: 6_000 },
      { key: "after:b", bytes: 6_000 },
      { key: "after:c", bytes: 6_000 },
      { key: "after:d", bytes: 6_000 },
    ],
  });
}

describe("context request contract", () => {
  test("offers exactly the zero, one, and two-key sets of the collapsed nodes", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: { risk: 1, bug: 0.2, category: "refactor", select: () => [] },
    }));
    const unit = expandableUnit();

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);

    const request = host.log[0];
    const collapsed = collapsedKeysOf(request);
    // The initial round expands only what the initial target admits, so the rest
    // stay addressable; this premise is what makes any request possible.
    expect(collapsed.length).toBeGreaterThanOrEqual(2);
    const question = request.questions.needs_more_context;
    expect(question.type).toBe("choice");
    if (question.type !== "choice") throw new Error("unreachable");
    expect(Object.keys(question.criteria).sort()).toEqual(expectedOptions(collapsed));
    // A pair is offered, which is the widest request the adapter accepts.
    expect(Object.keys(question.criteria)).toContain(JSON.stringify(collapsed.slice(0, 2)));
    // An empty request terminates after one round without touching the state.
    expect(evaluationOf(assessment).stopReason).toBe("empty_request");
    expect(host.waits).toEqual([]);
  });

  test("asks a noul, and records its raw value, when no node is collapsed", async () => {
    const host = harness((_callIndex, request) => ({
      kind: "body",
      answers: {
        ...answersObject(request, { risk: 1, bug: 0.2, category: "refactor" }),
        needs_more_context: { type: "noul", noul: 0.7 },
      },
    }));
    const unit = makeUnit();

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    const question = host.log[0].questions.needs_more_context;
    expect(question.type).toBe("noul");
    if (question.type !== "noul") throw new Error("unreachable");
    expect(Object.keys(question.criteria).sort()).toEqual(["false", "true"]);
    // Any valid probability is accepted; the request itself normalizes to none.
    const fifth = evaluation.rounds[0].answers[0].needsMoreContext;
    expect(fifth.keys).toEqual([]);
    expect(fifth.probabilities).toEqual({ "[]": 1 });
    expect(fifth.confidence).toBe(1);
    expect(fifth.noul).toBe(0.7);
    expect(evaluation.stopReason).toBe("empty_request");
    expect(evaluation.addedContextBytes).toBe(0);
  });

  test("caps descriptors at the node limit and states the omission in the note", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: { risk: 1, bug: 0.2, category: "refactor", select: () => [] },
    }));
    const specs = Array.from({ length: MAX_CONTEXT_NODES + 2 }, (_value, index) => ({
      key: `after:n${index}`,
      bytes: 13_000,
    }));
    const unit = makeUnit({ nodes: specs });

    await host.client().judge(buildJevState(unit), unit.contextNodes);

    const request = host.log[0];
    const state = request.state;
    const listed = (state.contextNodes ?? []).map((node) => node.key);
    expect(listed).toEqual(specs.slice(0, MAX_CONTEXT_NODES).map((spec) => spec.key));
    const collapsed = collapsedKeysOf(request);
    expect(collapsed).toHaveLength(MAX_CONTEXT_NODES);
    const question = request.questions.needs_more_context;
    if (question.type !== "choice") throw new Error("expected a choice with visible nodes");
    // Every size-zero, one, and two set, and no more.
    expect(Object.keys(question.criteria).sort()).toEqual(expectedOptions(collapsed));
    expect(Object.keys(question.criteria)).toHaveLength(
      1 + MAX_CONTEXT_NODES + (MAX_CONTEXT_NODES * (MAX_CONTEXT_NODES - 1)) / 2,
    );
    // A node with no descriptor is not addressable and cannot be requested.
    for (const spec of specs.slice(MAX_CONTEXT_NODES)) {
      expect(Object.keys(question.criteria)).not.toContain(JSON.stringify([spec.key]));
    }
    // The omissions are stated, not implied, and the note is not the no-node one.
    const dropped = specs.length - MAX_CONTEXT_NODES;
    expect(state.contextNote).toContain(String(dropped));
    expect(state.contextNote).not.toBe(buildJevState(makeUnit()).contextNote);
  });
});

describe("adaptive expansion", () => {
  test("expands exactly the requested keys, keeps the rest collapsed, and truncates nothing", async () => {
    const unit = expandableUnit();
    const supplied = new Map(unit.contextNodes?.map((node) => [node.key, node.detail]));
    const host = harness((_callIndex, request) => ({
      kind: "spec",
      // A state that still offers two collapsed keys is the first round.
      spec: collapsedKeysOf(request).length >= 2
        // The first two collapsed keys, in the order the request lists them.
        ? { risk: 3, bug: 0.8, category: "security", confidence: 0.4, select: (collapsed) => collapsed.slice(0, 2) }
        : { risk: 1, bug: 0.1, category: "refactor", confidence: 0.9, select: () => [] },
    }));

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);
    const [first, second] = evaluation.rounds;

    expect(evaluation.iterations).toBe(2);
    expect(evaluation.modelCalls).toBe(2 * JUDGMENT_RUNS);
    expect(evaluation.stopReason).toBe("empty_request");

    // Round one requested exactly the first two collapsed keys and expanded them.
    const requested = first.requestedKeys;
    expect(requested).toEqual(collapsedKeysOf(host.log[0]).slice(0, 2));
    expect(first.expandedKeys).toEqual(requested);
    // Both requested keys were still collapsed in the state the request read.
    for (const key of requested) expect(collapsedByKey(first.state, key)).toBe(true);

    // The next round carries those details whole, and nothing else changed.
    expect(second.state.contextNodes).toHaveLength(first.state.contextNodes?.length ?? 0);
    for (const key of requested) {
      expect(collapsedByKey(second.state, key)).toBe(false);
      // The serialized state the model receives carries the whole detail too.
      // SAFETY: JSON round-trips the validated state using only JSON-native fields.
      const roundTripped = JSON.parse(JSON.stringify(second.state)) as JevState;
      expect(roundTripped.contextNodes?.find((node) => node.key === key)?.detail).toBe(supplied.get(key));
    }
    // Every expanded node carries its whole detail; every collapsed node is
    // addressable identity only, with no hidden detail.
    const expandedNow: string[] = [];
    for (const node of second.state.contextNodes ?? []) {
      if (node.collapsed) {
        // A collapsed node stays fully addressable: identity, no hidden detail.
        expect(Object.hasOwn(node, "detail")).toBe(false);
        expect(node.key).not.toBe("");
        expect(node.label).not.toBe("");
        expect(node.file).not.toBe("");
        expect(node.line).toBeGreaterThan(0);
        continue;
      }
      expandedNow.push(node.key);
      expect(node.detail).toBe(supplied.get(node.key));
    }
    // The expansion grew by exactly the requested keys, on top of the evidence
    // the initial round already carried for free.
    const initiallyExpanded = (first.state.contextNodes ?? [])
      .filter((node) => !node.collapsed)
      .map((node) => node.key);
    expect(new Set(expandedNow)).toEqual(new Set([...initiallyExpanded, ...requested]));
    expect(expandedNow.length).toBeLessThan(second.state.contextNodes?.length ?? 0);

    // The second round declined, so it added nothing and stopped the loop.
    expect(second.requestedKeys).toEqual([]);
    expect(second.expandedKeys).toEqual([]);

    // Byte and size bounds hold, and the charge covers each whole detail.
    expect(evaluation.addedContextBytes).toBeGreaterThan(0);
    expect(evaluation.addedContextBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    for (const key of requested) {
      expect(evaluation.addedContextBytes)
        .toBeGreaterThanOrEqual(Buffer.byteLength(supplied.get(key) ?? "", "utf8"));
    }
    expect(Buffer.byteLength(JSON.stringify(second.state), "utf8")).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(JSON.stringify(first.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);

    // Append-only evidence: every descriptor survives, only detail was added.
    expect((first.state.contextNodes ?? []).map((node) => node.key))
      .toEqual((second.state.contextNodes ?? []).map((node) => node.key));
  });

  test("aggregates only the final round, and the trace replays that aggregation", async () => {
    const unit = expandableUnit();
    const host = harness((_callIndex, request) => ({
      kind: "spec",
      spec: collapsedKeysOf(request).length >= 2
        ? { risk: 3, bug: 0.8, category: "security", confidence: 0.4, select: (collapsed) => collapsed.slice(0, 2) }
        : { risk: 1, bug: 0.1, category: "refactor", confidence: 0.9, select: () => [] },
    }));

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const rounds = evaluationOf(assessment).rounds;

    const firstRound = toAssessment(rounds[0].answers);
    const finalRound = toAssessment(rounds[1].answers);
    // The two rounds answer differently, so "final only" is observable.
    expect(firstRound.judgment.category).toBe("security");
    expect(finalRound.judgment.category).toBe("refactor");
    expect(rounds[1].answers).toHaveLength(JUDGMENT_RUNS);
    expect(assessment).toEqual({ ...finalRound, evaluation: assessment.evaluation });
  });

  test("fits the initial evidence to the initial target without spending the added budget", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: { risk: 1, bug: 0.2, category: "refactor", select: () => [] },
    }));
    const unit = makeUnit({
      nodes: [
        { key: "after:a", bytes: 6_000 },
        { key: "after:b", bytes: 6_000 },
        { key: "after:c", bytes: 6_000 },
      ],
    });

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);
    const initial = evaluation.rounds[0].state;

    // Whatever fit the initial target is already present as evidence...
    const initialExpanded = (initial.contextNodes ?? []).filter((node) => !node.collapsed);
    expect(initialExpanded.length).toBeGreaterThan(0);
    expect(initialExpanded.every((node) => node.detail !== undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(initial), "utf8")).toBeLessThanOrEqual(INITIAL_STATE_CHARS);
    // ...and it costs nothing: the added budget counts only expand() calls.
    expect(evaluation.addedContextBytes).toBe(0);
  });

  test("counts UTF-8 bytes, not characters, against the added-context budget", async () => {
    const host = harness((_callIndex, request) => ({
      kind: "spec",
      spec: collapsedKeysOf(request).length > 0
        ? { risk: 1, bug: 0.2, category: "refactor", confidence: 0.4, select: (collapsed) => collapsed.slice(0, 1) }
        : { risk: 1, bug: 0.2, category: "refactor", confidence: 0.9, select: () => [] },
    }));
    const unit = makeUnit({ nodes: [{ key: "after:wide", bytes: 22_000, utf8: true }] });
    const detail = unit.contextNodes?.[0].detail ?? "";

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    expect(evaluation.rounds[0].expandedKeys).toEqual(["after:wide"]);
    expect(Buffer.byteLength(detail, "utf8")).toBeGreaterThan(detail.length);
    // A character-counted budget would report less than the raw UTF-8 length.
    expect(evaluation.addedContextBytes).toBeGreaterThanOrEqual(Buffer.byteLength(detail, "utf8"));
    expect(evaluation.addedContextBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
  });
});

describe("terminal conditions", () => {
  test("does not expand when the round already clears the confidence target", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: {
        risk: 1, bug: 0.2, category: "refactor",
        confidence: CONTEXT_CONFIDENCE_TARGET, select: (collapsed) => collapsed.slice(0, 2),
      },
    }));
    const unit = expandableUnit();

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    // The request was non-empty but confidence already met the target: stop with
    // no expansion at all, so a confident hunk never pays for extra context.
    expect(evaluation.stopReason).toBe("confidence");
    expect(evaluation.iterations).toBe(1);
    expect(evaluation.modelCalls).toBe(JUDGMENT_RUNS);
    expect(evaluation.rounds[0].requestedKeys).toHaveLength(2);
    expect(evaluation.rounds[0].expandedKeys).toEqual([]);
    expect(evaluation.addedContextBytes).toBe(0);
    for (const key of evaluation.rounds[0].requestedKeys) {
      expect(collapsedByKey(evaluation.rounds[0].state, key)).toBe(true);
    }
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
  });

  test("stops at the iteration cap and never evaluates a later round", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: {
        risk: 1, bug: 0.2, category: "refactor",
        confidence: 0.4,
        // One fresh key per round; the third round's request is never served.
        select: (collapsed) => collapsed.slice(0, 1),
      },
    }));
    const unit = expandableUnit();

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    expect(evaluation.iterations).toBe(MAX_ITERATIONS);
    expect(evaluation.modelCalls).toBe(MAX_ITERATIONS * JUDGMENT_RUNS);
    expect(host.log).toHaveLength(MAX_ITERATIONS * JUDGMENT_RUNS);
    expect(evaluation.stopReason).toBe("max_iterations");
    expect(evaluation.rounds).toHaveLength(MAX_ITERATIONS);
    expect(evaluation.rounds[0].expandedKeys).toHaveLength(1);
    expect(evaluation.rounds[1].expandedKeys).toHaveLength(1);
    // At the cap the request is recorded but not served.
    expect(evaluation.rounds[2].requestedKeys).toHaveLength(1);
    expect(evaluation.rounds[2].expandedKeys).toEqual([]);
    // Every round's state stayed inside the whole-state cap.
    for (const round of evaluation.rounds) {
      expect(JSON.stringify(round.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    }
    expect(evaluation.addedContextBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
  });

  test("stops with zero progress when the requested detail cannot fit the state", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: { risk: 1, bug: 0.2, category: "refactor", confidence: 0.4, select: (collapsed) => collapsed.slice(0, 1) },
    }));
    const unit = makeUnit({ nodes: [{ key: "after:huge", bytes: 30_000 }] });

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    // One round, one unservable request, no added bytes: the loop terminates
    // instead of retrying a request that can never be satisfied.
    expect(evaluation.iterations).toBe(1);
    expect(evaluation.stopReason).toBe("context_budget");
    expect(evaluation.rounds[0].requestedKeys).toEqual(["after:huge"]);
    expect(evaluation.rounds[0].expandedKeys).toEqual([]);
    expect(evaluation.addedContextBytes).toBe(0);
    expect(collapsedByKey(evaluation.rounds[0].state, "after:huge")).toBe(true);
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
  });

  test("keeps partial progress and stops only once a request adds nothing", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: {
        risk: 1, bug: 0.2, category: "refactor",
        confidence: 0.4, select: (collapsed) => [...collapsed],
      },
    }));
    const unit = makeUnit({
      nodes: [
        { key: "after:one", bytes: 13_000 },
        { key: "after:two", bytes: 13_000 },
      ],
    });

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    // The first request expanded one node and ran out of added-byte budget on the
    // second; that partial progress continues into a second round, whose request
    // for the remaining node adds nothing and so ends the loop.
    expect(evaluation.iterations).toBe(2);
    expect(evaluation.stopReason).toBe("context_budget");
    expect(evaluation.rounds[0].expandedKeys).toEqual(["after:one"]);
    expect(evaluation.rounds[1].expandedKeys).toEqual([]);
    expect(collapsedByKey(evaluation.rounds[1].state, "after:one")).toBe(false);
    expect(collapsedByKey(evaluation.rounds[1].state, "after:two")).toBe(true);
    expect(evaluation.addedContextBytes).toBeGreaterThanOrEqual(13_000);
    expect(evaluation.addedContextBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(evaluation.rounds[1].state), "utf8")).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });

  test("stops on an empty request even when confidence is already high", async () => {
    const host = harness(() => ({
      kind: "spec",
      spec: { risk: 1, bug: 0.2, category: "refactor", confidence: 0.99, select: () => [] },
    }));
    const unit = expandableUnit();

    const assessment = await host.client().judge(buildJevState(unit), unit.contextNodes);
    expect(evaluationOf(assessment).stopReason).toBe("empty_request");
  });
});

describe("failing closed on unusable context requests", () => {
  /**
   * Every malformed fifth answer must fail the hunk before any expansion, with a
   * partial trace and exactly one request: malformed answers are never retried.
   */
  async function expectContextFailure(patch: (request: JevRequest) => JevObject): Promise<JevEvaluation> {
    const host = harness((_callIndex, request) => ({
      kind: "body",
      answers: {
        ...answersObject(request, { risk: 2, bug: 0.4, category: "bug-risk" }),
        needs_more_context: patch(request),
      },
    }));
    const unit = expandableUnit();
    const evaluation = await failedEvaluation(host.client().judge(buildJevState(unit), unit.contextNodes));
    expect(evaluation.stopReason).toBe("error");
    expect(evaluation.iterations).toBe(1);
    expect(evaluation.modelCalls).toBe(1);
    expect(evaluation.rounds).toHaveLength(1);
    expect(evaluation.rounds[0].expandedKeys).toEqual([]);
    expect(evaluation.addedContextBytes).toBe(0);
    expect(host.log).toHaveLength(1);
    return evaluation;
  }

  test("rejects a requested key outside the offered collapsed set", async () => {
    const evaluation = await expectContextFailure(() => ({
      type: "choice",
      choice: JSON.stringify(["after:ghost"]),
      probabilities: { [JSON.stringify(["after:ghost"])]: 1 },
      confidence: 0.9,
    }));
    expect(evaluation.rounds[0].requestedKeys).toEqual([]);
  });

  test("rejects a winner that is not the distribution's highest-probability option", async () => {
    await expectContextFailure((request) => {
      const other = JSON.stringify([collapsedKeysOf(request)[0]]);
      return {
        type: "choice",
        choice: "[]",
        probabilities: { "[]": 0.2, [other]: 0.8 },
        confidence: 0.9,
      };
    });
  });

  test("rejects an unknown probability key", async () => {
    await expectContextFailure(() => ({
      type: "choice",
      choice: "[]",
      probabilities: { "[]": 0.5, "after:ghost": 0.5 },
      confidence: 0.9,
    }));
  });

  test("rejects a distribution that does not sum to one", async () => {
    await expectContextFailure((request) => ({
      type: "choice",
      choice: "[]",
      probabilities: { "[]": 0.5, [JSON.stringify([collapsedKeysOf(request)[0]])]: 0.2 },
      confidence: 0.9,
    }));
  });

  test("rejects a declared type the question did not ask for", async () => {
    await expectContextFailure(() => ({ type: "noul", noul: 0.5 }));
  });

  test("rejects a noul probability outside 0..1 when no node is collapsed", async () => {
    const host = harness((_callIndex, request) => ({
      kind: "body",
      answers: {
        ...answersObject(request, { risk: 2, bug: 0.4, category: "bug-risk" }),
        needs_more_context: { type: "noul", noul: 1.4 },
      },
    }));
    const unit = makeUnit();

    const evaluation = await failedEvaluation(host.client().judge(buildJevState(unit), unit.contextNodes));
    expect(evaluation.stopReason).toBe("error");
    expect(evaluation.modelCalls).toBe(1);
  });
});

describe("per-hunk call cap and shared deadline", () => {
  test("counts retries inside the shared per-hunk call cap across every round", async () => {
    const host = harness((callIndex) => {
      if (callIndex % JEV_RETRY.maxAttempts !== JEV_RETRY.maxAttempts - 1) {
        return { kind: "transient", status: 503 };
      }
      return {
        kind: "spec",
        spec: {
          risk: 1, bug: 0.2, category: "refactor",
          confidence: 0.4,
          select: (collapsed) => collapsed.slice(0, 1),
        },
      };
    });
    const unit = expandableUnit();
    const client = host.client();

    const assessment = await client.judge(buildJevState(unit), unit.contextNodes);
    const evaluation = evaluationOf(assessment);

    // Three rounds x three runs x three attempts. Successful calls alone would be
    // nine, so the cap demonstrably includes the retries.
    expect(MAX_JEV_CALLS_PER_HUNK).toBe(MAX_ITERATIONS * JUDGMENT_RUNS * JEV_RETRY.maxAttempts);
    expect(host.log).toHaveLength(MAX_JEV_CALLS_PER_HUNK);
    expect(client.requestCount).toBe(MAX_JEV_CALLS_PER_HUNK);
    expect(evaluation.modelCalls).toBe(MAX_JEV_CALLS_PER_HUNK);
    expect(evaluation.stopReason).toBe("max_iterations");
    // Two injected waits per run: no wall clock, no real sleep.
    expect(host.waits).toHaveLength(MAX_JEV_CALLS_PER_HUNK - MAX_ITERATIONS * JUDGMENT_RUNS);
  });

  test("shares one deadline across rounds, so a later round never starts", async () => {
    const now = { value: 0 };
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now.value);
    try {
      // The first retry spends half the total budget; the last response of the
      // round spends the other half. No attempt is refused mid-round, and the
      // second round's first check then finds the deadline gone.
      const host = harness((callIndex) => {
        if (callIndex === 0) return { kind: "transient", status: 503 };
        if (callIndex === 3) now.value += JEV_RETRY.totalTimeoutMs / 2;
        return {
          kind: "spec",
          spec: {
            risk: 1, bug: 0.2, category: "refactor",
            confidence: 0.4, select: (collapsed) => collapsed.slice(0, 1),
          },
        };
      }, () => {
        now.value += JEV_RETRY.totalTimeoutMs / 2;
      });
      const unit = makeUnit({
        nodes: [
          { key: "after:a", bytes: 6_000 },
          { key: "after:b", bytes: 6_000 },
          { key: "after:c", bytes: 6_000 },
        ],
      });
      const client = host.client();

      const evaluation = await failedEvaluation(client.judge(buildJevState(unit), unit.contextNodes));

      // Round one finished with its three runs; the second round got no request.
      expect(evaluation.stopReason).toBe("error");
      expect(evaluation.iterations).toBe(2);
      expect(evaluation.modelCalls).toBe(JUDGMENT_RUNS + 1);
      expect(client.requestCount).toBe(JUDGMENT_RUNS + 1);
      expect(host.log).toHaveLength(JUDGMENT_RUNS + 1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("independent per-hunk budgets", () => {
  const SPECS: readonly NodeSpec[] = [
    { key: "after:a", bytes: 7_000 },
    { key: "after:b", bytes: 7_000 },
    { key: "after:c", bytes: 7_000 },
  ];

  test("two concurrent judgments never share an expansion budget", async () => {
    const unitFor = (name: string): ReviewUnit => makeUnit({
      id: name,
      file: `src/${name}.ts`,
      nodes: SPECS.map((spec) => ({ ...spec, key: `after:${name}:${spec.key.slice("after:".length)}` })),
    });
    const first = unitFor("alpha");
    const second = unitFor("beta");
    // The reply is derived from the request's own state, never from a shared
    // counter, so concurrent hunks cannot influence each other's answers.
    const host = harness((_callIndex, request) => {
      const collapsed = collapsedKeysOf(request);
      return {
        kind: "spec",
        spec: collapsed.length >= 2
          ? { risk: 1, bug: 0.2, category: "refactor", confidence: 0.4, select: () => collapsed.slice(0, 2) }
          : { risk: 1, bug: 0.2, category: "refactor", confidence: 0.9, select: () => [] },
      };
    });

    const client = host.client();
    const [alpha, beta] = await Promise.all([
      client.judge(buildJevState(first), first.contextNodes),
      client.judge(buildJevState(second), second.contextNodes),
    ]);

    for (const [assessment, unit] of [[alpha, first], [beta, second]] as const) {
      const evaluation = evaluationOf(assessment);
      const expanded = evaluation.rounds[0].expandedKeys;
      expect(expanded).toHaveLength(2);
      // Each hunk expanded only its own keys, and each spent more than half the
      // whole added budget: a shared budget could not let both do that.
      for (const key of expanded) expect(key.startsWith(`after:${unit.id}:`)).toBe(true);
      expect(evaluation.addedContextBytes).toBeGreaterThan(MAX_ADDED_CONTEXT_BYTES / 2);
      expect(evaluation.addedContextBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    }
  });

  test("reviewUnits keeps one trace and one iteration log per hunk, failures included", async () => {
    const judged = {
      id: "judged",
      file: "src/judged.ts",
      nodes: [
        { key: "after:a", bytes: 6_000 },
        { key: "after:b", bytes: 6_000 },
        { key: "after:c", bytes: 6_000 },
        { key: "after:d", bytes: 6_000 },
      ],
    };
    const failed = { id: "failed", file: "src/failed.ts", nodes: [{ key: "after:x", bytes: 6_000 }] };
    const callsByFile = new Map<string, number>();
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      // SAFETY: JevClient produced this request body; this fixture observes that typed boundary.
      const request = JSON.parse(String(init?.body ?? "")) as JevRequest;
      const file = request.state.file;
      // A definitive rejection, so this fixture needs no timer at all.
      if (file === failed.file) return new Response("", { status: 422 });
      const callIndex = callsByFile.get(file) ?? 0;
      callsByFile.set(file, callIndex + 1);
      const spec: RoundSpec = callIndex < JUDGMENT_RUNS
        ? { risk: 1, bug: 0.2, category: "refactor", confidence: 0.4, select: (collapsed) => collapsed.slice(0, 2) }
        : { risk: 1, bug: 0.2, category: "refactor", confidence: 0.9, select: () => [] };
      return new Response(
        JSON.stringify({ model: JEV_MODEL, answers: answersObject(request, spec) }),
        { status: 200 },
      );
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await reviewUnits(
        [makeUnit(judged), makeUnit(failed)],
        { apiKey: KEY, fetch: fetchImpl },
      );
      const judgedItem = result.items.find((item) => item.id === "judged");
      const failedItem = result.items.find((item) => item.id === "failed");
      if (judgedItem === undefined || failedItem === undefined) throw new Error("missing item");

      expect(judgedItem.evaluation?.stopReason).toBe("empty_request");
      expect(judgedItem.evaluation?.iterations).toBe(2);
      expect(judgedItem.evaluation?.addedContextBytes).toBeGreaterThan(0);
      // A failed hunk still reports how far its loop got.
      expect(failedItem.evaluation?.stopReason).toBe("error");
      expect(failedItem.evaluation?.modelCalls).toBe(1);
      expect(failedItem.judgment).toBeUndefined();
      expect(failedItem.status).toBe("uncertain");

      // One iteration log per attempted hunk, in warnings, never on stdout.
      const logs = result.warnings.filter((warning) => /Jev iterations=/u.test(warning));
      expect(logs).toHaveLength(2);
      for (const warning of logs) {
        expect(warning).toMatch(
          /: Jev iterations=\d+, calls=\d+, added-context-bytes=\d+, stop=(empty_request|confidence|max_iterations|context_budget|error)$/u,
        );
      }
      expect(logs.some((warning) => warning.startsWith(`${failed.file} ${failedItem.header}: `))).toBe(true);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
