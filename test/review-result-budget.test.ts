import { describe, expect, test } from "vitest";
import { AGENT_RESULT_CHARS, readItems, type AgentItem, type AgentItemIndex, type AgentView, type FullItem } from "../src/review/agent-view.js";
import type { ConnectedSnapshot } from "../src/review/github.js";
import { STATUS_REASON } from "../src/review/pipeline.js";
import { MAX_RESULT_BYTES, boundedForAgent } from "../src/review/result-budget.js";
import type { ReviewContextNode, ReviewItem, ReviewReport } from "../src/review/types.js";

function item(index: number, diffLines: number): ReviewItem {
  const header = "@@ -1,1 +1,1 @@";
  const diff = [header, ...Array.from({ length: diffLines }, (_, line) => `+const value_${index}_${line} = compute(${line}, "${"x".repeat(60)}");`)].join("\n");
  return {
    id: `hunk-${index}`, file: `src/file${index}.ts`, header, added: diffLines, removed: 0, oldStart: 1, newStart: 1, diff,
    status: "attention", priority: 90 - index, reasons: ["comparison changed — added line: if (a < b) {", STATUS_REASON.attention], callFlow: ["call compute @ src/a.ts:1".repeat(40)], contextNodes: [],
    facts: {
      language: "c-like", inert: false, importsOnly: false,
      answers: { comparisonChanged: "yes", limitChanged: "no", dataChanged: "no" },
      evidence: { comparisonChanged: { side: "added", text: "if (a < b) {" } },
    },
  };
}

function report(items: ReviewItem[], claims = 0): ReviewReport {
  return {
    title: "big", source: "s", createdAt: "2026-09-28T00:00:00Z", items, callFlow: ["tree".repeat(1000)], callFlows: [], callFlowAvailability: "available", warnings: ["first"], questions: [],
    evidence: { agenda: [], findings: [], checks: [], intent: { verdict: "not-established", summary: "s", obligations: [], claims: Array.from({ length: claims }, (_, index) => ({ text: `claim ${index}`, origin: "author" as const, status: "not-established" as const, unitIds: [], explanation: "e" })) } },
  };
}

const chars = (value: AgentView | FullItem[]) => JSON.stringify(value).length;
const bytes = (value: AgentView) => Buffer.byteLength(JSON.stringify(value));
function inFull(entry: AgentItem | AgentItemIndex | undefined): AgentItem {
  if (entry === undefined || "leftOut" in entry) throw new Error(`expected a hunk sent in full, got ${JSON.stringify(entry)}`);
  return entry;
}

describe("the result sent to the agent", () => {
  test("leaves out what the agent reads elsewhere and says the repeats once, keeping every cited line", () => {
    const original = report([item(0, 20), item(1, 20)], 5);
    const result = boundedForAgent(undefined, original);
    expect(result.report).not.toHaveProperty("callFlow");
    expect(result.report).not.toHaveProperty("callFlows");
    const [first] = result.report.items.map(inFull);
    expect(first).not.toHaveProperty("callFlow");
    expect(first).not.toHaveProperty("contextNodes");
    // The diff opens with the header, so it is not said twice.
    expect(first).not.toHaveProperty("header");
    expect(first.diff).toBe(original.items[0]?.diff);
    // The status's meaning is in the guide; the fact's reason keeps its cited line.
    expect(first.reasons).toEqual(["comparison changed — added line: if (a < b) {"]);
    expect(result.report.guide.statuses).toEqual({ attention: STATUS_REASON.attention });
    expect(first.facts).toEqual({ language: "c-like", inert: false, importsOnly: false, answers: { comparisonChanged: "yes" } });
    expect(result.report.guide.facts).toContain("answered no");
    // One shared claim explanation per status, said once.
    expect(result.report.guide.claims).toEqual({ "not-established": "e" });
    expect(result.report.evidence?.intent.claims[0]).toEqual({ text: "claim 0", origin: "author", status: "not-established", unitIds: [] });
    expect(result.report.warnings).toEqual(["first"]);
    expect(result.report).not.toHaveProperty("paging");
    // The caller's report is not modified: the pages and read_items use it whole.
    expect(original.items[0]?.callFlow).toHaveLength(1);
    expect(original.items[0]?.reasons).toHaveLength(2);
  });

  test("the instructions every question of a kind shares are said once, and each question keeps its own sentence", () => {
    const shared = "Answer no-behavior-change when the hunk only adds or renames a declaration that other hunks put to use: the use is asked about where it happens.";
    const questions = ["src/a.ts @@ -1,2 +1,2 @@", "src/b.ts @@ -4,2 +4,3 @@"].map((name, index) => ({
      id: `q${index + 1}`, kind: "behaviorChange" as const, unitIds: [`hunk-${index}`], options: ["changes-behavior", "no-behavior-change", "cannot-tell"],
      text: `Taken on its own, does ${name} change what callers observe? ${shared}`,
    }));
    const lone = { id: "q3", kind: "docMatchesCode" as const, unitIds: ["hunk-1"], options: ["matches", "contradicts", "cannot-tell"], text: "Does what README.md @@ -1 +1 @@ now tells readers match how the code actually behaves?" };
    const result = boundedForAgent(undefined, { ...report([item(0, 2), item(1, 2)]), questions: [...questions, lone] });
    expect(result.report.guide.questions).toEqual({ behaviorChange: shared });
    expect(result.report.questions.map((question) => question.text)).toEqual([
      "Taken on its own, does src/a.ts @@ -1,2 +1,2 @@ change what callers observe?",
      "Taken on its own, does src/b.ts @@ -4,2 +4,3 @@ change what callers observe?",
      lone.text,
    ]);
    expect(result.report.questions.map(({ id, options }) => ({ id, options }))).toEqual([...questions, lone].map(({ id, options }) => ({ id, options })));
  });

  test("a connected result drops the line copy of the diff and the pull request text the snapshot already carries", () => {
    const snapshot: ConnectedSnapshot = {
      id: "s", url: "u", owner: "o", repo: "r", number: 1, baseSha: "a", headSha: "b", state: "OPEN", title: "t", body: "b",
      lines: Array.from({ length: 30_000 }, (_, index) => ({ path: "src/a.ts", line: index + 1, side: "RIGHT" as const, text: "x".repeat(100), kind: "add" as const })),
    };
    const result = boundedForAgent(snapshot, { ...report([item(0, 40)]), pr: { title: "t", body: "b", url: "u" } });
    expect(result.snapshot).not.toHaveProperty("lines");
    expect(result.snapshot).toMatchObject({ number: 1, title: "t", body: "b" });
    expect(result.report).not.toHaveProperty("pr");
    expect(chars(result)).toBeLessThan(AGENT_RESULT_CHARS);
    // A static report keeps its expected outcome: nothing else carries it.
    expect(boundedForAgent(undefined, { ...report([item(0, 40)]), pr: { title: "t", body: "b" } }).report.pr).toEqual({ title: "t", body: "b" });
  });

  test("a large change keeps the top hunks whole and lists the lowest-ranked by id, saying how to read them", () => {
    const original = report(Array.from({ length: 40 }, (_, index) => item(index, 30)), 500);
    const result = boundedForAgent(undefined, original);
    expect(chars(result)).toBeLessThanOrEqual(AGENT_RESULT_CHARS);
    expect(result.report.items).toHaveLength(40);
    expect(inFull(result.report.items[0]).diff).toBe(original.items[0]?.diff);
    expect(result.report.items.at(-1)).toEqual({ id: "hunk-39", file: "src/file39.ts", status: "attention", priority: 51, added: 30, removed: 0, leftOut: true });
    const leftOut = result.report.items.filter((entry) => "leftOut" in entry).length;
    expect(leftOut).toBeGreaterThan(0);
    // Only the bottom of the ranking is left out.
    expect(result.report.items.findIndex((entry) => "leftOut" in entry)).toBe(40 - leftOut);
    expect(result.report.paging).toEqual({ inFull: 40 - leftOut, leftOut, next: expect.stringContaining("read_items") });
    expect(result.report.evidence?.intent.claims).toHaveLength(20);
    expect(result.report.warnings[0]).toBe("first");
    expect(result.report.warnings.at(-1)).toMatch(/over 45,000 characters.*first 20 of 500 statements.*\d+ of the 40 hunks, the lowest-ranked and those too large to fit, are listed by id only/);
    // Same report, same result.
    expect(boundedForAgent(undefined, original)).toEqual(result);
  });

  test("a result over the message limit even with every hunk listed by id is refused with a reason", () => {
    const original = { ...report([item(0, 1)]), callFlow: [], pr: { title: "t", body: "b".repeat(MAX_RESULT_BYTES) } };
    expect(() => boundedForAgent(undefined, original)).toThrow(/too large to send.*listed by id only.*1 hunk is still 4\.0 MiB.*Review the change in parts/);
  });

  test("so many hunks that even their ids are over the budget are refused, not sent", () => {
    // Every hunk must stay listed for the agent's order; a small budget stands in for tens of thousands of hunks.
    const budget = 256 * 1024;
    const original = report(Array.from({ length: 3000 }, (_, index) => item(index, 1)));
    expect(() => boundedForAgent(undefined, original, budget)).toThrow(/3000 hunks is still 0\.\d MiB, over the 0\.25 MiB/);
  });

  test("thousands of hunks: every one stays listed, under the message limit", () => {
    const original = report(Array.from({ length: 9000 }, (_, index) => item(index, 3)));
    const result = boundedForAgent(undefined, original);
    expect(result.report.items.map((entry) => entry.id)).toEqual(original.items.map((entry) => entry.id));
    expect(bytes(result) * 2).toBeLessThan(10 * 1024 * 1024);
    expect(result.report.paging?.leftOut).toBeGreaterThan(8000);
  });
});

describe("read_items", () => {
  const node = (index: number): ReviewContextNode => ({ key: `after:f${index}`, label: `f${index}()`, file: "src/a.ts", line: index, detail: "source ".repeat(400) });

  test("returns the asked hunks whole, in the order asked, with their call context only when asked", () => {
    const items = [item(0, 3), item(1, 3), item(2, 3)];
    const plain = readItems(items, ["hunk-2", "hunk-0"], false, AGENT_RESULT_CHARS);
    expect(plain.items.map((entry) => entry.id)).toEqual(["hunk-2", "hunk-0"]);
    expect(plain.items[0]).not.toHaveProperty("callFlow");
    // The full form keeps what the review_diff result shortened: the header and each fact's cited line.
    expect(plain.items[0]).toMatchObject({ header: "@@ -1,1 +1,1 @@", facts: { evidence: { comparisonChanged: { side: "added", text: "if (a < b) {" } } } });
    expect(plain.notReturned).toEqual([]);
    const withContext = readItems(items, ["hunk-1"], true, AGENT_RESULT_CHARS);
    expect(withContext.items[0]).toMatchObject({ callFlow: items[1]?.callFlow, contextNodes: [] });
  });

  test("returns as many as fit, then names the rest; a hunk alone over the limit is cut, least related context first", () => {
    const big = { ...item(0, 3), contextNodes: Array.from({ length: 30 }, (_, index) => node(index)) };
    const items = [big, item(1, 3), item(2, 3)];
    const limit = 20_000;
    const first = readItems(items, ["hunk-0", "hunk-1", "hunk-2"], true, limit);
    expect(first.items.map((entry) => entry.id)).toEqual(["hunk-0"]);
    expect(first.notReturned).toEqual(["hunk-1", "hunk-2"]);
    expect(chars(first.items)).toBeLessThanOrEqual(limit);
    // The nodes kept are the first ones: the report lists them highest retention priority first.
    expect(first.items[0]?.contextNodes).toEqual(big.contextNodes.slice(0, first.items[0]?.contextNodes?.length));
    expect(first.trimmed).toEqual([expect.stringMatching(/^hunk-0 was too large to send whole, so it leaves out \d+ of its 30 context nodes, the least related\.$/)]);
    const rest = readItems(items, first.notReturned, true, limit);
    expect(rest.items.map((entry) => entry.id)).toEqual(["hunk-1", "hunk-2"]);
    expect(rest.trimmed).toEqual([]);
  });

  test("a hunk whose diff alone is over the limit keeps its start and says where the rest is", () => {
    const read = readItems([item(0, 2000)], ["hunk-0"], false, 20_000);
    expect(chars(read.items)).toBeLessThanOrEqual(20_000);
    expect(read.items[0]?.diff).toMatch(/^@@ -1,1 \+1,1 @@\n\+const value_0_0 /);
    expect(read.items[0]?.diff).toMatch(/\[\d+ more lines of this hunk were left out to fit; read them in the repository at src\/file0\.ts\.\]$/);
    expect(read.trimmed).toEqual([expect.stringMatching(/^hunk-0 was too large to send whole, so it leaves out the last \d+ of its 2001 diff lines\.$/)]);
  });

  test("an unknown or repeated id refuses the whole call", () => {
    const items = [item(0, 1), item(1, 1)];
    expect(() => readItems(items, ["hunk-0", "hunk-9"], false, AGENT_RESULT_CHARS)).toThrow(/^ids\[1\] is not an item of this review/);
    expect(() => readItems(items, ["hunk-1", "hunk-1"], false, AGENT_RESULT_CHARS)).toThrow(/^ids\[1\] repeats an id/);
  });
});
