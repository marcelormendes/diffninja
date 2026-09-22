import { describe, expect, test } from "vitest";
import { MAX_STATE_CHARS } from "../src/review/context-limits.js";
import { MAX_CONTEXT_NODES, buildContextState } from "../src/review/context-plan.js";
import { buildJevState, type JevState } from "../src/review/jev.js";
import type { ReviewContextNode, ReviewUnit } from "../src/review/types.js";

/**
 * Context selection is deterministic and runs before the single request: the
 * base state plus as many whole nodes as fit, in the order the extractor supplied
 * them. Nothing here pins source text; the contracts are the admitted set, its
 * order, the fact that a carried node is never shortened, the serialized bound,
 * and the fallback that keeps the essentials.
 */

function unit(diff = "@@ -1 +1 @@\n-const before = 1;\n+const after = 2;"): ReviewUnit {
  return {
    id: "hunk",
    file: "src/app.ts",
    header: "@@ -1 +1 @@",
    diff,
    added: 1,
    removed: 1,
    oldStart: 1,
    newStart: 1,
  };
}

function baseState(diff = "@@ -1 +1 @@\n-const before = 1;\n+const after = 2;"): JevState {
  return buildJevState(unit(diff));
}

/** Base state plus `filler` characters of diff; each one costs one serialized character. */
function baseOfFiller(filler: number): JevState {
  return baseState(`@@ -1 +1 @@\n-const before = 1;\n+const after = 2;\n+${"x".repeat(filler)}`);
}

/** Number of serialized characters the base adds before any diff filler. */
const FILLED_BASE = stateSize(baseOfFiller(0));

/**
 * Base whose state, carrying `nodes` whole, is exactly `chars` characters. Each
 * diff filler character costs exactly one serialized character, so the filler is
 * computed from the measured size at zero filler and then verified: a boundary
 * test cannot quietly measure a different size.
 */
function baseAtSize(chars: number, nodes: readonly ReviewContextNode[]): JevState {
  const zero = stateSize(buildContextState(baseOfFiller(0), nodes));
  const base = baseOfFiller(chars - zero);
  const actual = stateSize(buildContextState(base, nodes));
  if (actual !== chars) throw new Error(`fixture state is ${actual} serialized characters, not ${chars}`);
  return base;
}

function node(key: string, detail: string, line = 1): ReviewContextNode {
  return { key, label: `${key.split(":")[1]}()`, file: "src/app.ts", line, detail };
}

function manyNodes(count: number, detail: string): ReviewContextNode[] {
  return Array.from({ length: count }, (_value, index) => node(`after:node${index}`, detail, index + 1));
}

function stateSize(state: JevState): number {
  return JSON.stringify(state).length;
}

describe("deterministic context selection", () => {
  test("carries whole nodes in the supplied order and drops what does not fit", () => {
    const detail = "d".repeat(9_000);
    const supplied = [node("after:a", detail), node("after:b", detail), node("after:c", detail)];

    const state = buildContextState(baseState(), supplied);
    const carried = state.contextNodes ?? [];

    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThan(supplied.length);
    // Supplied priority order, prefix only: nothing was reordered or spliced.
    expect(carried.map((entry) => entry.key)).toEqual(
      supplied.slice(0, carried.length).map((entry) => entry.key),
    );
    // Every carried node is the whole node: never a preview and never shortened.
    for (const entry of carried) {
      expect(entry.detail).toBe(supplied.find((given) => given.key === entry.key)?.detail);
    }
    expect(stateSize(state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    // The omission is stated with its count, not implied.
    expect(state.contextNote).toContain(`${supplied.length - carried.length} that did not fit`);
  });

  test("leaves a base state with no nodes exactly as it was", () => {
    const base = baseState();
    const state = buildContextState(base, []);
    expect(state).toBe(base);
    expect(state.contextNodes).toBeUndefined();
  });

  test("keeps the base state when not even one node fits", () => {
    const base = baseOfFiller(MAX_STATE_CHARS - FILLED_BASE - 100);
    const state = buildContextState(base, manyNodes(4, "d".repeat(5_000)));
    // Optional context never crowds out the essentials, and the note is not
    // replaced by one promising a node the state cannot carry.
    expect(state).toBe(base);
    expect(state.contextNodes).toBeUndefined();
    expect(stateSize(state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });

  test("considers at most the node limit and counts what it left out", () => {
    const supplied = manyNodes(12, "d".repeat(10));
    const state = buildContextState(baseState(), supplied);
    const carried = state.contextNodes ?? [];

    expect(carried).toHaveLength(MAX_CONTEXT_NODES);
    expect(carried.map((entry) => entry.key)).toEqual(
      supplied.slice(0, MAX_CONTEXT_NODES).map((entry) => entry.key),
    );
    expect(state.contextNote).toContain(
      `${supplied.length - MAX_CONTEXT_NODES} beyond the ${MAX_CONTEXT_NODES}-node limit`,
    );
    for (const entry of supplied.slice(MAX_CONTEXT_NODES)) {
      expect(carried.some((given) => given.key === entry.key)).toBe(false);
    }
  });

  test("collapses a repeated key instead of carrying the same node twice", () => {
    const first = node("after:dup", "first copy");
    const second = node("after:dup", "second copy");
    const state = buildContextState(baseState(), [first, second, node("after:other", "other")]);

    const carried = state.contextNodes ?? [];
    expect(carried.map((entry) => entry.key)).toEqual(["after:dup", "after:other"]);
    expect(carried[0].detail).toBe("first copy");
  });

  test("counts coexisting caller and contract source only after admission, by snapshot", () => {
    const caller: ReviewContextNode = {
      ...node("after:caller", "caller source"),
      provenance: { snapshot: "after", role: "caller", sourcePresent: true, contract: false },
    };
    const contract: ReviewContextNode = {
      ...node("after:contract", "contract source"),
      provenance: { snapshot: "after", role: "callee", sourcePresent: true, contract: true },
    };
    const before: ReviewContextNode = {
      ...contract, key: "before:contract",
      provenance: { ...contract.provenance!, snapshot: "before" },
    };
    const unreadable: ReviewContextNode = {
      ...caller, key: "after:unreadable",
      provenance: { ...caller.provenance!, sourcePresent: false },
    };
    const omitted: ReviewContextNode = { ...contract, key: "after:omitted", detail: "x".repeat(MAX_STATE_CHARS) };
    const unclassified = node("after:fake", "snapshot=after role=caller declaration-kind=interface");
    const state = buildContextState(baseState(), [caller, contract, before, unreadable, omitted, unclassified, caller]);
    expect(state.contextPresence).toEqual({
      before: { changedDefinitions: 0, callerDefinitions: 0, calleeDefinitions: 1, contracts: 1 },
      after: { changedDefinitions: 0, callerDefinitions: 1, calleeDefinitions: 1, contracts: 1 },
      unclassifiedNodes: 1,
    });
    expect(state.contextNodes?.some(entry => entry.key === omitted.key)).toBe(false);
  });


  test("carries a node that reaches the cap exactly, and drops the next character whole", () => {
    const nodes = [node("after:a", "x".repeat(50))];
    const zero = stateSize(buildContextState(baseOfFiller(0), nodes));
    const atCap = baseAtSize(MAX_STATE_CHARS, nodes);
    const fitted = buildContextState(atCap, nodes);
    expect(stateSize(fitted)).toBe(MAX_STATE_CHARS);
    expect(fitted.contextNodes).toHaveLength(1);
    expect(fitted.contextNodes?.[0].detail).toBe("x".repeat(50));

    // One character more, and the whole node no longer fits — while the
    // essentials still do, so the hunk stays judgeable on its own diff.
    const oneMore = baseOfFiller(MAX_STATE_CHARS - zero + 1);
    expect(stateSize(oneMore)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    const dropped = buildContextState(oneMore, nodes);
    expect(dropped).toBe(oneMore);
    expect(dropped.contextNodes).toBeUndefined();
  });

  test("reconsiders a skipped node after pruning the node that took its room", () => {
    // A big node fits alone; the small node does not fit beside it, and the note
    // that honestly counts one omission is longer than the note admission
    // measured. Dropping the big node must free the room for the small one
    // instead of leaving the state with no context at all.
    const big = node("after:big", "b".repeat(20_000));
    const small = node("after:small", "s".repeat(2_000));
    const supplied = [big, small];

    // The base is sized so that base + big + the shortest note fits, while
    // base + both nodes cannot, and base + small + the honest note does.
    const zeroFiller = stateSize(buildContextState(baseOfFiller(0), [big]));
    const base = baseAtSize(MAX_STATE_CHARS, [big]);
    const state = buildContextState(base, supplied);
    const carried = state.contextNodes ?? [];

    expect(zeroFiller).toBeLessThan(MAX_STATE_CHARS);
    expect(stateSize(state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    // The state kept context: it is not the bare base state the old prune produced.
    expect(state).not.toBe(base);
    expect(carried.map((entry) => entry.key)).toEqual(["after:small"]);
    expect(carried[0].detail).toBe(small.detail);
    // The honest note counts the node that was left out.
    expect(state.contextNote).toContain("1 that did not fit");
  });

  test("measures the serialized JSON, so escaping counts", () => {
    // Twelve thousand quote characters cost twenty-four thousand serialized
    // characters: a node measured by its raw length instead of its JSON length
    // would fit, and the state it produced would exceed the cap.
    const quoted = node("after:quoted", '"'.repeat(12_000));
    const plain = node("after:plain", "p".repeat(50));
    expect(quoted.detail.length).toBeLessThan(MAX_STATE_CHARS - FILLED_BASE);
    expect(JSON.stringify(quoted.detail).length).toBeGreaterThan(MAX_STATE_CHARS - FILLED_BASE);

    const state = buildContextState(baseOfFiller(0), [quoted, plain]);
    // The budget is spent in priority order and measured as sent, so the node
    // whose escaping blows the cap gives way to one that still fits whole.
    expect(state.contextNodes?.map((entry) => entry.key)).toEqual(["after:plain"]);
    expect(state.contextNote).toContain("1 that did not fit");
    expect(stateSize(state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });
});
