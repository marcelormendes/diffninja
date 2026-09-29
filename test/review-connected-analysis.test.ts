import { describe, expect, test } from "vitest";
import { connectedAnalysisOf } from "../src/review/connected-analysis.js";
import { renderConnectedPage } from "../src/review/connected-html.js";
import type { AgentSummary, ReviewItem, ReviewReport } from "../src/review/types.js";

function report(item: ReviewItem, agentSummary?: AgentSummary): ReviewReport {
  return { title: "t", source: "s", createdAt: "2026-09-23T00:00:00Z", items: [item], callFlow: [], callFlows: [], callFlowAvailability: "no-changes", warnings: [], questions: [], agentSummary };
}

const base = {
  id: "hunk-1", file: "src/limit.ts", header: "@@ -10,4 +10,5 @@", added: 2, removed: 1, oldStart: 10, newStart: 10,
  diff: "@@ -10,4 +10,5 @@\n keep()\n-if (count > 10) {\n+if (count >= limit) {\n+  log(count)\n more()\n",
  status: "attention", priority: 50, reasons: [],
} satisfies Omit<ReviewItem, "facts">;

describe("connected analysis facts", () => {
  test("each fact points at the diff line it cites, on its own side", () => {
    const item: ReviewItem = { ...base, facts: {
      language: "c-like", inert: false, answers: { comparisonChanged: "yes", limitChanged: "yes" },
      evidence: { comparisonChanged: { side: "added", text: "if (count >= limit) {" }, limitChanged: { side: "removed", text: "if (count > 10) {" } },
    } };
    const facts = connectedAnalysisOf(report(item), "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" }).hunks[0].facts;
    expect(facts.find(fact => fact.label === "Comparison")?.at).toEqual({ line: 11, side: "RIGHT" });
    expect(facts.find(fact => fact.label === "Limit")?.at).toEqual({ line: 11, side: "LEFT" });
  });

  test("a truncated citation still finds its line, and an unplaceable one carries no position", () => {
    const item: ReviewItem = { ...base, facts: {
      language: "c-like", inert: false, answers: { comparisonChanged: "yes", contractChanged: "yes" },
      evidence: { comparisonChanged: { side: "added", text: "if (count >= li…" }, contractChanged: { side: "added", text: "export const gone = 1" } },
    } };
    const facts = connectedAnalysisOf(report(item), "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" }).hunks[0].facts;
    expect(facts.find(fact => fact.label === "Comparison")?.at).toEqual({ line: 11, side: "RIGHT" });
    expect(facts.find(fact => fact.label === "Public API")?.at).toBeUndefined();
  });
});

describe("connected analysis goal summary", () => {
  const analysis = (item: ReviewItem, agentSummary?: AgentSummary) =>
    connectedAnalysisOf(report(item, agentSummary), "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" });

  test("hands back the paragraph the agent's finish kept, attributed to that client", () => {
    const summary = { text: "Charge the limit the config states instead of a fixed ten. Dropping the warning log is not explained by the author.", summarizedBy: "agent 1.0" };
    expect(analysis(base, summary).summary).toEqual(summary);
  });

  test("has no goal to show when the review kept none, rather than inventing one", () => {
    // An unfinished report carries no summary, so the page has nothing to display
    // above the diff and must say so: diffninja generates no goal of its own.
    const view = analysis(base);
    expect(view.summary).toBeUndefined();
    expect("summary" in view).toBe(false);
  });
});

describe("connected analysis update notice", () => {
  const facts = { language: "c-like", inert: false, answers: {}, evidence: {} } as const;
  const item: ReviewItem = { ...base, facts };
  const notice = { current: "0.3.2", latest: "0.4.0", command: "npx diffninja@latest setup" };
  const view = (updateNotice?: typeof notice) =>
    connectedAnalysisOf({ ...report(item), updateNotice }, "snap", "r".repeat(32), "http://127.0.0.1:1/report/x", { source: "patch", note: "" });

  test("hands the page the notice the report carries, and nothing when there is none", () => {
    expect(view(notice).update).toEqual(notice);
    expect("update" in view()).toBe(false);
  });

  test("the connected page draws it in its own line", () => {
    const page = renderConnectedPage({ csrf: "csrf", nonce: "nonce", base: "/secret/" });
    expect(page).toContain('id="update-notice"');
    expect(page).toContain("function renderUpdate()");
  });
});

/**
 * A stand-in for the browser nodes the connected page's script builds, so the
 * page's own suggestion functions run as shipped and the tree they build can be read.
 */
interface StubDataset {
  action?: string;
  path?: string;
  line?: string;
  side?: string;
}

class StubNode {
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  href = "";
  readonly children: StubNode[] = [];
  readonly dataset: StubDataset = {};
  readonly attributes = new Map<string, string>();

  constructor(readonly tag: string) {}

  appendChild(child: StubNode): StubNode {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Every text in this subtree in reading order, each with the class of the node that holds it. */
  texts(): Array<{ className: string; text: string }> {
    const own = this.textContent === "" ? [] : [{ className: this.className, text: this.textContent }];
    return [...own, ...this.children.flatMap((child) => child.texts())];
  }

  find(className: string): StubNode | undefined {
    if (this.className.split(" ").includes(className)) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

/** What the page reads of one suggested comment on the wire. */
interface WireSuggestion {
  path: string;
  line: number;
  side: string;
  body: string;
  scenario?: string;
  evidence?: string;
  unlessTrue?: string;
  severity?: string;
}

interface SuggestionFunctions {
  openSuggestions(): WireSuggestion[];
  suggestionRow(suggestion: WireSuggestion, disabled: boolean): StubNode;
  suggestionBar(open: WireSuggestion[], disabled: boolean): StubNode | null;
}

/** The connected page's script, cut at the functions a suggestion goes through, run against stub nodes. */
function suggestionFunctions(comments: readonly WireSuggestion[], drafts: ReadonlyArray<{ suggestedBy: string }> = []): SuggestionFunctions {
  const page = renderConnectedPage({ csrf: "c".repeat(64), nonce: "n", base: "/b/" });
  const cut = (from: string, to: string) => {
    const start = page.indexOf(from);
    const end = page.indexOf(to, start);
    expect(start, from).toBeGreaterThan(0);
    expect(end, to).toBeGreaterThan(start);
    return page.slice(start, end);
  };
  const script = [
    cut("var HIDDEN;", "function setText("),
    cut("function anchorKeyOf(", "function suggestionAt("),
    cut("function suggestionRow(", "function readingRank("),
  ].join("\n");
  const document = { createElement: (tag: string) => new StubNode(tag), createTextNode: (text: string) => Object.assign(new StubNode("#text"), { textContent: text }) };
  const analysis = { snapshotId: "snap", suggestions: { suggestedBy: "agent 1.0", comments } };
  // SAFETY: the sliced script defines exactly these three functions, whose shapes are the interface above.
  return new Function("document", "currentAnalysis", "currentLine", "settled", "comments", `${script}; return { openSuggestions, suggestionRow, suggestionBar };`)(
    document, () => analysis, () => true, {}, drafts,
  ) as SuggestionFunctions;
}

describe("the connected page shows a suggestion as a blocker with its proof", () => {
  const blocker: WireSuggestion = {
    path: "src/limit.ts", line: 11, side: "RIGHT", body: "This lets a count of zero through.",
    scenario: "A count of 0 passes the new check and the loop divides by it.", evidence: "ran",
    unlessTrue: "no caller passes 0.",
  };

  test("offers a suggestion only when it carries its whole proof", () => {
    const at = (line: number, fields: Partial<WireSuggestion>): WireSuggestion => ({ ...blocker, line, body: `Comment on ${line}.`, ...fields });
    const comments = [
      at(1, {}),
      at(2, { evidence: "traced" }),
      at(3, { evidence: "guessed" }),
      at(4, { evidence: "constructor" }),
      at(5, { evidence: undefined }),
      at(6, { scenario: undefined }),
      at(7, { scenario: "" }),
      at(8, { unlessTrue: undefined }),
      at(9, { unlessTrue: "" }),
      at(10, { body: "" }),
      at(11, { side: "BOTH" }),
      // What an agent from before the change sends: a severity and none of the proof.
      { path: "src/limit.ts", line: 12, side: "RIGHT", body: "Old shape.", severity: "major" },
    ];
    const offered = suggestionFunctions(comments).openSuggestions();
    expect(offered.map((suggestion) => suggestion.line)).toEqual([1, 2]);
  });

  test("marks the comment Blocks merge and shows why, how it was checked, and when it would not matter", () => {
    const { suggestionRow } = suggestionFunctions([blocker]);
    const row = suggestionRow(blocker, false);
    expect(row.find("suggestion-body")?.textContent).toBe(blocker.body);
    const badge = row.find("blocks-badge");
    expect(badge?.textContent).toBe("Blocks merge");
    expect(row.find("proof-title")?.textContent).toBe("Why it blocks");
    expect(row.find("proof-scenario")?.textContent).toBe(blocker.scenario);
    expect(row.find("proof-evidence")?.textContent).toBe("Checked: ran it");
    expect(row.find("proof-unless")?.textContent).toBe("Not a problem if: no caller passes 0.");
    const said = row.texts().map((entry) => entry.text).join(" ");
    expect(said).not.toMatch(/critical|major|minor|severity/i);

    expect(suggestionRow({ ...blocker, evidence: "traced" }, false).find("proof-evidence")?.textContent).toBe("Checked: traced the code");
  });

  test("marks a hidden character in the proof as it does in the body", () => {
    const sneaky: WireSuggestion = { ...blocker, body: "Fix‮this.", scenario: `${blocker.scenario}​`, unlessTrue: "no callerㅤ passes 0." };
    const row = suggestionFunctions([sneaky]).suggestionRow(sneaky, false);
    expect(row.find("suggestion-body")?.textContent).toBe("Fix⟦U+202E⟧this.");
    expect(row.find("proof-scenario")?.textContent).toBe(`${blocker.scenario}⟦U+200B⟧`);
    expect(row.find("proof-unless")?.textContent).toBe("Not a problem if: no caller⟦U+3164⟧ passes 0.");
  });

  test("the buttons carry the line only, so the proof never joins the draft", () => {
    const row = suggestionFunctions([blocker]).suggestionRow(blocker, false);
    const buttons = row.children.at(-1)?.children ?? [];
    expect(buttons.map((button) => button.dataset)).toEqual([
      { action: "add-suggestion", path: "src/limit.ts", line: "11", side: "RIGHT" },
      { action: "dismiss-suggestion", path: "src/limit.ts", line: "11", side: "RIGHT" },
    ]);
    expect(JSON.stringify(buttons.map((button) => [button.dataset, [...button.attributes]]))).not.toContain(blocker.scenario);
  });

  test("the bar says the comments block the merge", () => {
    const bar = (count: number) => {
      const open = Array.from({ length: count }, (_, index) => ({ ...blocker, line: index + 1 }));
      return suggestionFunctions(open).suggestionBar(open, false)?.texts().map((entry) => entry.text).join("");
    };
    expect(bar(1)).toBe("agent 1.0 suggested 1 comment that blocks the merge on the lines below. Nothing is posted until you submit.Add it to review");
    expect(bar(3)).toBe("agent 1.0 suggested 3 comments that block the merge on the lines below. Nothing is posted until you submit.Add all 3");
  });
});
