import { describe, expect, test, vi } from "vitest";
import {
  JEV_API_KEY_ENV,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_RETRY,
  JevClient,
  JevRequestError,
  MAX_STATE_CHARS,
  REVIEW_CATEGORIES,
  buildJevState,
  type JevObject,
  type JevRequest,
  type ReviewCategory,
} from "../src/review/jev.js";
import {
  MAX_CONCURRENT_REQUESTS,
  MOCK_MODE_WARNING,
  reviewUnits,
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
  /**
   * Weight on the most likely category. Defaults to `confidence`, but a case
   * that isolates the confidence gate needs a settled category vote and a low
   * confidence at the same time.
   */
  readonly categoryProbability?: number;
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
  const riskProbabilities = distribution(
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
      probabilities: distribution(spec.category, REVIEW_CATEGORIES, spec.categoryProbability ?? confidence),
      confidence,
    },
    needs_human: { type: "noul", noul: spec.needsHuman ?? 0.2 },
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

    expect(result.modelCalls).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(["high", "mid", "clean"]);
    expect(result.items.map((item) => item.status)).toEqual(["attention", "low", "low"]);
    // Scores 2.4 / 1.2 / 0.6 x 50 + bug x 30 + needs-human x 20 + the category boost.
    expect(result.items.map((item) => item.priority)).toEqual([79, 30, 15]);

    expect(host.log).toHaveLength(3);
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
    ]);
    expect(request.questions.impact_risk.type).toBe("score");
    expect(request.questions.impact_risk.criteria).toHaveLength(RISK_LEVEL_KEYS.length);
    expect(request.questions.likely_bug.type).toBe("noul");
    expect(request.questions.needs_human.type).toBe("noul");
    expect(request.questions.category.type).toBe("choice");
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
    expect(host.log).toHaveLength(1);
  });
});

describe("deterministic passes", () => {
  test("increment and decrement code is never mistaken for patch file headers", async () => {
    const host = installFetch(() => new Response(answerBody({ risk: 2, bug: 0.8, category: "bug-risk" })));
    const result = await reviewUnits([
      makeUnit({ id: "operators", diff: "@@ -1 +1 @@\n---counter;\n+++counter;", added: 1, removed: 1 }),
    ], { apiKey: "test-key", fetch: host.fetch });
    expect(result.items[0].status).toBe("attention");
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

describe("uncertainty gates", () => {
  test("uncertain context cannot be auto-passed despite a low bug score", async () => {
    const host = installFetch(() => new Response(answerBody({ risk: 0, bug: 0.05, category: "refactor", needsHuman: 0.5 })));
    const result = await reviewUnits([makeUnit({ id: "context", diff: CODE_HUNK })], { apiKey: "test-key", fetch: host.fetch });
    expect(result.items[0].status).toBe("uncertain");
  });
  test("fires on low confidence, a gray-band bug probability, a split risk vote, and insufficient context", async () => {
    const units = [
      makeUnit({ id: "conf", file: "src/conf.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "gray", file: "src/gray.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "split", file: "src/split.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "human", file: "src/human.ts", diff: CODE_HUNK, added: 1 }),
      makeUnit({ id: "attn", file: "src/attn.ts", diff: CODE_HUNK, added: 1 }),
    ];
    const host = scriptedFetch({
      "src/conf.ts": { risk: 3, bug: 0.8, category: "security", confidence: 0.4, categoryProbability: 0.95 },
      "src/gray.ts": { risk: 2, bug: 0.5, category: "bug-risk" },
      "src/split.ts": { risk: 2, bug: 0.8, category: "bug-risk", topLevelProbability: 0.35 },
      "src/human.ts": { risk: 3, bug: 0.8, category: "api-change", needsHuman: 0.8 },
      "src/attn.ts": { risk: 3, bug: 0.8, category: "security" },
    });

    const result = await reviewUnits(units, { apiKey: "k", fetch: host.fetch });

    expect(itemById(result.items, "conf").status).toBe("uncertain");
    expect(itemById(result.items, "gray").status).toBe("uncertain");
    expect(itemById(result.items, "split").status).toBe("uncertain");
    expect(itemById(result.items, "human").status).toBe("uncertain");
    expect(itemById(result.items, "attn").status).toBe("attention");
    expect(result.items[0].id).toBe("attn");
    expect(result.items.map((item) => item.status)).toEqual([
      "attention",
      "uncertain",
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
    expect(item.judgment?.category).toBe("security");
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
    expect(result.warnings).toHaveLength(3);
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
    expect(result.warnings).toHaveLength(units.length);
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

    expect(result.modelCalls).toBe(files.length);
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

  test("retries a rate-limited hunk while counting both HTTP attempts", async () => {
    const host = transientFetch(429, 200);
    const units = [makeUnit({ id: "limited", file: "src/limited.ts", diff: CODE_HUNK, added: 1 })];

    const result = await reviewUnits(units, { apiKey: KEY, fetch: host.fetch });

    expect(host.log).toHaveLength(2);
    expect(result.modelCalls).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(itemById(result.items, "limited").status).toBe("attention");
    // The retry repeats the same request; the key stays in the header, not the body.
    expect(JSON.stringify(host.log[0].request)).toBe(JSON.stringify(host.log[1].request));
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
    expect(result.warnings).toHaveLength(1);
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
      expect(client.requestCount).toBe(3);
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
