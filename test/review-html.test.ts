import { describe, expect, test } from "vitest";
import { renderCallFlowPage, renderReview } from "../src/review/html.js";
import type { ReviewItem, ReviewReport } from "../src/review/types.js";
import type { ChangeFacts } from "../src/review/change-facts.js";
import type {
  AutomaticFinding,
  EvidenceExcerpt,
  ReviewAgendaEntry,
  ReviewEvidence,
} from "../src/review/evidence-types.js";

const ATTACK = '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function report(
  items: ReviewItem[],
  overrides: Partial<ReviewReport> = {},
): ReviewReport {
  return {
    title: "Checkout review",
    source: "main to feature",
    createdAt: "2026-09-18T10:00:00Z",
    items,
    callFlow: [],
    callFlows: [],
    callFlowAvailability: "needs-git-range",
    warnings: [],
    questions: [],
    ...overrides,
  };
}

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "hunk-1",
    file: "src/checkout.ts",
    header: "@@ -1 +1 @@",
    diff: "@@ -1 +1 @@\n-const total = price;\n+const total = price + tax;\n",
    added: 1,
    removed: 1,
    oldStart: 1,
    newStart: 1,
    status: "attention",
    priority: 87,
    reasons: ["Unrendered fixture reason text"],
    ...overrides,
  };
}

/**
 * A complete answer set, so each test names only the answers it asserts: every
 * question is answered, and a hunk with no property shown is `no` with an
 * unchanged outcome.
 */
function facts(overrides: Partial<ChangeFacts["answers"]> = {}, evidence: ChangeFacts["evidence"] = {}): ChangeFacts {
  return {
    language: "c-like",
    inert: false,
    answers: {
      comparisonChanged: "no",
      limitChanged: "no",
      validationChanged: "no",
      failurePropagated: "no",
      failureDeferred: "no",
      failureDiscarded: "no",
      ...overrides,
    },
    evidence,
  };
}

/** The document as a reviewer reads it: no inline stylesheet, no inline script. */
function visible(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<script>[\s\S]*?<\/script>/, "");
}

function scriptOf(html: string): string {
  return /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
}

/** The escaping the renderer applies, for asserting text appears verbatim-safe. */
function escapeForAssert(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A minimal cross-check over the fixture hunk, for the opening view tests. */
function evidence(overrides: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    findings: [],
    checks: [],
    agenda: [],
    intent: { verdict: "not-established", summary: "", claims: [], obligations: [] },
    ...overrides,
  };
}

function agenda(overrides: Partial<ReviewAgendaEntry> = {}): ReviewAgendaEntry {
  return {
    id: "agenda-1",
    title: "Read the changed return value",
    reason: "The changed lines feed a caller in the same range.",
    priority: 1,
    unitIds: ["hunk-1"],
    findingIds: [],
    evidence: [],
    context: [],
    ...overrides,
  };
}

function excerpt(overrides: Partial<EvidenceExcerpt> = {}): EvidenceExcerpt {
  return {
    id: "excerpt-1",
    label: "Changed lines",
    file: "src/checkout.ts",
    line: 1,
    ref: "23e53ae",
    text: "+const total = price + tax;",
    role: "change",
    ...overrides,
  };
}

function finding(overrides: Partial<AutomaticFinding> = {}): AutomaticFinding {
  return {
    id: "unused-error-result:1",
    kind: "unused-error-result",
    title: "The error field of the response is not read here",
    scope: "one resolved response object read across the changed files",
    limitation: "An unused field is not a lost failure elsewhere.",
    unitIds: ["hunk-1"],
    evidence: [],
    ...overrides,
  };
}

interface Row {
  kind: string;
  old: string;
  new: string;
  code: string;
}

/** Gutter numbers and text of every rendered diff row, in document order. */
function diffRows(html: string): Row[] {
  const rows = [
    ...html.matchAll(
      /<span class="ln ln-([a-z]+)">([\s\S]*?)<span class="code">([\s\S]*?)<\/span><\/span>/g,
    ),
  ];
  return rows.map((match) => ({
    kind: match[1],
    old: /<span class="old-no" aria-hidden="true">(\d*)<\/span>/.exec(match[2])?.[1] ?? "",
    new: /<span class="new-no" aria-hidden="true">(\d*)<\/span>/.exec(match[2])?.[1] ?? "",
    code: match[3],
  }));
}

interface Card {
  cls: string;
  attrs: string;
  html: string;
}

function cards(html: string): Card[] {
  return [
    ...html.matchAll(/<details class="(card[^"]*)"([^>]*)>([\s\S]*?)<\/details>/g),
  ].map((match) => ({ cls: match[1], attrs: match[2], html: match[3] }));
}

describe("review HTML", () => {
  test("untrusted strings are escaped and stay out of the inline script", () => {
    const html = renderReview(
      report(
        [
          item({
            file: ATTACK,
            header: ATTACK,
            diff: `@@ -1 +1 @@\n+${ATTACK}\n`,
            special: ATTACK,
            callFlow: [ATTACK],
            reasons: [ATTACK],
            facts: facts({ limitChanged: "yes" }, { limitChanged: { side: "added", text: ATTACK } }),
          }),
        ],
        {
          title: ATTACK, source: ATTACK, createdAt: ATTACK, warnings: [ATTACK], callFlow: [ATTACK],
          callFlowAvailability: "available",
          callFlows: [{ file: ATTACK, truncated: false, trees: [
            {
              key: ATTACK, label: ATTACK, file: ATTACK, line: 1, endLine: 2, status: "added",
              description: ATTACK,
              source: { file: ATTACK, line: 1, endLine: 2, ref: ATTACK, text: ATTACK },
              children: [],
            },
          ] }],
        },
      ),
    );
    expect(html).not.toContain(ATTACK);
    expect(html).not.toMatch(/<(img|iframe)\b/i);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(scriptOf(html)).not.toContain("alert(1)");
    expect(visible(html)).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("every hunk renders folded with its full diff text one click away", () => {
    const statuses = ["attention", "uncertain", "low", "passed"] as const;
    const found = cards(
      renderReview(report(statuses.map((status) => item({ status })))),
    );
    expect(found).toHaveLength(statuses.length);
    for (const [index, status] of statuses.entries()) {
      expect(found[index].attrs).toContain(`data-status="${status}"`);
      expect(/\bopen\b/.test(found[index].attrs)).toBe(false);
      expect(found[index].html).toContain("+const total = price + tax;");
      expect(found[index].html).toContain("-const total = price;");
    }
    expect(visible(renderReview(report([item()])))).toContain('id="item-1">');
  });

  test("both gutters advance from the numbers in the hunk header", () => {
    const diff = [
      "@@ -10,3 +20,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
      "",
    ].join("\n");
    const [card] = cards(renderReview(report([item({ diff })])));
    expect(diffRows(card.html)).toEqual([
      { kind: "hunk", old: "", new: "", code: "@@ -10,3 +20,4 @@" },
      { kind: "context", old: "10", new: "20", code: " const a = 1;" },
      { kind: "del", old: "11", new: "", code: "-const b = 2;" },
      { kind: "add", old: "", new: "21", code: "+const b = 3;" },
      { kind: "add", old: "", new: "22", code: "+const c = 4;" },
      { kind: "context", old: "12", new: "23", code: " const d = 5;" },
    ]);
  });

  test("changed lines that look like file headers stay changed lines", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " keep",
      "---",
      "+++",
      "--- a/comment dropped",
      "+++ b/comment added",
      "",
    ].join("\n");
    const [card] = cards(renderReview(report([item({ diff })])));
    expect(diffRows(card.html)).toEqual([
      { kind: "hunk", old: "", new: "", code: "@@ -1,3 +1,3 @@" },
      { kind: "context", old: "1", new: "1", code: " keep" },
      { kind: "del", old: "2", new: "", code: "---" },
      { kind: "add", old: "", new: "2", code: "+++" },
      { kind: "del", old: "3", new: "", code: "--- a/comment dropped" },
      { kind: "add", old: "", new: "3", code: "+++ b/comment added" },
    ]);
  });

  test("the no-newline marker is one unnumbered row", () => {
    const diff = "@@ -1 +1 @@\n-only\n+only\n\\ No newline at end of file\n";
    const [card] = cards(renderReview(report([item({ diff })])));
    const rows = diffRows(card.html);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({
      kind: "note",
      old: "",
      new: "",
      code: "\\ No newline at end of file",
    });
  });

  test("a metadata unit renders without line numbers or a file header tint", () => {
    const unit = item({
      file: "assets/logo.png",
      header: "File metadata",
      diff: "diff --git a/assets/logo.png b/assets/logo.png\n--- a/assets/logo.png\n+++ b/assets/logo.png\n",
      added: 0,
      removed: 0,
      oldStart: 0,
      newStart: 0,
      special: "Binary, rename, mode, or metadata-only change needs manual review.",
    });
    const [card] = cards(renderReview(report([unit])));
    const rows = diffRows(card.html);
    expect(rows.map((row) => row.kind)).toEqual(["meta", "meta", "meta"]);
    expect(rows.every((row) => row.old === "" && row.new === "")).toBe(true);
    expect(card.html).toContain(
      "Manual review: Binary, rename, mode, or metadata-only change needs manual review.",
    );
  });

  test("an empty diff states so instead of drawing an empty diff box", () => {
    const html = renderReview(report([item({ diff: "", added: 0, removed: 0 })]));
    expect(html).toContain("No diff text was captured for this hunk.");
    expect(html).not.toContain('<pre class="diff">');
  });

  test("severity reaches the reviewer as color only, per status", () => {
    const html = renderReview(report([item({ status: "uncertain" })]));
    const [card] = cards(html);
    expect(card.attrs).toContain('data-status="uncertain"');
    expect(card.cls).toBe("card card-uncertain");
    expect(card.html).toContain('<span class="sr">Uncertain</span>');
    expect(html).toContain('class="dot dot-uncertain"');
    const header = /<summary>([\s\S]*?)<\/summary>/.exec(card.html)?.[1] ?? "";
    expect(header).toContain("src/checkout.ts");
    expect(header).toContain("+1");
    expect(header).toContain("-1");
    expect(header).not.toContain("pill");
  });

  test("filter chips carry a dot and a count per status", () => {
    const html = renderReview(
      report([item(), item(), item({ status: "low", file: "b.ts" })]),
    );
    expect(html).toContain('aria-hidden="true"></span>Attention<span class="pill-n mono">2</span>');
    expect(html).toContain('aria-hidden="true"></span>Low<span class="pill-n mono">1</span>');
    expect([...html.matchAll(/data-filter="\w+"[^>]*aria-pressed="true"/g)]).toHaveLength(4);
    for (const status of ["attention", "uncertain", "low", "passed"]) {
      const chip = new RegExp(
        `<button[^>]*data-filter="${status}"[^>]*>(<span class="dot dot-${status}" aria-hidden="true"></span>)`,
      );
      expect(html).toMatch(chip);
    }
  });


  test("each hunk has both rank and explicit focus controls in report order", () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    const html = renderReview(report(files.map((file) => item({ file }))));
    const found = cards(html);
    expect(found).toHaveLength(files.length);
    for (const [index, card] of found.entries()) {
      const rank = index + 1;
      expect(card.attrs).toContain(`id="item-${rank}"`);
      expect(card.html).toContain(
        `class="rank enhanced mono" data-focus aria-label="Focus hunk ${rank}">#${rank}</button>`,
      );
      expect(card.html).toContain(
        `class="focus-button enhanced" data-focus aria-label="Focus hunk ${rank}">Focus</button>`,
      );
    }
    const nav = [...html.matchAll(/href="#item-(\d+)">([\s\S]*?)<\/a>/g)];
    expect(nav.map((match) => match[1])).toEqual(["1", "2", "3"]);
    expect(nav[2][2]).toContain("c.ts");
  });

  test("the visible report drops ranking numbers, weights and vendor confidence", () => {
    const unit = item({
      priority: 87,
      reasons: [
        "outcome for a consumer: changed",
        "failure discarded: yes",
        "model confidence 0.4 (self-reported by one response; informational, not a ranking gate)",
        "routed to uncertain: an answer did not separate its own options or an answer was unknown, so a human has to decide",
      ],
      facts: facts({ limitChanged: "yes", failureDiscarded: "yes" }),
    });
    const html = visible(renderReview(report([unit], {
      warnings: ["Private assessment metadata"], callFlow: [],
    })));
    expect(html).not.toMatch(/weight\s*\d/i);
    expect(html).not.toMatch(/model confidence/i);
    expect(html).not.toMatch(/\brisk\b|bug likelihood|needs context/i);
    expect(html).not.toMatch(/\/\s*100/);
    expect(html).not.toMatch(/model estimates/i);
    expect(html).not.toMatch(/api calls/i);
    expect(html).not.toMatch(/\bpriority\b|\branked\b|\brankings?\b/i);
    expect(html).not.toContain("Private assessment metadata");
    expect(html).not.toMatch(/\b87\b|0\.4/);
    // No reason prose is parsed or printed, not even the routing line.
    expect(html).not.toContain("accounted distribution");
    expect(html).not.toContain("did not separate its options");
    expect(html).not.toContain("routed to uncertain");
  });

  test("each fact renders in order, and a yes cites the changed line it rests on", () => {
    const unit = item({
      file: "src/lease.ts",
      facts: facts(
        { comparisonChanged: "yes", limitChanged: "yes", failurePropagated: "yes" },
        {
          comparisonChanged: { side: "added", text: "if (amount < 0) throw new Error('invalid');" },
          limitChanged: { side: "added", text: "if (amount < 0) throw new Error('invalid');" },
          failurePropagated: { side: "removed", text: "if (amount <= 0) throw new Error('invalid');" },
        },
      ),
    });
    const obs = /<details class="obs">([\s\S]*?)<\/details>/.exec(visible(renderReview(report([unit]))))?.[1] ?? "";
    const rows = [...obs.matchAll(/<dt>([^<]*)<\/dt><dd class="mono">([^<]*)/g)].map((match) => [match[1], match[2].trim()] as const);
    expect(rows).toEqual([
      ["Comparison changed", "yes"],
      ["Limit, size, or offset changed", "yes"],
      ["Input check changed", "no"],
      ["Failure handed to the caller", "yes"],
      ["Failure deferred or retried", "no"],
      ["Failure discarded", "no"],
      ["Public contract or declaration changed", "no"],
      ["Schema or stored data changed", "no"],
      ["Database query changed", "no"],
    ]);
    expect(obs).toContain("added line: <code>if (amount &lt; 0) throw new Error(&#39;invalid&#39;);</code>");
    expect(obs).toContain("removed line: <code>if (amount &lt;= 0)");
    expect(obs).toContain("no model was asked");
  });

  test("explains a test file's placement from its path, and only for test files", () => {
    const obsOf = (file: string) =>
      /<details class="obs">([\s\S]*?)<\/details>/.exec(
        visible(renderReview(report([item({ file, facts: facts() })]))),
      )?.[1] ?? "";
    expect(obsOf("test/checkout.test.ts")).toContain("This path looks like a test file");
    expect(obsOf("src/checkout.ts")).not.toContain("looks like a test file");
  });

  test("an unread file type says so instead of listing answers", () => {
    const html = visible(renderReview(report([item({
      file: "db/query.sql",
      status: "uncertain",
      facts: { language: null, inert: null, answers: {}, evidence: {} },
    })])));
    const obs = /<details class="obs">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    expect(obs).toContain("diffninja does not read this file type");
    expect(obs).not.toContain("<dt>");
    expect(obs).not.toMatch(/bug|defect found|problem with the code/i);
  });

  test("a formatting-only change says so", () => {
    const obs = /<details class="obs">([\s\S]*?)<\/details>/.exec(
      visible(renderReview(report([item({ status: "passed", facts: { ...facts(), inert: true } })]))),
    )?.[1] ?? "";
    expect(obs).toContain("Formatting or comments only");
  });

  test("a hunk with no facts renders no facts block", () => {
    const html = visible(renderReview(report([item({ facts: undefined })])));
    expect(html).not.toContain('<details class="obs">');
    expect(html).toContain("+const total = price + tax;");
  });

  test("answers render beside their hunk as short labels, escaped, with only in-set answers labeled", () => {
    const html = visible(renderReview(report([item({ id: "h1" }), item({ id: "h2", file: "src/other.ts" })], {
      questions: [
        { id: "q1", kind: "behaviorChange", unitIds: ["h1"], text: `Does ${ATTACK} change behavior?`,
          options: ["changes-behavior", "no-behavior-change", "cannot-tell"],
          answer: { choice: "changes-behavior", answeredBy: "claude-code 2.1", answeredAt: "2026-09-22T20:00:00Z" } },
        { id: "q2", kind: "testCoverage", unitIds: ["h1"], text: "Is it tested?",
          options: ["exercised", "not-exercised", "cannot-tell"],
          answer: { choice: ATTACK, answeredBy: "x", answeredAt: "2026-09-22T20:00:00Z" } },
        { id: "q3", kind: "behaviorChange", unitIds: ["h2"], text: "Other hunk?",
          options: ["changes-behavior", "no-behavior-change", "cannot-tell"] },
      ],
    })));
    expect(html).not.toContain(ATTACK);
    const [first, second] = cards(html);
    // One labeled answer, attributed once; the out-of-set answer gets no label.
    expect(first.html).toContain('<span class="verdicts-by">claude-code 2.1:</span><span class="verdict verdict-quiet"');
    expect([...first.html.matchAll(/class="verdict verdict-/g)]).toHaveLength(1);
    expect(first.html).toContain(">Changes behavior</span>");
    expect(first.html).toContain("<dd>unrecognized answer</dd>");
    expect(first.html).toContain("What the agent was asked");
    expect(first.html).not.toContain("Other hunk?");
    expect(second.html).not.toContain('class="verdicts"');
    expect(second.html).toContain("Questions for your agent (1 not answered yet)");
    expect(second.html).toContain("<dd>not answered yet</dd>");
  });

  test("one mode note says the analysis stayed local", () => {
    const notices = [...visible(renderReview(report([item()]))).matchAll(/<p class="mode-note">([^<]*)<\/p>/g)].map((match) => match[1]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/nothing left your machine/i);
  });

  test("an empty report says so and renders no toolbar", () => {
    const html = renderReview(report([]));
    expect(html).toContain("No hunks were reviewed in this diff.");
    expect(html).not.toContain('id="toolbar"');
    expect(html).not.toContain('id="item-');
    expect(html).not.toContain('class="toc-link"');
    // The severity legend is in the markup, not just in the stylesheet.
    expect(visible(html)).toContain(
      '<span class="dot dot-attention" aria-hidden="true"></span>Attention: read first',
    );
  });
  test("absence never fabricates a tree or mislabels a completed git-range analysis", () => {
    const patch = visible(renderReview(report([item()])));
    expect(patch).toMatch(/git.range/i);
    expect(patch).not.toMatch(/<svg class="cf-svg"/);
    for (const availability of ["no-changes", "failed"] as const) {
      const html = visible(renderReview(report([item()], { callFlowAvailability: availability })));
      expect(html).not.toMatch(/<svg class="cf-svg"/);
      expect(html).not.toMatch(/needs a git.range|requires a git.range/i);
    }
  });

  test("call-flow files use their worst hunk and link directly to that diff", () => {
    const html = renderReview(report([
      item({ file: "a.ts", status: "low" }),
      item({ file: "b.ts", status: "uncertain" }),
      item({ file: "a.ts", status: "attention" }),
    ], {
      callFlowAvailability: "available",
      callFlows: ["b.ts", "a.ts"].map(file => ({
        file, truncated: false,
        trees: [{ key: "run", label: "run()", file, line: 1, status: "changed", children: [] }],
      })),
    }));
    const headers = [...html.matchAll(/<details class="cf-file cf-file-([a-z]+)"[^>]*>([\s\S]*?)<\/summary>/g)];
    expect(headers.map(match => match[1])).toEqual(["attention", "uncertain"]);
    expect(headers[0][2]).toContain("a.ts");
    expect(headers[0][2]).toContain('href="#item-3"');
    expect(headers[1][2]).toContain("b.ts");
    expect(headers[1][2]).toContain('href="#item-2"');
  });

  test("the call-flow page shows one file's diagram on its own, with the report's modes and no link into a diff it lacks", () => {
    const flows = report([item({ file: "a.ts" }), item({ file: "b.ts" })], {
      callFlowAvailability: "available",
      callFlows: ["a.ts", "b.ts"].map(file => ({
        file, truncated: false,
        trees: [{ key: "run", label: `run_${file.charAt(0)}()`, file, line: 1, status: "changed", children: [] }],
      })),
    });
    const one = renderCallFlowPage(flows, "b.ts");
    expect(one).toContain('id="view-call-flow"');
    expect(one).toContain("run_b()");
    expect(one).not.toContain("run_a()");
    expect(one).toContain('class="flow-embed flow-single"');
    expect(one).toMatch(/\.cf-diff-link \{ display: none !important; \}/);
    expect(one.match(/<script\b/g)).toHaveLength(1);
    expect(one).not.toMatch(/<script[^>]+src=|<link\b|@import|url\(["']?https?:/i);
    const all = renderCallFlowPage(flows);
    expect(all).toContain("run_a()");
    expect(all).toContain("run_b()");
    expect(all).toContain('class="flow-embed"');
  });

  test("call diagrams remain readable without scripts and expose no external resources", () => {
    const html = renderReview(report([item()], {
      callFlowAvailability: "available",
      callFlows: [{
        file: "src/checkout.ts",
        truncated: true,
        trees: [{
          key: "checkout", label: "checkout", file: "src/checkout.ts", line: 1, status: "changed",
          children: [
            { key: "authorize", label: "authorize", file: "src/checkout.ts", line: 2, status: "removed", children: [] },
            { key: "charge", label: "charge", file: "src/checkout.ts", line: 3, status: "same", children: [] },
          ],
        }],
      }],
    }));
    const rendered = visible(html);
    expect(rendered).toMatch(/href="#view-diff"[^>]*>Diff</);
    expect(rendered).toMatch(/href="#view-call-flow"[^>]*>Call flow</);
    expect(rendered).toContain("Tree");
    expect(rendered).toContain("Diagram");
    expect(rendered).toContain("Sequence");
    expect(rendered).toMatch(/<svg\b/);
    expect(rendered).toContain("authorize");
    expect(rendered).toContain("charge");
    expect(rendered).toContain("src/checkout.ts:2");
    expect(rendered).toContain("→");
    expect(rendered).toMatch(/truncat|limit|omitt/i);
    expect(rendered).toContain("-const total = price;");
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]+src=|<link\b|@import|url\(["']?https?:/i);
    // No external resource is fetched; the only absolute href the report can
    // emit is a github pull request link, which this fixture does not have.
    expect([...html.matchAll(/href="([^"]*)"/g)].every((match) => match[1].startsWith("#"))).toBe(true);
  });

  test("the report opens on the expected outcome, before the agenda and the diagrams", () => {
    const html = visible(renderReview(report([item()], {
      pr: { title: "Sync residents", body: "Body text" },
      evidence: evidence({
        agenda: [agenda()],
        checks: [{ kind: "broken-reference", status: "not-checked", detail: "No trusted checker result for this revision." }],
        findings: [finding()],
      }),
    })));
    const order = ['id="view-brief"', 'id="brief-outcome"', 'id="brief-pr"', 'id="brief-intent-h"', 'id="brief-checks-h"', 'id="brief-agenda-h"', 'id="brief-findings-h"', 'id="view-call-flow"', 'id="view-diff"'];
    let at = -1;
    for (const marker of order) {
      const found = html.indexOf(marker);
      expect(found, `${marker} is missing`).toBeGreaterThan(-1);
      expect(found, `${marker} is out of order`).toBeGreaterThan(at);
      at = found;
    }
    expect(html).toMatch(/Outcome<\/a>/);
  });

  test("the pull request text is escaped, its description is folded, and it never reaches the script", () => {
    const html = renderReview(report([item()], {
      evidence: evidence(),
      pr: { title: ATTACK, body: `${ATTACK}\nrefactor only`, url: "https://example.invalid/pr/1", baseRef: "main", headRef: "topic" },
    }));
    const rendered = visible(html);
    expect(html).not.toContain(ATTACK);
    expect(html).not.toMatch(/<(img|iframe)\b/i);
    expect(scriptOf(html)).not.toContain("alert(1)");
    expect(rendered).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(rendered).toContain("refactor only");
    expect(rendered).toContain('<dt>Title</dt>');
  });

  test("only a validated github pull request URL becomes a link", () => {
    const cases: readonly (readonly [string, boolean])[] = [
      ["https://github.com/o/r/pull/4334", true],
      ["https://github.com/marcelormendes/diffninja/pull/1", true],
      ["javascript:alert(1)", false],
      ["data:text/html,<script>alert(1)</script>", false],
      ["https://evil.example/github.com/o/r/pull/1", false],
      ["https://github.com.evil.example/o/r/pull/1", false],
      ["https://user@github.com/o/r/pull/1", false],
      ["http://github.com/o/r/pull/1", false],
      ["https://github.com/o/r/issues/1", false],
      ["https://github.com/o/r/pull/1/../../evil", false],
      ["https://github.com/o/r/pull/1?x=<script>", false],
    ];
    for (const [url, linked] of cases) {
      const html = visible(renderReview(report([item()], {
        evidence: evidence(),
        pr: { title: "Sync", body: "", url },
      })));
      const anchor = /<a href="([^"]*)" rel="noreferrer noopener">/.exec(html);
      if (linked) {
        expect(anchor?.[1], `${url} should link`).toBe(url);
      } else {
        expect(anchor, `${url} must not become a link`).toBeNull();
        expect(html).toContain(escapeForAssert(url));
      }
      expect(html).not.toContain('href="javascript:');
    }
  });

  test("an absent description is stated rather than left blank", () => {
    const html = visible(renderReview(report([item()], {
      evidence: evidence(),
      pr: { title: "Sync residents", body: "" },
    })));
    expect(html).toContain("The pull request has no description.");
    expect(html).not.toContain('class="pr-body"');
  });

  test("agenda cards link the hunks and evidence they point at", () => {
    const html = visible(renderReview(report([item(), item({ id: "hunk-2", file: "src/lease.ts" })], {
      evidence: evidence({
        agenda: [
          agenda({ unitIds: ["hunk-2"], evidence: [excerpt({ id: "e-2", file: "src/lease.ts", line: 9, role: "caller", label: "Direct caller" })], context: [] }),
          agenda({ id: "agenda-2", title: "Second", unitIds: ["hunk-1"], evidence: [excerpt({ id: "e-1" })], context: [] }),
        ],
      }),
    })));
    const links = [...html.matchAll(/<a class="ev-hunk" data-open-hunk href="#item-(\d+)">Open hunk #(\d+)<\/a>/g)];
    expect(links.map((m) => m[1])).toEqual(["2", "1"]);
    expect(html).toContain('<span class="ev-role">Direct caller</span>');
    expect(html).toContain("src/lease.ts:9");
    expect(html).toContain("from 23e53ae");
    expect(html).toContain("+const total = price + tax;");
  });

  test("evidence a finding carries is linked from the agenda instead of repeated", () => {
    const shared = excerpt({ id: "shared", text: "+const total = price + tax;" });
    const html = visible(renderReview(report([item({ diff: "@@ -1 +1 @@\n+const total = price + tax;\n" })], {
      evidence: evidence({
        findings: [finding({ id: "f-1", evidence: [shared] })],
        agenda: [agenda({ findingIds: ["f-1"], evidence: [shared] })],
      }),
    })));
    expect(html.match(/\+const total = price \+ tax;/g)).toHaveLength(2);
    expect(html).toContain('href="#finding-1"');
    expect(html).toContain('<li class="finding" id="finding-1">');
  });

  test("a definition two agenda entries cite is rendered once and linked after that", () => {
    const node = {
      key: "after:create",
      label: "create(input)",
      file: "src/order.ts",
      line: 40,
      detail: "function create(input) {\n  return input;\n}",
    };
    const html = visible(renderReview(report([item()], {
      evidence: evidence({
        agenda: [
          agenda({ id: "a1", context: [node] }),
          agenda({ id: "a2", title: "Second", context: [node] }),
        ],
      }),
    })));
    expect(html.match(/id="ctx-1"/g)).toHaveLength(1);
    expect(html).toContain('<a class="ag-ctx-again" href="#ctx-1">src/order.ts:40 shown above</a>');
    expect(html.match(/return input;/g)).toHaveLength(1);
  });

  test("checks state their scope and never claim a pass", () => {
    const html = visible(renderReview(report([item()], {
      evidence: evidence({
        checks: [
          { kind: "duplicate-body", status: "checked", detail: "Compared the parsed bodies of 12 changed functions." },
          { kind: "broken-reference", status: "not-checked", detail: "No trusted project-checker result is available for this revision." },
        ],
      }),
    })));
    expect(html).toContain("Compared the parsed bodies of 12 changed functions.");
    expect(html).toContain("No trusted project-checker result is available for this revision.");
    expect(html).toMatch(/ev-badge-warn[^>]*>Not checked</);
    // Absence of a check is never reported as absence of a problem.
    expect(html).not.toMatch(/safe to skip|no issues|all checks passed|clean/i);
    expect(html).toContain("A check that is not listed here produced no result for this pull request.");
  });

  test("a finding carries its own scope and limit, and no finding claims safety", () => {
    const html = visible(renderReview(report([item()], {
      evidence: evidence({ findings: [finding({ evidence: [excerpt()] })] }),
    })));
    expect(html).toContain('<span class="finding-label">Checked</span> one resolved response object read across the changed files');
    expect(html).toContain('<span class="finding-label">Limit</span> An unused field is not a lost failure elsewhere.');
    expect(html).toContain("Unused failure result");
    const empty = visible(renderReview(report([item()], { evidence: evidence() })));
    expect(empty).toContain("No automatic finding was reported.");
    expect(empty).toMatch(/an empty list is not a statement about the code/);
  });

  test("the verdict describes the evidence it rests on, never overall correctness", () => {
    const supported = visible(renderReview(report([item()], {
      evidence: evidence({
        intent: {
          verdict: "supported-within-checked-scope",
          summary: "Consumers are updated in the changed files.",
          claims: [{ text: "Consumers are updated", origin: "title", status: "evidence-linked", unitIds: ["hunk-1"], explanation: "The changed caller reads the changed shape." }],
          obligations: [],
        },
      }),
    })));
    expect(supported).toContain("Supported within the checked scope");
    expect(supported).toContain("PR title");
    expect(supported).toContain("Evidence linked");
    expect(supported).toContain('href="#item-1">Open hunk #1</a>');
    // The scope qualifier is part of the label, so it cannot be read as a pass.
    expect(supported).not.toMatch(/correct|verified|approved|safe/i);

    const unknown = visible(renderReview(report([item()], {
      evidence: evidence({
        intent: {
          verdict: "not-established",
          summary: "End-to-end fulfillment is not established.",
          claims: [{ text: "Covered end to end", origin: "generated-summary", status: "not-established", unitIds: [], explanation: "No changed test exercises the flow." }],
          obligations: ["Retry the partial failure."],
        },
      }),
    })));
    expect(unknown).toContain("Not established");
    expect(unknown).toContain("Generated summary");
    expect(unknown).toContain("Retry the partial failure.");
  });

  test("every hunk stays reachable, folded, with or without a cross-check", () => {
    for (const withEvidence of [true, false]) {
      const html = renderReview(report(
        [item(), item({ id: "hunk-2", file: "src/other.ts" })],
        withEvidence ? { evidence: evidence({ agenda: [agenda()] }) } : {},
      ));
      const found = cards(html);
      expect(found).toHaveLength(2);
      for (const card of found) {
        expect(/\bopen\b/.test(card.attrs)).toBe(false);
        expect(card.html).toContain("+const total = price + tax;");
      }
      expect(html).toContain('id="item-1"');
      expect(html).toContain('id="item-2"');
    }
  });

  test("a report with a cross-check opens on the outcome and a legacy report on the call flow", () => {
    const fresh = renderReview(report([item()], { evidence: evidence({ agenda: [agenda()] }) }));
    expect(fresh).toContain('<body data-default-view="brief">');
    expect(fresh).toContain('href="#view-brief" data-view="brief">Outcome</a>');
    const legacy = renderReview(report([item()]));
    expect(legacy).toContain('<body data-default-view="call-flow">');
    expect(legacy).toContain("No pull request metadata was recorded for this report.");
    expect(legacy).toContain("No intent cross-check was recorded for this report.");
  });

  test("the alternate call-flow modes ship inert and the tree stays readable without scripts", () => {
    const html = visible(renderReview(report([item()], {
      callFlowAvailability: "available",
      callFlows: [{
        file: "src/checkout.ts",
        truncated: false,
        trees: [{
          key: "checkout",
          label: "checkout",
          file: "src/checkout.ts",
          line: 1,
          status: "changed",
          children: [{ key: "charge", label: "charge", file: "src/checkout.ts", line: 3, status: "same", children: [] }],
        }],
      }],
    })));
    // Tree is live markup; graph and sequence wait, inert, inside templates.
    expect(html).toMatch(/<section class="cf-mode cf-mode-tree"/);
    const graph = /<template data-cf-lazy-mode="graph" data-cf-file="1">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? "";
    const sequence = /<template data-cf-lazy-mode="sequence" data-cf-file="1">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? "";
    expect(graph).toMatch(/<section class="cf-mode cf-mode-graph"/);
    expect(sequence).toMatch(/<section class="cf-mode cf-mode-sequence"/);
    // The tree section itself is not inside a template, so it renders without scripts.
    expect(html.indexOf('cf-mode cf-mode-tree')).toBeLessThan(html.indexOf("<template"));
    // The mode switch is script-only, so its anchors cannot be dead links, and
    // the page says which renderings a reader without scripts is missing.
    // The diagram opens across the window from a script-only button rather than a tab.
    expect(html).toContain('<button type="button" class="cf-diagram-btn enhanced" data-cf-diagram');
    expect(html).not.toContain('data-cf-mode="graph"');
    expect(html).toContain('<a class="cf-mode-link enhanced" data-cf-mode="sequence"');
    expect(html).toMatch(/<noscript class="cf-noscript">.*The diagram and Sequence are alternate renderings/s);
    expect(html).toContain("The diff holds every changed line.");
    // The markup is still all there for a reader without the script.
    expect(html).toContain("charge");
    expect(graph).toMatch(/<svg\b/);
    expect(html.match(/<template\b/g)).toHaveLength(2);
  });

});
