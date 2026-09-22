import { describe, expect, test } from "vitest";
import { MAX_STATE_CHARS } from "../src/review/context-limits.js";
import {
  ContextPlan,
  INITIAL_STATE_CHARS,
  MAX_ADDED_CONTEXT_BYTES,
  MAX_CONTEXT_NODES,
} from "../src/review/context-plan.js";
import type { JevState } from "../src/review/jev.js";
import type { ReviewContextNode } from "../src/review/types.js";

const BASE_NOTE =
  "No call flow is included. Caller arguments, parameter mappings, and caller contracts may be " +
  "unavailable. Absence of call-flow evidence establishes neither safety nor a defect; needs_human " +
  "concerns missing information necessary to assess this change.";

function baseState(diff = "@@ -1 +1 @@\n-const before = 1;\n+const after = 2;"): JevState {
  return { file: "src/app.ts", hunk: "@@ -1 +1 @@", diff, contextNote: BASE_NOTE };
}

/** Base state whose serialized length is `chars`, so cap behavior is exact. */
function baseOfChars(chars: number): JevState {
  const empty = baseState("");
  const filler = chars - JSON.stringify(empty).length;
  return baseState("x".repeat(Math.max(0, filler)));
}

function node(key: string, detail: string, line = 1): ReviewContextNode {
  return { key, label: `${key.split(":")[1]}()`, file: "src/app.ts", line, detail };
}

function manyNodes(count: number, detail: string): ReviewContextNode[] {
  return Array.from({ length: count }, (_value, index) => node(`after:node${index}`, detail, index + 1));
}

function stateChars(state: JevState): number {
  return JSON.stringify(state).length;
}

function stateBytes(state: JevState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

describe("initial context", () => {
  test("keeps what does not fit visible as a descriptor without its detail", () => {
    const detail = "d".repeat(7_000);
    const plan = new ContextPlan(baseState(), [node("after:a", detail), node("after:b", detail), node("after:c", detail)]);
    const nodes = plan.state.contextNodes!;

    expect(nodes.map(entry => entry.key)).toEqual(["after:a", "after:b", "after:c"]);
    expect(nodes.map(entry => entry.collapsed)).toEqual([false, true, true]);
    // A collapsed descriptor is addressable by identity and carries no hidden
    // copy of the text: the detail key is absent, not empty or shortened.
    expect(nodes[0]).toEqual({ key: "after:a", label: "a()", file: "src/app.ts", line: 1, collapsed: false, detail });
    for (const entry of nodes.slice(1)) {
      expect(entry).toEqual({ key: entry.key, label: entry.label, file: entry.file, line: entry.line, collapsed: true });
      expect(Object.hasOwn(entry, "detail")).toBe(false);
    }
    expect(plan.collapsedKeys).toEqual(["after:b", "after:c"]);
    // Initial evidence is admitted against the initial target only, so the plan
    // starts with nothing charged to the added-byte budget.
    expect(plan.addedBytes).toBe(0);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(INITIAL_STATE_CHARS);
  });

  test("keeps its own caveats when it replaces the no-flow note", () => {
    const plan = new ContextPlan(baseState(), [node("after:a", "a".repeat(100))]);
    const note = plan.state.contextNote;
    expect(note).not.toBe(BASE_NOTE);
    expect(note).toMatch(/syntactic/i);
    expect(note).toMatch(/snapshot/i);
    expect(note).toMatch(/not complete caller contracts/i);
    expect(note).toMatch(/establishes neither safety nor a defect/i);
    expect(note).toMatch(/needs_human/);
    expect(note).toMatch(/collapsed/);
  });

  test("leaves a base state with no nodes exactly as it was", () => {
    const base = baseState();
    const plan = new ContextPlan(base, []);
    expect(plan.state).toBe(base);
    expect(plan.collapsedKeys).toEqual([]);
    expect(plan.expand(["after:a"])).toEqual([]);
    expect(plan.addedBytes).toBe(0);
  });

  test("reports nodes beyond the key limit instead of listing them", () => {
    const supplied = manyNodes(12, "d");
    const plan = new ContextPlan(baseState(), supplied);
    const nodes = plan.state.contextNodes!;
    expect(nodes).toHaveLength(MAX_CONTEXT_NODES);
    expect(nodes.map(entry => entry.key)).toEqual(supplied.slice(0, MAX_CONTEXT_NODES).map(entry => entry.key));
    expect(plan.state.contextNote).toContain(`4 beyond the ${MAX_CONTEXT_NODES}-node key limit`);
    expect(plan.state.contextNote).toContain("They are not listed here and cannot be expanded");
    // A node that never got a descriptor cannot be addressed at all.
    expect(plan.expand(["after:node8", "after:node11"])).toEqual([]);
    expect(plan.collapsedKeys).toEqual(nodes.filter(entry => entry.collapsed).map(entry => entry.key));
  });

  test("keeps the essentials intact when the longer note alone would exceed the cap", () => {
    // Essentials 100 characters below the cap: not even the structured caveat
    // fits beside them, so optional context must cost nothing at all.
    const base = baseOfChars(MAX_STATE_CHARS - 100);
    const supplied = manyNodes(4, "d".repeat(5_000));
    const plan = new ContextPlan(base, supplied);
    expect(plan.state).toBe(base);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(plan.state.contextNodes).toBeUndefined();
    expect(plan.state.contextNote).toBe(BASE_NOTE);
    expect(plan.expand(supplied.map(entry => entry.key))).toEqual([]);
    expect(plan.addedBytes).toBe(0);
  });

  test("falls back to the base state when nothing, not even a descriptor, fits", () => {
    // No node counts in this scenario, so the only note the plan could ship is
    // the caveat plus a size clause; that clause alone does not fit here.
    const base = baseOfChars(MAX_STATE_CHARS - 1_100);
    const supplied = manyNodes(4, "d".repeat(5_000));
    const plan = new ContextPlan(base, supplied);
    expect(plan.state).toBe(base);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(plan.state.contextNote).toBe(BASE_NOTE);
    expect(plan.state.contextNodes).toBeUndefined();
    expect(plan.collapsedKeys).toEqual([]);
    expect(plan.expand(supplied.map(entry => entry.key))).toEqual([]);
    expect(plan.addedBytes).toBe(0);
  });

  test("counts the descriptors the size limit dropped, and drops them for good", () => {
    const supplied = manyNodes(MAX_CONTEXT_NODES, "d".repeat(5_000));
    const plan = new ContextPlan(baseOfChars(MAX_STATE_CHARS - 1_500), supplied);
    const nodes = plan.state.contextNodes ?? [];
    const dropped = supplied.filter(entry => !nodes.some(carried => carried.key === entry.key));
    expect(nodes.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(plan.state.contextNote).toContain(
      `${dropped.length} whose descriptor did not fit the ${MAX_STATE_CHARS}-character state limit`,
    );
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(plan.collapsedKeys).toEqual(nodes.map(entry => entry.key));
    for (const entry of dropped) expect(plan.expand([entry.key])).toEqual([]);
    expect(plan.addedBytes).toBe(0);
  });
});

describe("expansion", () => {
  test("expands exactly the requested keys, once, and only forward", () => {
    const plan = new ContextPlan(baseState(), manyNodes(3, "d".repeat(7_000)));
    const initial = stateChars(plan.state);
    const [second, third] = ["after:node1", "after:node2"];

    expect(plan.state.contextNodes!.map(entry => entry.collapsed)).toEqual([false, true, true]);
    expect(plan.expand([second])).toEqual([second]);
    expect(plan.state.contextNodes!.map(entry => entry.collapsed)).toEqual([false, false, true]);
    expect(plan.state.contextNodes![1].detail).toBe("d".repeat(7_000));
    // Repeating an expanded key, or naming one that was never listed, changes nothing.
    expect(plan.expand([second, "after:missing"])).toEqual([]);
    expect(plan.collapsedKeys).toEqual([third]);

    expect(plan.expand([third])).toEqual([third]);
    expect(plan.collapsedKeys).toEqual([]);
    expect(plan.state.contextNodes!.every(entry => entry.collapsed === false)).toBe(true);
    // The initial key is still expanded: expansion is append-only evidence.
    expect(plan.state.contextNodes![0].detail).toBe("d".repeat(7_000));
    expect(plan.addedBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    expect(stateBytes(plan.state) - initial).toBeLessThanOrEqual(plan.addedBytes);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });

  test("carries the whole detail, unicode and escapes included", () => {
    const detail = `const café = "\\n";\n${"é".repeat(2_000)}${"x".repeat(10_600)}`;
    const plan = new ContextPlan(baseState(), [node("after:café", detail)]);
    const initialChars = stateChars(plan.state);
    const initialBytes = stateBytes(plan.state);
    expect(plan.state.contextNodes![0].collapsed).toBe(true);

    expect(plan.expand(["after:café"])).toEqual(["after:café"]);
    const expanded = plan.state.contextNodes![0];
    expect(expanded.collapsed).toBe(false);
    // Nothing is trimmed, re-escaped, or normalized on the way in.
    expect(expanded.detail).toBe(detail);
    // The budget is charged the serialized UTF-8 bytes of the field, wrapper
    // included, which is never less than the state actually grew.
    expect(plan.addedBytes).toBe(Buffer.byteLength(JSON.stringify({ detail }), "utf8"));
    expect(stateBytes(plan.state) - initialBytes).toBeLessThanOrEqual(plan.addedBytes);
    // The charge is measured in bytes, not UTF-16 characters: the multi-byte
    // detail costs more of the budget than the character count it added.
    expect(plan.addedBytes).toBeGreaterThan(stateChars(plan.state) - initialChars);
    expect(JSON.stringify(plan.state)).toContain("café");
  });

  test("refuses a detail that cannot fit the added-byte budget, with zero progress", () => {
    const oversized = "x".repeat(MAX_ADDED_CONTEXT_BYTES + 200);
    const medium = "d".repeat(13_000);
    const plan = new ContextPlan(baseState(), [node("after:big", oversized), node("after:medium", medium)]);
    const before = JSON.stringify(plan.state);
    expect(plan.state.contextNodes!.map(entry => entry.collapsed)).toEqual([true, true]);

    expect(plan.expand(["after:big"])).toEqual([]);
    expect(JSON.stringify(plan.state)).toBe(before);
    expect(plan.addedBytes).toBe(0);
    expect(plan.collapsedKeys).toEqual(["after:big", "after:medium"]);

    // The budget is a ceiling, not a target: what does fit is still admitted,
    // and the invariant holds after it is.
    expect(plan.expand(["after:medium"])).toEqual(["after:medium"]);
    expect(plan.addedBytes).toBe(Buffer.byteLength(JSON.stringify({ detail: medium }), "utf8"));
    expect(plan.addedBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });

  test("stops asking once the whole state reaches its cap", () => {
    const plan = new ContextPlan(baseOfChars(MAX_STATE_CHARS - 4_000), manyNodes(4, "d".repeat(19_000)));
    const admitted = plan.collapsedKeys;
    expect(admitted).toEqual(plan.state.contextNodes!.map(entry => entry.key));
    for (const key of admitted) expect(plan.expand([key])).toEqual([]);
    expect(plan.addedBytes).toBe(0);
    expect(stateChars(plan.state)).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });
});
