import { describe, expect, test } from "vitest";
import { renderReview } from "../src/review/html.js";
import type { Judgment, ReviewItem, ReviewReport } from "../src/review/types.js";
import type {
  AutomaticFinding,
  EvidenceExcerpt,
  ReviewAgendaEntry,
  ReviewEvidence,
} from "../src/review/evidence-types.js";

const ATTACK = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
/**
 * The attack string in a closed-set answer position. The adapter validates every
 * field and fails closed, so this value is unreachable through the real pipeline:
 * the fixtures below exist to prove the renderer names an out-of-set answer
 * instead of echoing it.
 */
// SAFETY: deliberately invalid fixture, used only to exercise closed-set renderer rejection.
const NOT_AN_ANSWER = ATTACK as never;

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
    reasons: ["Unrendered fixture reason text"],
    ...overrides,
  };
}

/**
 * A complete answer set, so each test names only the answers it asserts: every
 * question is answered, and a hunk with no property shown is `no` with an
 * unchanged outcome.
 */
function judgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    outcome: "unchanged",
    comparisonChanged: "no",
    limitChanged: "no",
    validationChanged: "no",
    failurePropagated: "no",
    failureDeferred: "no",
    failureDiscarded: "no",
    confidence: 0.5,
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
            judgment: {
              outcome: NOT_AN_ANSWER,
              comparisonChanged: NOT_AN_ANSWER,
              limitChanged: NOT_AN_ANSWER,
              validationChanged: NOT_AN_ANSWER,
              failurePropagated: NOT_AN_ANSWER,
              failureDeferred: NOT_AN_ANSWER,
              failureDiscarded: NOT_AN_ANSWER,
              confidence: 0.8,
            },
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

  test("distinguishes a context-limit skip from a judged uncertain hunk without extra counts", () => {
    const skipped = item({
      id: "caller", file: "caller.ts", diff: "@@ -1 +1 @@\n-callee(arg);\n+callee(arg + 1);",
      status: "uncertain", priority: 70, reasons: [],
      routing: { evaluation: "not_evaluated", reasonCode: "context_limit_exceeded", requiredChars: 25000, limitChars: 24000 },
    });
    const judged = item({ ...skipped, id: "callee", routing: undefined,
      judgment: judgment({ outcome: "changed", limitChanged: "yes" }) });
    const rendered = visible(renderReview(report([skipped, judged])));
    const found = cards(rendered);
    expect(found).toHaveLength(2);
    expect(found[0].html).toContain("Not evaluated:");
    expect(found[0].html).toContain("25000");
    expect(found[0].html).toContain("24000");
    expect(found[1].html).not.toContain("Not evaluated:");
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
      judgment: judgment({ outcome: "changed", limitChanged: "yes", failureDiscarded: "yes", confidence: 0.4 }),
    });
    const html = visible(renderReview(report([unit], {
      modelCalls: 3, warnings: ["Private assessment metadata"], callFlow: [],
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

  test("every typed answer renders from its closed set, and an unrecognized value is never echoed", () => {
    const unit = item({
      file: "src/lease.ts",
      status: "uncertain",
      reasons: ["model confidence 0.6 (self-reported by one response; informational, not a ranking gate)"],
      judgment: judgment({
        outcome: "changed",
        comparisonChanged: "yes",
        validationChanged: "yes",
        failurePropagated: "yes",
        failureDiscarded: "unknown",
        confidence: 0.6,
      }),
    });
    const html = visible(renderReview(report([unit])));
    const obs = /<details class="obs">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    // Every question reaches the reviewer, in the adapter's order, with its own
    // answer: the six atomic answers are independent, so three `yes` answers
    // coexist and an unanswered property stays `no` rather than inheriting one.
    const rows = [...obs.matchAll(/<dt>([^<]*)<\/dt><dd class="mono">([^<]*)/g)]
      .map((match) => [match[1], match[2].trim()] as const);
    expect(rows).toEqual([
      ["Outcome the lines produce", "changed"],
      ["Comparison changed", "yes"],
      ["Limit, size, or offset changed", "no"],
      ["Validation or shape check changed", "yes"],
      ["Failure propagated", "yes"],
      ["Failure deferred", "no"],
      ["Failure discarded", "unknown"],
    ]);
    expect(obs).not.toMatch(/confidence/i);

    // A returned value outside its documented set is named, never echoed.
    const hostile = item({
      reasons: [],
      judgment: judgment({ outcome: NOT_AN_ANSWER, comparisonChanged: NOT_AN_ANSWER }),
    });
    const other = visible(renderReview(report([hostile])));
    expect(other).not.toContain(ATTACK);
    expect(other).toContain('<dt>Outcome the lines produce</dt><dd class="mono">unrecognized value</dd>');
    expect(other).toContain('<dt>Comparison changed</dt><dd class="mono">unrecognized value</dd>');
    expect(other).toContain('<dt>Limit, size, or offset changed</dt><dd class="mono">no</dd>');
  });

  test("an unknown answer reads as missing evidence, never as a defect or as an absence", () => {
    const html = visible(renderReview(report([item({
      status: "uncertain",
      judgment: judgment({
        outcome: "unknown",
        limitChanged: "unknown",
        validationChanged: "unknown",
      }),
    })])));
    const obs = /<details class="obs">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    // `unknown` is spelled out, so it cannot be read as a "no" (absence) claim, and
    // the outcome it applies to is the same statement about the evidence.
    expect(obs).toContain("not determined from the supplied state; a person should decide");
    expect(obs).toMatch(
      /Outcome the lines produce and Limit, size, or offset changed and Validation or shape check changed could not be determined/,
    );
    // An answer the state settles still reads as its own answer.
    expect(obs).toContain('<dt>Comparison changed</dt><dd class="mono">no</dd>');
    // The escalation is a hint under the observations, not a warning banner.
    expect(obs).not.toMatch(/bug|defect found|error|issue|problem with the code/i);
  });

  test("a hunk with no sample renders no observation block", () => {
    const html = visible(renderReview(report([item({ judgment: undefined })])));
    expect(html).not.toContain('<details class="obs">');
    expect(html).toContain("+const total = price + tax;");
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
    // The severity legend is in the markup, not just in the stylesheet.
    expect(visible(html)).toContain(
      '<span class="dot dot-attention" aria-hidden="true"></span>Attention: read first',
    );
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
    expect(html).toContain('<a class="cf-mode-link enhanced" data-cf-mode="graph"');
    expect(html).toMatch(/<noscript class="cf-noscript">.*Graph and Sequence are alternate renderings/s);
    expect(html).toContain("The diff holds every changed line.");
    // The markup is still all there for a reader without the script.
    expect(html).toContain("charge");
    expect(graph).toMatch(/<svg\b/);
    expect(html.match(/<template\b/g)).toHaveLength(2);
  });

});
