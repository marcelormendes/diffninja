import { describe, expect, test } from "vitest";
import { connectedAnalysisOf } from "../src/review/connected-analysis.js";
import type { ReviewItem, ReviewReport } from "../src/review/types.js";

function report(item: ReviewItem): ReviewReport {
  return { title: "t", source: "s", createdAt: "2026-09-23T00:00:00Z", items: [item], callFlow: [], callFlows: [], callFlowAvailability: "no-changes", warnings: [], questions: [] };
}

const base = {
  id: "hunk-1", file: "src/limit.ts", header: "@@ -10,4 +10,5 @@", added: 2, removed: 1, oldStart: 10, newStart: 10,
  diff: "@@ -10,4 +10,5 @@\n keep()\n-if (count > 10) {\n+if (count >= limit) {\n+  log(count)\n more()\n",
  status: "attention" as const, priority: 50, reasons: [],
};

describe("connected analysis facts", () => {
  test("each fact points at the diff line it cites, on its own side", () => {
    const item: ReviewItem = { ...base, facts: {
      language: "code", inert: false, answers: { comparisonChanged: "yes", limitChanged: "yes" },
      evidence: { comparisonChanged: { side: "added", text: "if (count >= limit) {" }, limitChanged: { side: "removed", text: "if (count > 10) {" } },
    } } as ReviewItem;
    const facts = connectedAnalysisOf(report(item), "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" }).hunks[0].facts;
    expect(facts.find(fact => fact.label === "Comparison")?.at).toEqual({ line: 11, side: "RIGHT" });
    expect(facts.find(fact => fact.label === "Limit")?.at).toEqual({ line: 11, side: "LEFT" });
  });

  test("a truncated citation still finds its line, and an unplaceable one carries no position", () => {
    const item: ReviewItem = { ...base, facts: {
      language: "code", inert: false, answers: { comparisonChanged: "yes", contractChanged: "yes" },
      evidence: { comparisonChanged: { side: "added", text: "if (count >= li…" }, contractChanged: { side: "added", text: "export const gone = 1" } },
    } } as ReviewItem;
    const facts = connectedAnalysisOf(report(item), "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" }).hunks[0].facts;
    expect(facts.find(fact => fact.label === "Comparison")?.at).toEqual({ line: 11, side: "RIGHT" });
    expect(facts.find(fact => fact.label === "Public API")?.at).toBeUndefined();
  });
});
