import { describe, expect, test, vi } from "vitest";
import {
  CATEGORY_RUBRIC,
  JEV_API_KEY_ENV,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_RETRY,
  JUDGMENT_RUNS,
  JevClient,
  JevRequestError,
  MAX_STATE_CHARS,
  REVIEW_CATEGORIES,
  RISK_LEVELS,
  buildJevState,
  type JevObject,
  type JevRequest,
  type ReviewCategory,
} from "../src/review/jev.js";
import {
  DIVERGENCE_THRESHOLD,
  MAX_CONCURRENT_REQUESTS,
  MOCK_MODE_WARNING,
  reviewUnits,
  TOP_CATEGORY_PROBABILITY_FLOOR,
  TOP_LEVEL_PROBABILITY_FLOOR,
} from "../src/review/pipeline.js";
import type { ReviewItem, ReviewUnit } from "../src/review/types.js";

const SECRET_BODY = "SERVER-BODY-SECRET-9f2";
const SECRET_ANSWER_TEXT = "IGNORE-ALL-PREVIOUS-INSTRUCTIONS";
const RISK_LEVEL_KEYS = ["0", "1", "2", "3"];

interface UnitSpec {
  readonly id: string;
  readonly diff: string;
  readonly file?: string;
  readonly added?: number;
  readonly removed?: number;
  readonly special?: string;
  readonly callFlow?: readonly string[];
}

function makeUnit(spec: UnitSpec): ReviewUnit {
  const callFlow = spec.callFlow;
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
    callFlow: callFlow === undefined ? undefined : [...callFlow],
  };
}

interface AnswerSpec {
  /** The most likely rubric level; the answer's score is that distribution's mean. */
  readonly risk: number;
  readonly bug: number;
  readonly category: ReviewCategory;
  readonly needsHuman?: number;
  readonly confidence?: number;
  /** Weight on the most likely risk level; below 0.6 the vote reads as split. */
  readonly topLevelProbability?: number;
  /** Weight on the most likely category, independent of vendor confidence. */
  readonly categoryProbability?: number;
  readonly riskProbabilities?: Readonly<Record<string, number>>;
  readonly categoryProbabilities?: Readonly<Record<string, number>>;
}

/** Weighted-style distribution: the chosen level holds `top`, the rest share the remainder. */
function distribution(chosen: string, keys: readonly string[], top: number): Record<string, number> {
  const remainder = (keys.length > 1 ? (1 - top) / (keys.length - 1) : 0);
  return Object.fromEntries(keys.map((key) => [key, key === chosen ? top : remainder]));
}

/**
 * Build one documented response body. The score is derived from the answer's own
 * level distribution, as the API derives it, so the fixture is a body the adapter
 * accepts for the reason a live body is accepted.
 */
function answersOf(spec: AnswerSpec): JevObject {
  const confidence = spec.confidence ?? 0.9;
  const riskProbabilities = spec.riskProbabilities ?? distribution(
    String(Math.round(spec.risk)),
    RISK_LEVEL_KEYS,
    spec.topLevelProbability ?? 0.7,
  );
  let score = 0;
  for (const [level, probability] of Object.entries(riskProbabilities)) {
    score += Number(level) * probability;
  }
  return {
    impact_risk: {
      type: "score",
      score,
      probabilities: riskProbabilities,
      confidence,
    },
    likely_bug: { type: "noul", noul: spec.bug },
    category: {
      type: "choice",
      choice: spec.category,
      probabilities: spec.categoryProbabilities ?? distribution(spec.category, REVIEW_CATEGORIES, spec.categoryProbability ?? 0.9),
      confidence,
    },
    needs_human: { type: "noul", noul: spec.needsHuman ?? 0.2 },
    // No unit in this file supplies structured context nodes, so the adapter
    // asks its fifth question as a noul and expects a plain probability.
    needs_more_context: { type: "noul", noul: 0 },
  };
}

function answerBody(spec: AnswerSpec): string {
  return JSON.stringify({ model: JEV_MODEL, answers: answersOf(spec) });
}

interface FetchLog {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly request: JevRequest;
}

interface FetchHost {
  readonly fetch: typeof globalThis.fetch;
  readonly log: FetchLog[];
}

function installFetch(
  reply: (request: JevRequest) => Response | Promise<Response>,
): FetchHost {
  const log: FetchLog[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw: unknown = JSON.parse(String(init?.body ?? ""));
    // SAFETY: the adapter serializes this request; the stub only reads it back.
    const request = raw as JevRequest;
    log.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      request,
    });
    return reply(request);
  };
  return { fetch: fetchImpl, log };
}

function scriptedFetch(script: Readonly<Record<string, AnswerSpec>>): FetchHost {
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

/**
 * The fixed per-hunk context-loop log. It is observational evidence about how
 * many rounds and requests a hunk took, not a failure, so assertions about
 * failing closed filter it out rather than weakening what they check.
 */
const ITERATION_LOG = /: Jev iterations=\d+, calls=\d+, added-context-bytes=\d+, stop=/u;

function failureWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !ITERATION_LOG.test(warning));
}

function withMissingApiKeyEnv(): () => void {
  const saved = process.env[JEV_API_KEY_ENV];
  delete process.env[JEV_API_KEY_ENV];
  return () => {
    if (saved === undefined) delete process.env[JEV_API_KEY_ENV];
    else process.env[JEV_API_KEY_ENV] = saved;
  };
}

const CODE_HUNK = "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;";

describe("reviewUnits ranking and requests", () => {
  test("ranks weighted judgments and posts the documented request", async () => {
    const units = [
      makeUnit({
        id: "high",
        file: "src/high.ts",
        diff: CODE_HUNK,
        added: 1,
        callFlow: ["runCheckout()", "└─ deleteOrder()"],
      }),
      makeUnit({ id: "clean", file: "src/clean.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "mid", file: "src/mid.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = scriptedFetch({
      "src/high.ts": { risk: 3, bug: 0.78, category: "security" },
      "src/mid.ts": { risk: 1, bug: 0.2, category: "refactor" },
      "src/clean.ts": { risk: 0, bug: 0.02, category: "style" },
    });

    const result = await reviewUnits(units, { apiKey: "test-key", fetch: host.fetch });

    expect(result.modelCalls).toBe(units.length * JUDGMENT_RUNS);
    expect(result.items.map((item) => item.id)).toEqual(["high", "mid", "clean"]);
    expect(result.items.map((item) => item.status)).toEqual(["attention", "low", "low"]);
    // Scores 2.4 / 1.2 / 0.6 x 50 + bug x 30 + needs-human x 20 + the category boost.
    expect(result.items.map((item) => item.priority)).toEqual([79, 30, 15]);

    expect(host.log).toHaveLength(units.length * JUDGMENT_RUNS);
    expect(host.log[0].url).toBe(JEV_ENDPOINT);
    expect(host.log[0].method).toBe("POST");
    expect(host.log[0].authorization).toBe("Bearer test-key");
    const request = host.log[0].request;
    expect(request.model).toBe(JEV_MODEL);
    expect(Object.keys(request.questions).sort()).toEqual([
      "category",
      "impact_risk",
      "likely_bug",
      "needs_human",
      "needs_more_context",
    ]);
    expect(request.questions.impact_risk.type).toBe("score");
    expect(request.questions.impact_risk.criteria).toHaveLength(RISK_LEVEL_KEYS.length);
    expect(request.questions.likely_bug.type).toBe("noul");
    expect(request.questions.needs_human.type).toBe("noul");
    expect(request.questions.category.type).toBe("choice");
    // With no collapsed context nodes the fifth question is a plain noul, so it
    // is answerable rather than an empty choice.
    expect(request.questions.needs_more_context.type).toBe("noul");
    expect(Object.keys(request.questions.category.criteria).sort()).toEqual(
      [...REVIEW_CATEGORIES].sort(),
    );

    expect(request.state.callFlow).toEqual(["runCheckout()", "└─ deleteOrder()"]);
    // State is exactly the fields a question refers to: nothing extra to distract
    // the model, and no answer field that code already knows.
    expect(Object.keys(request.state).sort()).toEqual([
      "callFlow",
      "contextNote",
      "diff",
      "file",
      "hunk",
    ]);
    const withoutFlow = host.log[1].request.state;
    expect(withoutFlow.callFlow).toBeUndefined();
    // The key travels in the Authorization header only, never in the body.
    for (const entry of host.log) {
      expect(entry.authorization).toBe("Bearer test-key");
      expect(JSON.stringify(entry.request)).not.toContain("test-key");
    }
  });

  test("keeps the input units untouched and reports one item per unit", async () => {
    const units = [
      makeUnit({ id: "judged", file: "src/a.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "trivial", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
    ];
    const snapshot = structuredClone(units);
    const host = scriptedFetch({ "src/a.ts": { risk: 1, bug: 0.2, category: "refactor" } });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id).sort()).toEqual(["judged", "trivial"]);
    // The trivial hunk is explained by the deterministic rule that spared it.
    const trivial = itemById(result.items, "trivial");
    expect(trivial.status).toBe("passed");
    expect(trivial.reasons.join("\n")).toMatch(/exact no-op/);
    // The judged hunk carries the model's own answer and its routing note.
    const judged = itemById(result.items, "judged");
    expect(judged.judgment?.category).toBe("refactor");
    expect(judged.reasons.join("\n")).toMatch(/routed to low/);
    expect(units).toEqual(snapshot);
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
  });
});

describe("multi-run judgments", () => {
  /** Return named probabilities in request order, as a choice API may do. */
  function runFetch(runs: readonly AnswerSpec[]): FetchHost {
    let next = 0;
    return installFetch((request) => {
      const spec = runs[next];
      next += 1;
      if (spec === undefined) throw new Error("no scripted judgment run");
      const probabilities = spec.categoryProbabilities ??
        distribution(spec.category, REVIEW_CATEGORIES, spec.categoryProbability ?? 0.9);
      const ordered = Object.fromEntries(
        Object.keys(request.questions.category.criteria)
          .filter((option) => Object.hasOwn(probabilities, option))
          .map((option) => [option, probabilities[option]]),
      );
      return new Response(answerBody({ ...spec, categoryProbabilities: ordered }));
    });
  }

  test("shuffles all ten options afresh on every attempt without changing ordinal risk levels", async () => {
    const categories = [...REVIEW_CATEGORIES];
    const levels = [...RISK_LEVELS];
    const host = installFetch(() => host.log.length === 1
      ? new Response("", { status: 429, headers: { "retry-after": "0" } })
      : new Response(answerBody({ risk: 1, bug: 0.1, category: "refactor" })));
    // Distinct entropy per attempt makes freshness deterministic, including retries.
    const client = new JevClient("k", host.fetch, undefined, (max) => host.log.length % max);
    const state = buildJevState(makeUnit({ id: "caller", diff: CODE_HUNK }));
    for (let index = 0; index < 12; index += 1) await client.judge(state);

    expect(host.log).toHaveLength(12 * JUDGMENT_RUNS + 1);
    const orders = host.log.map(({ request }) => Object.keys(request.questions.category.criteria));
    for (const { request } of host.log) {
      expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
      expect(Object.keys(request.questions.category.criteria).sort()).toEqual([...categories].sort());
      expect(request.questions.category.criteria).toEqual(CATEGORY_RUBRIC);
      expect(request.questions.impact_risk.criteria).toEqual(levels);
    }
    expect(new Set(orders.slice(0, JUDGMENT_RUNS + 1).map((order) => order.join(","))).size)
      .toBe(JUDGMENT_RUNS + 1);
    expect(new Set(orders.map((order) => order.join(","))).size).toBeGreaterThan(10);
    expect(REVIEW_CATEGORIES).toEqual(categories);
    expect(RISK_LEVELS).toEqual(levels);
  });

  test("averages probability vectors by name, not permutation or winning votes", async () => {
    const host = runFetch([
      {
        risk: 0, bug: 0.1, needsHuman: 0.2, confidence: 0.2, category: "refactor",
        riskProbabilities: { "0": 1 },
        categoryProbabilities: { refactor: 0.55, security: 0.45 },
      },
      {
        risk: 3, bug: 0.2, needsHuman: 0.4, confidence: 0.4, category: "refactor",
        riskProbabilities: { "3": 1 },
        categoryProbabilities: { refactor: 0.55, security: 0.45 },
      },
      {
        risk: 3, bug: 0.3, needsHuman: 0.6, confidence: 0.6, category: "security",
        riskProbabilities: { "0": 0.5, "3": 0.5 },
        categoryProbabilities: { security: 1 },
      },
    ]);
    const client = new JevClient("k", host.fetch, undefined, (max) => host.log.length % max);
    const result = await client.judge(
      buildJevState(makeUnit({ id: "caller", diff: CODE_HUNK })),
    );

    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    expect(new Set(host.log.map(({ request }) =>
      Object.keys(request.questions.category.criteria).join(","))).size).toBe(JUDGMENT_RUNS);
    for (const category of REVIEW_CATEGORIES) {
      const expected = category === "security" ? 1.9 / 3 : category === "refactor" ? 1.1 / 3 : 0;
      expect(result.categoryProbabilities[category]).toBeCloseTo(expected);
    }
    expect(result.riskProbabilities).toEqual({ "0": 0.5, "1": 0, "2": 0, "3": 0.5 });
    expect(result.judgment.category).toBe("security");
    expect(result.judgment.risk).toBeCloseTo(1.5);
    expect(result.judgment.bug).toBeCloseTo(0.2);
    expect(result.judgment.needsHuman).toBeCloseTo(0.4);
    expect(result.judgment.confidence).toBeCloseTo(0.4);
    expect(result.categoryTopProbability).toBeCloseTo(1.9 / 3);
    expect(result.riskTopProbability).toBeCloseTo(0.5);
    expect(result.divergence).toBeCloseTo(0.5);
  });

  test.each(["category", "risk"] as const)(
    "routes strongly divergent %s runs to uncertain even when the mean clears both floors",
    async (question) => {
      const agreed: AnswerSpec = {
        risk: 3, bug: 0.8, category: "security", topLevelProbability: 1, categoryProbability: 1,
      };
      const runs = Array<AnswerSpec>(JUDGMENT_RUNS).fill(agreed);
      const stable = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
        apiKey: "k", fetch: runFetch(runs).fetch,
      });
      runs[JUDGMENT_RUNS - 1] = question === "category"
        ? { ...agreed, category: "refactor" }
        : { ...agreed, risk: 0 };
      const assessment = await new JevClient("k", runFetch(runs).fetch).judge(
        buildJevState(makeUnit({ id: "caller", diff: CODE_HUNK })),
      );
      const unstable = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
        apiKey: "k", fetch: runFetch(runs).fetch,
      });

      // One outlier leaves a clear aggregate winner, but must not be hidden by it.
      const majority = (JUDGMENT_RUNS - 1) / JUDGMENT_RUNS;
      expect(assessment.categoryTopProbability).toBeGreaterThanOrEqual(TOP_CATEGORY_PROBABILITY_FLOOR);
      expect(assessment.riskTopProbability).toBeGreaterThanOrEqual(TOP_LEVEL_PROBABILITY_FLOOR);
      expect(assessment.divergence).toBeGreaterThanOrEqual(DIVERGENCE_THRESHOLD);
      expect(stable.items[0].status).toBe("attention");
      expect(unstable.items[0].status).toBe("uncertain");
      expect(unstable.items[0].judgment?.category).toBe("security");
      expect(unstable.items[0].judgment?.risk).toBeCloseTo(question === "risk" ? 3 * majority : 3);
    },
  );

  test.each(["category", "risk"] as const)(
    "routes an averaged %s probability below its floor to uncertain despite high confidence",
    async (question) => {
      const runs = [0.65, 0.55, 0.57].map((top): AnswerSpec => ({
        risk: 3, bug: 0.8, category: "security", confidence: 0.99,
        categoryProbability: question === "category" ? top : 0.9,
        topLevelProbability: question === "risk" ? top : 0.9,
      }));
      const result = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
        apiKey: "k", fetch: runFetch(runs).fetch,
      });
      expect(result.items[0].judgment?.confidence).toBeCloseTo(0.99);
      expect(result.items[0].status).toBe("uncertain");
    },
  );

  test("does not treat modest distribution variation as unstable", async () => {
    const host = runFetch([0.9, 0.65, 0.55].map((top): AnswerSpec => ({
      risk: 3, bug: 0.8, category: "security", categoryProbability: top,
    })));
    const result = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });
    expect(result.items[0].status).toBe("attention");
  });

  test.each(["rejection", "malformed"] as const)("discards earlier runs after a later %s", async (failure) => {
    const host = installFetch(() => host.log.length === 1
      ? new Response(answerBody({ risk: 3, bug: 0.8, category: "security" }))
      : new Response("{}", { status: failure === "rejection" ? 401 : 200 }));
    const result = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
      apiKey: "k", fetch: host.fetch,
    });
    expect(result.modelCalls).toBe(2);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].judgment).toBeUndefined();
    expect(failureWarnings(result.warnings)).toHaveLength(1);
  });

  test("shares the existing total deadline across successful runs", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const host = installFetch(() => {
      now += JEV_RETRY.totalTimeoutMs;
      return new Response(answerBody({ risk: 3, bug: 0.8, category: "security" }));
    });
    try {
      const result = await reviewUnits([makeUnit({ id: "caller", diff: CODE_HUNK })], {
        apiKey: "k", fetch: host.fetch,
      });
      expect(result.modelCalls).toBe(1);
      expect(result.items[0].status).toBe("uncertain");
      expect(result.items[0].judgment).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});

describe("deterministic passes", () => {
  test("increment and decrement code is never mistaken for patch file headers", async () => {
    const host = installFetch(() => new Response(answerBody({ risk: 2, bug: 0.8, category: "bug-risk" })));
    const result = await reviewUnits([
      makeUnit({ id: "operators", diff: "@@ -1 +1 @@\n---counter;\n+++counter;", added: 1, removed: 1 }),
    ], { apiKey: "test-key", fetch: host.fetch });
    expect(result.items[0].status).toBe("attention");
    expect(result.modelCalls).toBe(JUDGMENT_RUNS);
  });
  test("passes exact no-ops and blank-only text documents, and judges everything else", async () => {
    const units = [
      makeUnit({ id: "no-op", file: "src/app.ts", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
      makeUnit({ id: "blank-md", file: "docs/notes.md", diff: "@@ -1 +1,3 @@\n+ \n+  ", added: 2 }),
      makeUnit({ id: "blank-ts", file: "src/blank.ts", diff: "@@ -1 +1,3 @@\n+ \n+  ", added: 2 }),
      makeUnit({ id: "comment", file: "src/comment.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = scriptedFetch({
      "src/blank.ts": { risk: 1, bug: 0.2, category: "refactor" },
      "src/comment.ts": { risk: 1, bug: 0.2, category: "refactor" },
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "no-op").status).toBe("passed");
    expect(itemById(result.items, "blank-md").status).toBe("passed");
    expect(itemById(result.items, "blank-md").judgment).toBeUndefined();
    expect(itemById(result.items, "blank-ts").status).toBe("low");
    expect(itemById(result.items, "comment").status).toBe("low");
    expect(host.log.map((entry) => entry.request.state.file).sort()).toEqual([
      ...Array<string>(JUDGMENT_RUNS).fill("src/blank.ts"),
      ...Array<string>(JUDGMENT_RUNS).fill("src/comment.ts"),
    ]);
    expect(result.modelCalls).toBe(2 * JUDGMENT_RUNS);
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

/** The serialized size the cap is measured against, for one unit's state. */
function stateCharsOf(unit: ReviewUnit): number {
  return JSON.stringify(buildJevState(unit)).length;
}

/** One standalone call block as the context builder supplies it, `chars` long. */
function callFlowBlock(index: number, chars: number): string {
  const head = `call callee${index} @ src/app.ts:${index + 1}\n  snapshot=after target=lexical\n  mapping=positional\n  arg[1] -> param1: "`;
  return `${head}${"a".repeat(chars - head.length)}"`;
}

/** A flow too large to send whole, ending in the builder's aggregate omission marker. */
function oversizedFlow(): string[] {
  const blocks = Array.from({ length: 30 }, (_value, index) => callFlowBlock(index, 900));
  blocks.push("[call-flow context omitted: unrelated trees and snippets beyond the depth limit]");
  return blocks;
}

/**
 * A hunk whose state with no call flow, and therefore the no-flow note, is exactly
 * `chars` characters. The diff tail is a quote, so the fixture measures JSON
 * escaping rather than raw diff length. Throws rather than silently testing a
 * different size.
 */
function unitAtEssentialChars(chars: number): ReviewUnit {
  const file = "src/boundary.ts";
  const probe = stateCharsOf(makeUnit({ id: "boundary", file, diff: hunkWithFiller(0) }));
  // Each filler character costs exactly one serialized character.
  return unitAssertingChars(
    makeUnit({ id: "boundary", file, diff: hunkWithFiller(chars - probe) }),
    chars,
  );
}

/**
 * A hunk whose state, with every supplied call-flow entry included, is exactly
 * `chars` characters. Only meaningful at or under the cap with a flow small enough
 * to fit whole; a larger flow would be pruned and the size would not be linear.
 */
function unitAtFullFlowChars(chars: number, callFlow: readonly string[]): ReviewUnit {
  const file = "src/boundary.ts";
  const probe = stateCharsOf(makeUnit({ id: "boundary", file, diff: hunkWithFiller(0), callFlow }));
  return unitAssertingChars(
    makeUnit({ id: "boundary", file, diff: hunkWithFiller(chars - probe), callFlow }),
    chars,
  );
}

/** The unit when its state is exactly `chars` characters; a thrown error when it is not. */
function unitAssertingChars(unit: ReviewUnit, chars: number): ReviewUnit {
  const actual = stateCharsOf(unit);
  if (actual !== chars) throw new Error(`fixture is ${actual} serialized characters, not ${chars}`);
  return unit;
}

/** The shared hunk plus `filler` unescaped filler characters and one closing quote. */
function hunkWithFiller(filler: number): string {
  return `${CODE_HUNK}\n+${"x".repeat(filler)}"`;
}

describe("serialized state budget", () => {
  test("prunes optional call-flow context instead of routing the hunk to a human", async () => {
    const flow = oversizedFlow();
    expect(flow.join("").length).toBeGreaterThan(MAX_STATE_CHARS);
    const unit = makeUnit({ id: "flow", diff: CODE_HUNK, callFlow: flow });
    const host = scriptedFetch({ "src/app.ts": { risk: 1, bug: 0.2, category: "refactor" } });

    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });

    // A call flow that cannot fit whole is optional context: the hunk is judged live.
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    const item = result.items[0];
    expect(item.judgment?.category).toBe("refactor");
    expect(item.status).toBe("low");
    expect(item.routing).toBeUndefined();
    // The item still carries the full context the extraction side supplied, for the report.
    expect(item.callFlow).toEqual(flow);

    const state = host.log[0].request.state;
    expect(state.file).toBe("src/app.ts");
    expect(state.hunk).toBe(unit.header);
    expect(state.diff).toBe(CODE_HUNK);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);

    const sent = state.callFlow ?? [];
    const keptEntries = flow.filter((entry) => sent.includes(entry));
    expect(keptEntries.length).toBeGreaterThan(0);
    expect(keptEntries.length).toBeLessThan(flow.length);
    // Whole entries, in the supplied priority order, never reordered or spliced.
    expect(sent.slice(0, keptEntries.length)).toEqual(keptEntries);
    // One trailing marker reports the count of dropped entries, excluding itself.
    expect(sent).toHaveLength(keptEntries.length + 1);
    expect(sent[keptEntries.length]).toMatch(
      new RegExp(`omitted to fit the size limit: ${flow.length - keptEntries.length} of ${flow.length}\\b`, "u"),
    );
    // The note already states the omission for the whole state, whatever the marker says.
    expect(state.contextNote).toMatch(/omitted/u);
    expect(item.reasons.join(" ")).toMatch(/trimmed/u);
    expect(item.reasons.join(" ")).toContain(`${keptEntries.length} of ${flow.length}`);
  });

  test("marks every omitted entry even where the count marker cannot fit", async () => {
    // Two entries fill the state to one character under the cap, so a third cannot
    // fit beside them and the count marker has no room either.
    const fitting = [callFlowBlock(0, 400), callFlowBlock(1, 400)];
    const pruned = callFlowBlock(2, 400);
    const filled = unitAtFullFlowChars(MAX_STATE_CHARS - 1, fitting);
    const unit = makeUnit({ id: "filled", file: filled.file, diff: filled.diff, callFlow: [...fitting, pruned] });
    const host = scriptedFetch({ [filled.file]: { risk: 1, bug: 0.2, category: "refactor" } });

    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });
    const state = host.log[0].request.state;
    const sent = state.callFlow ?? [];

    expect(sent).toEqual(fitting);
    expect(JSON.stringify(state)).toHaveLength(MAX_STATE_CHARS - 1);
    // No room for the count, so the note alone carries the omission — and it does.
    expect(sent.some((entry) => entry.includes("omitted to fit the size limit"))).toBe(false);
    expect(state.contextNote).toMatch(/every call-flow entry not listed in this state is omitted/u);
    expect(result.items[0].judgment).toBeDefined();
    expect(result.items[0].routing).toBeUndefined();
    expect(result.items[0].reasons.join(" ")).toContain(`2 of 3 entries were sent`);
  });

  test("judges with the hunk alone when no call-flow entry can fit at all", async () => {
    // The essentials fit the cap under the short no-flow note, and only under that
    // note: the enriched note is longer than the remaining room. With every entry
    // too big to fit, the state must fall back to the smaller note and still be
    // judged, so choosing that note never by itself forces a manual review.
    const wide = unitAtEssentialChars(MAX_STATE_CHARS - 10);
    const flow = [callFlowBlock(0, MAX_STATE_CHARS + 1_000)];
    const unit = makeUnit({ id: "wide", file: wide.file, diff: wide.diff, callFlow: flow });
    // The essentials are ten characters under the cap, so there is no room for any
    // entry — nor for the enriched note that carrying one would select. Both must
    // give way and leave a state that still fits and is still judged.
    const small = buildJevState(
      makeUnit({ id: "wide", file: wide.file, diff: wide.diff, callFlow: [callFlowBlock(1, 200)] }),
    );
    expect(small.contextNote).toBe(buildJevState(wide).contextNote);
    expect(small.callFlow).toBeUndefined();
    const host = scriptedFetch({ [wide.file]: { risk: 1, bug: 0.2, category: "refactor" } });

    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });

    // One entry larger than the whole budget is dropped whole; the hunk is still
    // judged on its diff rather than sent to a human for optional context.
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    const state = host.log[0].request.state;
    expect(state.callFlow).toBeUndefined();
    expect(state.contextNote).toBe(buildJevState(wide).contextNote);
    expect(state.diff).toBe(wide.diff);
    expect(JSON.stringify(state)).toHaveLength(MAX_STATE_CHARS - 10);
    expect(result.items[0].judgment).toBeDefined();
    expect(result.items[0].routing).toBeUndefined();
    expect(result.items[0].callFlow).toEqual(flow);
    expect(result.items[0].reasons.join(" ")).toContain(`0 of ${flow.length} entries were sent`);
  });

  test("uses remaining space after skipping a block that cannot fit at all", async () => {
    const retained = callFlowBlock(1, 120);
    const unit = makeUnit({ id: "caller", diff: CODE_HUNK, callFlow: [callFlowBlock(0, MAX_STATE_CHARS), retained] });
    const host = scriptedFetch({ "src/app.ts": { risk: 1, bug: 0.2, category: "refactor" } });
    const result = await reviewUnits([unit], { apiKey: "k", fetch: host.fetch });
    expect(host.log[0].request.state.callFlow?.[0]).toBe(retained);
    expect(JSON.stringify(host.log[0].request.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(result.items[0].routing).toBeUndefined();
    expect(result.items[0].reasons.join(" ")).toContain("1 of 2 entries were sent");
  });

  test("caps on the serialized JSON, so escaping counts, at an exact boundary", async () => {
    const entry = callFlowBlock(0, 120);
    const atCap = unitAtFullFlowChars(MAX_STATE_CHARS, [entry]);
    const overCap = unitAtEssentialChars(MAX_STATE_CHARS + 1);
    const host = installFetch(() => new Response(answerBody({ risk: 1, bug: 0.2, category: "refactor" })));

    const inside = await reviewUnits([atCap], { apiKey: "k", fetch: host.fetch });
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    // Exactly at the cap every entry and the richer note survive: nothing is pruned.
    expect(JSON.stringify(host.log[0].request.state)).toHaveLength(MAX_STATE_CHARS);
    expect(host.log[0].request.state.callFlow).toEqual([entry]);
    expect(inside.items[0].judgment).toBeDefined();
    expect(inside.items[0].routing).toBeUndefined();

    const beyond = await reviewUnits([overCap], { apiKey: "k", fetch: host.fetch });
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    expect(beyond.modelCalls).toBe(0);
    expect(beyond.items[0].judgment).toBeUndefined();
    // One character more than the cap is over the cap, and the item says by how much.
    expect(beyond.items[0].routing).toEqual({
      evaluation: "not_evaluated",
      reasonCode: "context_limit_exceeded",
      requiredChars: MAX_STATE_CHARS + 1,
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
    expect(host.log).toHaveLength(JUDGMENT_RUNS);
    expect(rejected.items[0].routing?.requiredChars).toBe(stateCharsOf(quotes));
  });

  test("measures an essential overflow as the no-flow state, not the supplied context", async () => {
    const withoutFlow = unitAtEssentialChars(MAX_STATE_CHARS + 2_000);
    const withFlow = makeUnit({
      id: "boundary",
      file: "src/boundary.ts",
      diff: withoutFlow.diff,
      callFlow: oversizedFlow(),
    });
    const host = installFetch(() => {
      throw new Error("the model must not be called for this hunk");
    });

    const result = await reviewUnits([withFlow], { apiKey: "k", fetch: host.fetch });

    expect(host.log).toHaveLength(0);
    // Every optional entry is omitted before the state is measured, so neither the
    // extra context nor the longer enriched note inflates the reported size.
    expect(stateCharsOf(withFlow)).toBe(MAX_STATE_CHARS + 2_000);
    expect(stateCharsOf(withFlow)).toBe(stateCharsOf(withoutFlow));
    const state = buildJevState(withFlow);
    expect(state.callFlow).toBeUndefined();
    expect(result.items[0].routing).toEqual({
      evaluation: "not_evaluated",
      reasonCode: "context_limit_exceeded",
      requiredChars: stateCharsOf(withoutFlow),
      limitChars: MAX_STATE_CHARS,
    });
    expect(result.items[0].reasons.join(" ")).toMatch(/every optional call-flow entry was omitted/u);
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
      // model never saw, and no confidence or needs-human field appears.
      expect(Object.hasOwn(item, "judgment")).toBe(false);
      expect(JSON.stringify(item)).not.toMatch(/"judgment"|"confidence"|"needsHuman"/u);
      expect(item.routing).toEqual({
        evaluation: "not_evaluated",
        reasonCode: "context_limit_exceeded",
        requiredChars: stateCharsOf(oversized),
        limitChars: MAX_STATE_CHARS,
      });
      expect(item.routing?.requiredChars).toBe(MAX_STATE_CHARS + 1);
      expect(item.reasons.join(" ")).toContain(String(MAX_STATE_CHARS));
      expect(item.reasons.join(" ")).not.toMatch(/needs human|confidence/iu);
    } finally {
      restore();
    }
  });
});

describe("uncertainty gates", () => {
  test("uncertain context cannot be auto-passed despite a low bug score", async () => {
    const host = installFetch(() => new Response(answerBody({ risk: 0, bug: 0.05, category: "refactor", needsHuman: 0.5 })));
    const result = await reviewUnits([makeUnit({ id: "context", diff: CODE_HUNK })], { apiKey: "test-key", fetch: host.fetch });
    expect(result.items[0].status).toBe("uncertain");
  });
  test("uses raw probability floors, gray bands, and insufficient context rather than vendor confidence", async () => {
    const units = [
      makeUnit({ id: "conf", file: "src/conf.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "gray", file: "src/gray.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "split", file: "src/split.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "human", file: "src/human.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "attn", file: "src/attn.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = scriptedFetch({
      "src/conf.ts": {
        risk: 3, bug: 0.8, category: "security", confidence: 0.4,
        categoryProbability: TOP_CATEGORY_PROBABILITY_FLOOR,
        topLevelProbability: TOP_LEVEL_PROBABILITY_FLOOR,
      },
      "src/gray.ts": { risk: 2, bug: 0.5, category: "bug-risk" },
      "src/split.ts": { risk: 2, bug: 0.8, category: "bug-risk", topLevelProbability: 0.35 },
      "src/human.ts": { risk: 3, bug: 0.8, category: "api-change", needsHuman: 0.8 },
      "src/attn.ts": { risk: 3, bug: 0.8, category: "security" },
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "conf").status).toBe("attention");
    expect(itemById(result.items, "gray").status).toBe("uncertain");
    expect(itemById(result.items, "split").status).toBe("uncertain");
    expect(itemById(result.items, "human").status).toBe("uncertain");
    expect(itemById(result.items, "attn").status).toBe("attention");
    expect(result.items[0].id).toBe("attn");
    expect(result.items.map((item) => item.status)).toEqual([
      "attention",
      "attention",
      "uncertain",
      "uncertain",
      "uncertain",
    ]);
  });

  test("a category vote with no clear winner escalates instead of ranking as attention", async () => {
    const base = answersOf({ risk: 3, bug: 0.9, category: "security" });
    // Same answers, but the category distribution is spread across the options:
    // none of them stands out, so the routing decision is not this run's to make.
    const flatCategory = {
      ...base,
      category: {
        type: "choice",
        choice: "security",
        probabilities: Object.fromEntries(REVIEW_CATEGORIES.map((option) => [option, 0.1])),
        confidence: 0.9,
      },
    };
    const host = bodyFetch({ "src/mixed.ts": JSON.stringify({ model: JEV_MODEL, answers: flatCategory }) });

    const result = await reviewUnits(
      [makeUnit({ id: "mixed", file: "src/mixed.ts", diff: CODE_HUNK, added: 1 })],
      { apiKey: "k", fetch: host.fetch },
    );

    const item = itemById(result.items, "mixed");
    expect(item.status).toBe("uncertain");
    // The judgment is still reported: escalation changes the route, not the answers.
    expect(item.judgment?.bug).toBeCloseTo(0.9);
  });
});

describe("failing closed", () => {
  test("fails closed per hunk on HTTP errors and never echoes the response body", async () => {
    const units = [
      makeUnit({ id: "server-error", file: "src/server.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "unauthorized", file: "src/auth.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "network", file: "src/net.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = installFetch((request) => {
      if (request.state.file === "src/server.ts") {
        return new Response(SECRET_BODY, { status: 500 });
      }
      if (request.state.file === "src/auth.ts") {
        return new Response(SECRET_BODY, { status: 401 });
      }
      return Promise.reject(new Error(SECRET_BODY));
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });
    const output = [
      ...result.warnings,
      ...result.items.flatMap((item) => item.reasons),
    ].join(" | ");

    expect(result.modelCalls).toBe(7);
    expect(failureWarnings(result.warnings)).toHaveLength(3);
    expect(output).not.toContain(SECRET_BODY);
    for (const item of result.items) {
      expect(item.status).toBe("uncertain");
      expect(item.judgment).toBeUndefined();
    }
    expect(output).toContain("HTTP 500");
    expect(output).toContain("HTTP 401");
    expect(output).toContain(JEV_API_KEY_ENV);
  });

  test("fails closed per hunk on malformed answers", async () => {
    const base = answersOf({ risk: 2, bug: 0.4, category: "bug-risk" });
    const cases = {
      "src/missing.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: {
          impact_risk: base["impact_risk"],
          likely_bug: base["likely_bug"],
          needs_human: base["needs_human"],
        },
      }),
      "src/wrong-type.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: { ...base, impact_risk: { type: "noul", noul: 0.5 } },
      }),
      "src/out-of-range.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: { ...base, likely_bug: { type: "noul", noul: 1.4 } },
      }),
      "src/bad-sum.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: {
          ...base,
          impact_risk: {
            type: "score",
            score: 2,
            probabilities: { "0": 0.2, "1": 0.2 },
            confidence: 0.9,
          },
        },
      }),
      "src/bad-category.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: {
          ...base,
          category: {
            type: "choice",
            choice: "nonsense",
            probabilities: { nonsense: 1 },
            confidence: 0.9,
          },
        },
      }),
      "src/text-field.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: { ...base, impact_risk: { type: "score", score: SECRET_ANSWER_TEXT, confidence: 0.9 } },
      }),
      // The score has to be the probability-weighted mean of its own levels.
      "src/score-disagrees.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: {
          ...base,
          impact_risk: {
            type: "score",
            score: 3,
            probabilities: { "0": 0.2, "1": 0.8 },
            confidence: 0.9,
          },
        },
      }),
      // The chosen option has to be the distribution's highest-probability option.
      "src/loser-choice.ts": JSON.stringify({
        model: JEV_MODEL,
        answers: {
          ...base,
          category: {
            type: "choice",
            choice: "style",
            probabilities: { style: 0.1, security: 0.9 },
            confidence: 0.9,
          },
        },
      }),
    };
    const units = Object.keys(cases).map((file, index) =>
      makeUnit({ id: `bad-${index}`, file, diff: CODE_HUNK, added: 1 }),
    );
    const host = bodyFetch(cases);

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });
    const output = [
      ...result.warnings,
      ...result.items.flatMap((item) => item.reasons),
    ].join(" | ");

    expect(result.modelCalls).toBe(units.length);
    expect(host.log).toHaveLength(units.length);
    expect(failureWarnings(result.warnings)).toHaveLength(units.length);
    expect(output).not.toContain(SECRET_ANSWER_TEXT);
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
      makeUnit({ id: "large", file: "src/big.ts", diff: largeHunk(), added: 10 }),
      makeUnit({ id: "deletion", file: "src/old.ts", diff: deletionHunk(), added: 0, removed: 3 }),
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
    expect(first.items.map((item) => item.id)).toEqual([
      "risky",
      "large",
      "deletion",
      "medium",
      "tiny",
      "blank",
    ]);
    expect(first.items.map((item) => item.status)).toEqual([
      "attention",
      "attention",
      "uncertain",
      "low",
      "low",
      "passed",
    ]);
    expect(itemById(first.items, "risky").judgment?.category).toBe("security");
    expect(itemById(first.items, "tiny").reasons.join(" ")).toContain("mock mode");
    expect(second.items).toEqual(first.items);
  });
});

describe("api key handling", () => {
  test("uses the environment key as a fallback and prefers the explicit option", async () => {
    const restore = withMissingApiKeyEnv();
    try {
      process.env[JEV_API_KEY_ENV] = "env-key-value";
      const fromEnvironment = scriptedFetch({ "src/a.ts": { risk: 1, bug: 0.2, category: "refactor" } });
      await reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK, added: 1 })], {
        fetch: fromEnvironment.fetch,
      });
      expect(fromEnvironment.log[0].authorization).toBe("Bearer env-key-value");

      const explicit = scriptedFetch({ "src/a.ts": { risk: 1, bug: 0.2, category: "refactor" } });
      await reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK, added: 1 })], {
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
      const needed = installFetch(() => new Response(answerBody({ risk: 1, bug: 0.2, category: "refactor" })));
      await expect(
        reviewUnits([makeUnit({ id: "a", file: "src/a.ts", diff: CODE_HUNK, added: 1 })], {
          fetch: needed.fetch,
        }),
      ).rejects.toThrow(/TYPESAFE_API_KEY/u);
      expect(needed.log).toHaveLength(0);

      const skipped = installFetch(() => {
        throw new Error("no hunk here needs the model");
      });
      const result = await reviewUnits(
        [
          makeUnit({ id: "no-op", diff: "@@ -1,2 +1,2 @@\n const a = 1;" }),
          makeUnit({ id: "binary", file: "a.png", diff: "Binary files differ", special: "binary" }),
        ],
        { fetch: skipped.fetch },
      );
      expect(skipped.log).toHaveLength(0);
      expect(result.modelCalls).toBe(0);
      expect(result.items.map((item) => item.status)).toEqual(["uncertain", "passed"]);
    } finally {
      restore();
    }
  });
});

describe("live request bounds", () => {
  test("keeps at most the configured number of requests in flight", async () => {
    const files = ["a", "b", "c", "d", "e", "f"].map((name) => `src/${name}.ts`);
    const units = files.map((file) => makeUnit({ id: file, file, diff: CODE_HUNK, added: 1 }));
    // The pool starts its workers synchronously, so every worker reaches its first
    // request before any response can resolve. Counting in-flight calls therefore
    // measures the pool exactly, with no timers and no guessed durations.
    let inFlight = 0;
    let peak = 0;
    const host = installFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(answerBody({ risk: 1, bug: 0.2, category: "refactor" }), { status: 200 });
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(result.modelCalls).toBe(files.length * JUDGMENT_RUNS);
    expect(result.items).toHaveLength(files.length);
    expect(peak).toBe(MAX_CONCURRENT_REQUESTS);
  });
});

describe("transient failures", () => {
  const KEY = "retry-key-9f2";

  /**
   * A retryable status with a zero retry-after, so the retry path runs with no
   * wall-clock wait and the test measures the policy, not the clock.
   */
  function transientFetch(...statuses: number[]): FetchHost {
    let next = 0;
    return installFetch(() => {
      const status = statuses[next] ?? 200;
      next += 1;
      return status === 200
        ? new Response(answerBody({ risk: 3, bug: 0.8, category: "security" }), { status })
        : new Response(SECRET_BODY, { status, headers: { "retry-after": "0" } });
    });
  }

  test("retries a rate-limited hunk while counting retries and independent runs", async () => {
    const host = transientFetch(429, 200);
    const units = [makeUnit({ id: "limited", file: "src/limited.ts", diff: CODE_HUNK, added: 1 })];

    const result = await reviewUnits(units, { apiKey: KEY, fetch: host.fetch });

    expect(host.log).toHaveLength(JUDGMENT_RUNS + 1);
    expect(result.modelCalls).toBe(JUDGMENT_RUNS + 1);
    // The only warning class here would be a failure note; the per-hunk loop log
    // is expected and is not one.
    expect(failureWarnings(result.warnings)).toEqual([]);
    expect(itemById(result.items, "limited").status).toBe("attention");
    // Every attempt keeps the key in the header, never in the body.
    for (const entry of host.log) {
      expect(entry.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(entry.request)).not.toContain(KEY);
    }
  });

  test("gives up after the documented attempt count and still fails closed", async () => {
    const host = transientFetch(500, 503, 529);
    const units = [makeUnit({ id: "down", file: "src/down.ts", diff: CODE_HUNK, added: 1 })];

    const result = await reviewUnits(units, { apiKey: KEY, fetch: host.fetch });
    const output = [...result.warnings, ...result.items[0].reasons].join(" | ");

    expect(host.log).toHaveLength(JEV_RETRY.maxAttempts);
    expect(result.modelCalls).toBe(3);
    expect(failureWarnings(result.warnings)).toHaveLength(1);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].judgment).toBeUndefined();
    expect(output).not.toContain(SECRET_BODY);
    expect(output).not.toContain(KEY);
  });

  test("never retries a definitive rejection", async () => {
    const host = transientFetch(401);
    const units = [makeUnit({ id: "denied", file: "src/denied.ts", diff: CODE_HUNK, added: 1 })];

    const result = await reviewUnits(units, { apiKey: KEY, fetch: host.fetch });

    expect(host.log).toHaveLength(1);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].reasons.join(" ")).toContain("HTTP 401");
  });

  test("backs off exponentially with bounded jitter before exhausting retries", async () => {
    const waits: number[] = [];
    const host = installFetch(() => new Response(SECRET_BODY, { status: 503 }));
    const client = new JevClient(KEY, host.fetch, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });

    await expect(
      client.judge(buildJevState(makeUnit({ id: "retry", file: "src/retry.ts", diff: CODE_HUNK }))),
    ).rejects.toBeInstanceOf(JevRequestError);

    expect(host.log).toHaveLength(JEV_RETRY.maxAttempts);
    expect(waits).toHaveLength(JEV_RETRY.maxAttempts - 1);
    for (const [index, delay] of waits.entries()) {
      const ceiling = JEV_RETRY.backoffInitialMs * 2 ** index;
      expect(delay).toBeGreaterThanOrEqual(ceiling * (1 - JEV_RETRY.jitterFraction) - 1);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  test("honors HTTP-date and millisecond retry delays without retrying early", async () => {
    let now = Date.parse("2026-09-18T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const waits: number[] = [];
    let attempt = 0;
    const host = installFetch(() => {
      attempt += 1;
      if (attempt === 1) return new Response("", {
        status: 429, headers: { "retry-after": new Date(now + 8_000).toUTCString() },
      });
      if (attempt === 2) return new Response("", {
        status: 529, headers: { "retry-after-ms": "250", "retry-after": "20" },
      });
      return new Response(answerBody({ risk: 1, bug: 0.1, category: "refactor" }));
    });
    const client = new JevClient(KEY, host.fetch, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    try {
      const result = await client.judge(buildJevState(makeUnit({ id: "dates", diff: CODE_HUNK })));
      expect(result.judgment.category).toBe("refactor");
      expect(waits).toEqual([8_000, 250]);
      expect(client.requestCount).toBe(JUDGMENT_RUNS + 2);
    } finally {
      clock.mockRestore();
    }
  });

  test("fails closed rather than shortening a server delay beyond the total budget", async () => {
    const host = installFetch(() => new Response(SECRET_BODY, {
      status: 429, headers: { "retry-after": "120" },
    }));
    const result = await reviewUnits(
      [makeUnit({ id: "long-delay", diff: CODE_HUNK })], { apiKey: KEY, fetch: host.fetch },
    );
    expect(host.log).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
    expect(result.items[0].status).toBe("uncertain");
    expect(result.items[0].judgment).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("does not start another request after its total deadline", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const host = transientFetch(503, 200);
    const client = new JevClient(KEY, host.fetch, async () => { now += JEV_RETRY.totalTimeoutMs; });
    try {
      await expect(client.judge(buildJevState(makeUnit({ id: "expired", diff: CODE_HUNK }))))
        .rejects.toBeInstanceOf(JevRequestError);
      expect(host.log).toHaveLength(1);
      expect(client.requestCount).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});

function fillerHunk(lines: number): string {
  const body = Array.from({ length: lines }, (_value, index) => `+const value${index} = ${index};`);
  return ["@@ -1 +1 @@", ...body].join("\n");
}

function largeHunk(): string {
  return fillerHunk(10);
}

function deletionHunk(): string {
  return "@@ -1,3 +1 @@\n-const a = 1;\n-const b = 2;\n-const c = 3;";
}
