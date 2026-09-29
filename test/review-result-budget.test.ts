import { describe, expect, test } from "vitest";
import type { ConnectedSnapshot } from "../src/review/github.js";
import { MAX_RESULT_BYTES, boundedForAgent } from "../src/review/result-budget.js";
import type { ReviewItem, ReviewReport } from "../src/review/types.js";

function item(index: number, diffLines: number): ReviewItem {
  const diff = ["@@ -1,1 +1,1 @@", ...Array.from({ length: diffLines }, (_, line) => `+const value_${index}_${line} = compute(${line}, "${"x".repeat(60)}");`)].join("\n");
  return {
    id: `hunk-${index}`, file: `src/file${index}.ts`, header: "@@ -1,1 +1,1 @@", added: diffLines, removed: 0, oldStart: 1, newStart: 1, diff,
    status: "attention", priority: 90 - index, reasons: ["r"], callFlow: ["a -> b"], contextNodes: [],
  };
}

function report(items: ReviewItem[], claims = 0): ReviewReport {
  return {
    title: "big", source: "s", createdAt: "2026-09-28T00:00:00Z", items, callFlow: ["tree".repeat(1000)], callFlows: [], callFlowAvailability: "available", warnings: ["first"], questions: [],
    evidence: { agenda: [], findings: [], checks: [], intent: { verdict: "not-established", summary: "s", obligations: [], claims: Array.from({ length: claims }, (_, index) => ({ text: `claim ${index}`, origin: "author" as const, status: "not-established" as const, unitIds: [], explanation: "e" })) } },
  };
}

const bytes = (value: ReviewReport) => Buffer.byteLength(JSON.stringify(value));

describe("the result sent to the agent", () => {
  test("is untouched while it fits", () => {
    const small = report([item(0, 20), item(1, 20)], 5);
    const result = boundedForAgent(undefined, small);
    expect(result.report).toBe(small);
    expect(result.report.warnings).toEqual(["first"]);
  });

  test("a 20,000-line change is trimmed in a fixed order, keeps every hunk's header and the top hunks whole, and says what was left out", () => {
    const original = report(Array.from({ length: 10 }, (_, index) => item(index, 6000)), 500);
    const before = bytes(original);
    expect(before).toBeGreaterThan(MAX_RESULT_BYTES);
    const result = boundedForAgent(undefined, original);
    expect(bytes(result.report)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    // Twice on the wire (text and structured content) still fits a 10 MiB message.
    expect(bytes(result.report) * 2).toBeLessThan(10 * 1024 * 1024);
    expect(result.report.items).toHaveLength(10);
    expect(result.report.items[0]?.diff).toBe(original.items[0]?.diff);
    const last = result.report.items.at(-1);
    expect(last?.diff).toContain("left out to keep this result under 4 MiB");
    expect(last?.header).toBe("@@ -1,1 +1,1 @@");
    expect(result.report.warnings[0]).toBe("first");
    expect(result.report.warnings.at(-1)).toContain("was over 4 MiB");
    expect(result.report.warnings.at(-1)).toContain("the review page has the complete report".replace("the", "The"));
    // The caller's report is not modified: the pages and the checks of what the agent sends back use it whole.
    expect(bytes(original)).toBe(before);
    expect(original.items.at(-1)?.diff).not.toContain("left out");
    expect(original.warnings).toEqual(["first"]);
  });

  test("drops the cheap parts first: the line copy of a connected diff, call flows, extra claims", () => {
    const snapshot: ConnectedSnapshot = {
      id: "s", url: "u", owner: "o", repo: "r", number: 1, baseSha: "a", headSha: "b", state: "OPEN",
      lines: Array.from({ length: 30_000 }, (_, index) => ({ path: "src/a.ts", line: index + 1, side: "RIGHT" as const, text: "x".repeat(100), kind: "add" as const })),
    };
    const trimmed = boundedForAgent(snapshot, report([item(0, 40), item(1, 40)], 300));
    expect(trimmed.snapshot?.lines).toEqual([]);
    expect(trimmed.snapshot?.number).toBe(1);
    // Only as much as needed: the diffs are whole, and the warning names the line copy.
    expect(trimmed.report.items[0]?.diff).toBe(item(0, 40).diff);
    expect(trimmed.report.warnings.at(-1)).toContain("snapshot.lines");
    expect(trimmed.report.warnings.at(-1)).not.toContain("hunks have their diff text left out");
  });

  /** A hunk with a diff of `chars` characters on one added line and one reason of `reason` characters. */
  function small(index: number, chars: number, reason: number): ReviewItem {
    const header = "@@ -0,0 +1,1 @@";
    return {
      id: `hunk-${index}`, file: `src/f${index}.ts`, header, added: 1, removed: 0, oldStart: 0, newStart: 1,
      diff: `${header}\n+${"y".repeat(chars)}`, status: "attention", priority: 90, reasons: ["r".repeat(reason)],
    };
  }

  test("a result nothing can shrink is refused with a reason, never sent over budget under a warning that it was trimmed", () => {
    const original = { ...report([{ ...small(0, 10, 0), reasons: [] }]), callFlow: [], pr: { title: "t", body: "b".repeat(MAX_RESULT_BYTES) } };
    expect(() => boundedForAgent(undefined, original)).toThrow(/too large to send.*1 hunk is still 4\.0 MiB.*Review the change in parts/);
  });

  test("so many hunks that even their bare headers are over the budget are refused, not sent", () => {
    // Every hunk must stay listed for the agent's order; a small budget stands in for tens of thousands of hunks.
    const budget = 256 * 1024;
    const original = { ...report(Array.from({ length: 1500 }, (_, index) => small(index, 10, 50))), callFlow: [] };
    expect(() => boundedForAgent(undefined, original, budget)).toThrow(/1500 hunks is still 0\.\d MiB, over the 0\.25 MiB/);
  });

  test("a hunk under 2,000 characters loses its diff text too when thousands of them are over the budget", () => {
    const original = { ...report(Array.from({ length: 3000 }, (_, index) => small(index, 1500, 10))), callFlow: [] };
    expect(bytes(original)).toBeGreaterThan(MAX_RESULT_BYTES);
    const result = boundedForAgent(undefined, original);
    expect(bytes(result.report)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(result.report.items[0]?.diff).toBe(original.items[0]?.diff);
    expect(result.report.items.at(-1)?.diff).toContain("were left out");
    expect(result.report.warnings.at(-1)).toMatch(/\d+ of the lowest-ranked hunks have their diff text left out/);
  });

  test("many tiny hunks: the lowest-ranked lose their facts and reasons, and a diff shorter than its placeholder is kept", () => {
    const original = { ...report(Array.from({ length: 9000 }, (_, index) => small(index, 10, 500))), callFlow: [] };
    expect(bytes(original)).toBeGreaterThan(MAX_RESULT_BYTES);
    const result = boundedForAgent(undefined, original);
    expect(bytes(result.report)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(result.report.items).toHaveLength(9000);
    expect(result.report.items.every((kept, index) => kept.diff === original.items[index]?.diff)).toBe(true);
    expect(result.report.items[0]?.reasons).toEqual(original.items[0]?.reasons);
    expect(result.report.items.at(-1)?.reasons).toEqual([]);
    expect(result.report.warnings.at(-1)).toMatch(/\d+ of the lowest-ranked hunks have their facts, reasons, and history left out/);
    expect(result.report.warnings.at(-1)).not.toContain("diff text");
  });
});
