import { describe, expect, test } from "vitest";
import { renderReview } from "../src/review/html.js";
import type { ReviewItem, ReviewReport } from "../src/review/types.js";

const ATTACK = '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function report(
  items: ReviewItem[],
  overrides: Partial<ReviewReport> = {},
): ReviewReport {
  return {
    title: "Checkout review",
    source: "main to feature",
    mode: "live",
    createdAt: "2026-09-18T10:00:00Z",
    items,
    callFlow: [],
    callFlows: [],
    callFlowAvailability: "needs-git-range",
    warnings: [],
    modelCalls: 0,
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
    reasons: ["Review boundary handling"],
    ...overrides,
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
            judgment: { risk: 1, bug: 0.1, needsHuman: 0.2, confidence: 0.8, category: ATTACK },
          }),
        ],
        {
          title: ATTACK, source: ATTACK, createdAt: ATTACK, warnings: [ATTACK], callFlow: [ATTACK],
          callFlowAvailability: "available",
          callFlows: [{ file: ATTACK, truncated: false, trees: [
            { key: ATTACK, label: ATTACK, file: ATTACK, line: 1, status: "added", children: [] },
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

  test("every hunk renders open with its full diff text", () => {
    const statuses = ["attention", "uncertain", "low", "passed"] as const;
    const found = cards(
      renderReview(report(statuses.map((status) => item({ status })))),
    );
    expect(found).toHaveLength(statuses.length);
    for (const [index, status] of statuses.entries()) {
      expect(found[index].attrs).toContain(`data-status="${status}"`);
      expect(/\bopen\b/.test(found[index].attrs)).toBe(true);
      expect(found[index].html).toContain("+const total = price + tax;");
      expect(found[index].html).toContain("-const total = price;");
    }
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
    expect(html).toContain('data-filter="attention" data-count="2"');
    expect(html).toContain('data-filter="uncertain" data-count="0"');
    expect(html).toContain('data-filter="low" data-count="1"');
    expect(html).toContain('data-filter="passed" data-count="0"');
    expect([...html.matchAll(/aria-pressed="true"/g)]).toHaveLength(4);
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

  test("the visible report drops reasons, judgment numbers, priority and model metadata", () => {
    const unit = item({
      priority: 87,
      reasons: ["Review boundary handling"],
      judgment: { risk: 2.5, bug: 0.72, needsHuman: 0.81, confidence: 0.4, category: "logic" },
    });
    const html = visible(renderReview(report([unit], {
      modelCalls: 3, warnings: ["Private assessment metadata"], callFlow: [],
    })));
    expect(html).not.toMatch(/review boundary handling/i);
    expect(html).not.toMatch(/reasons/i);
    expect(html).not.toMatch(/\/\s*100/);
    expect(html).not.toMatch(/model estimates/i);
    expect(html).not.toMatch(/api calls/i);
    expect(html).not.toMatch(/\b(model|judgments?|priority|ranked|rankings?)\b/i);
    expect(html).not.toContain("Private assessment metadata");
    expect(html).not.toMatch(/\bRisk\b|Bug likelihood|Needs context|logic|2\.5|87/);
    expect(html).not.toMatch(/\b\d{1,3}%/);
  });

  test("mock and live differ by one mode note, with no mock banner", () => {
    const mock = renderReview(
      report([item()], { mode: "mock", warnings: ["Mock mode: no API call was made."] }),
    );
    const live = renderReview(report([item()]));
    const notices = (html: string) =>
      [...visible(html).matchAll(/<p class="mode-note">([^<]*)<\/p>/g)].map((match) => match[1]);
    expect(notices(mock)).toHaveLength(1);
    expect(notices(mock)[0]).toMatch(/\bmock\b/i);
    expect(notices(live)).toHaveLength(1);
    expect(notices(live)[0]).toMatch(/\blive\b/i);
    expect(visible(mock)).not.toContain("no API call was made");
  });

  test("an empty report says so and renders no toolbar", () => {
    const html = renderReview(report([]));
    expect(html).toContain("No hunks were reviewed in this diff.");
    expect(html).not.toContain('id="toolbar"');
    expect(html).not.toContain('id="item-');
    expect(html).not.toContain('class="toc-link"');
    expect(html).toContain("dot-attention");
  });
  test("absence never fabricates a tree or mislabels a completed git-range analysis", () => {
    const patch = visible(renderReview(report([item()])));
    expect(patch).toMatch(/git.range/i);
    expect(patch).not.toMatch(/<svg\b/);
    for (const availability of ["no-changes", "failed"] as const) {
      const html = visible(renderReview(report([item()], { callFlowAvailability: availability })));
      expect(html).not.toMatch(/<svg\b/);
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
    expect(rendered).toContain("Graph");
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
    expect([...html.matchAll(/href="([^"]*)"/g)].every((match) => match[1].startsWith("#"))).toBe(true);
    expect(scriptOf(html)).not.toMatch(/fetch\(|XMLHttpRequest|localStorage/);
  });

});
