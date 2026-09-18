import type { ReviewItem, ReviewReport, ReviewStatus } from "./types.js";

/**
 * Render a review report as one self-contained HTML document.
 *
 * The page is static: no scripts, no external stylesheets, no fonts and no
 * network access. All ranking and prose is baked in, so the file can be opened
 * from disk in any browser. Every string that came from a diff, a path or a
 * model is HTML-escaped before it reaches the output.
 */
export function renderReview(report: ReviewReport): string {
  const counts = countStatuses(report.items);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(`diffninja review: ${report.title || "untitled diff"}`)}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap">',
    renderHeader(report, counts),
    renderScopeNote(),
    renderNav(report.items),
    renderItems(report.items),
    renderExtras(report),
    renderFooter(report),
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const STATUS_ORDER: readonly ReviewStatus[] = [
  "attention",
  "uncertain",
  "low",
  "passed",
];

const STATUS_LABEL = {
  attention: "Attention",
  uncertain: "Uncertain",
  low: "Low priority",
  passed: "Auto-passed",
} satisfies Record<ReviewStatus, string>;

const STATUS_NOTE = {
  attention: "Signals flagged this hunk. Read it before merging.",
  uncertain: "The judgment was not confident. This needs a human read.",
  low: "Nothing notable was found, but no human has read this hunk either.",
  passed:
    "Deterministic pass: only unchanged lines or safe blank-only text changes.",
} satisfies Record<ReviewStatus, string>;

const STATUS_EXPANDED = {
  attention: true,
  uncertain: true,
  low: true,
  passed: true,
} satisfies Record<ReviewStatus, boolean>;

function countStatuses(items: readonly ReviewItem[]) {
  const counts = {
    attention: 0,
    uncertain: 0,
    low: 0,
    passed: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

function renderHeader(
  report: ReviewReport,
  counts: Record<ReviewStatus, number>,
): string {
  const files = new Set(report.items.map((item) => item.file)).size;
  const added = sum(report.items.map((item) => item.added));
  const removed = sum(report.items.map((item) => item.removed));
  const isMock = report.mode === "mock";

  const modeBadge =
    report.mode === "mock"
      ? '<span class="badge badge-mock">Mock mode, not a review</span>'
      : '<span class="badge badge-live">Live model review</span>';
  const stats = [
    statCell("Hunks", String(report.items.length), ""),
    statCell("Files", String(files), ""),
    statCell("Attention", String(counts.attention), "attention"),
    statCell("Uncertain", String(counts.uncertain), "uncertain"),
    statCell("Low priority", String(counts.low), "low"),
    statCell("Auto-passed", String(counts.passed), "passed"),
    statCell("Lines", `+${added} / -${removed}`, ""),
    statCell("API calls", formatInteger(report.modelCalls), ""),
  ];

  return [
    '<header class="masthead">',
    '<p class="brand"><span class="brand-mark" aria-hidden="true"></span>diffninja</p>',
    `<h1>${escapeHtml(report.title || "Untitled diff")}</h1>`,
    `<p class="meta">Ranked hunk review of <span class="mono">${escapeHtml(report.source)}</span></p>`,
    `<p class="meta">Generated ${escapeHtml(report.createdAt)}</p>`,
    `<div class="badges">${modeBadge}<span class="badge">${report.items.length} hunks ranked</span><span class="badge">${formatInteger(report.modelCalls)} API calls</span></div>`,
    isMock ? renderMockBanner() : "",
    `<dl class="stats">${stats.join("")}</dl>`,
    report.warnings.length > 0 ? renderWarnings(report.warnings) : "",
    "</header>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function statCell(
  label: string,
  value: string,
  status: ReviewStatus | "",
): string {
  const modifier = status === "" ? "" : ` stat-${status}`;
  return `<div class="stat${modifier}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderMockBanner(): string {
  return [
    '<div class="banner banner-mock" role="note">',
    "<h2>Mock mode: no model saw this diff</h2>",
    "<p><strong>No API call was made.</strong> diffninja produced every judgment below from local placeholder logic so it can run without an API key. These scores are not an assessment of the change.</p>",
    "</div>",
  ].join("\n");
}

function renderWarnings(warnings: readonly string[]): string {
  const items = warnings
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join("\n");
  return [
    '<div class="banner banner-warn" role="note">',
    "<h2>Warnings from this run</h2>",
    `<ul class="warn-list">${items}</ul>`,
    "</div>",
  ].join("\n");
}

function renderScopeNote(): string {
  return [
    '<div class="banner banner-scope" role="note">',
    "<h2>Not a merge approval</h2>",
    '<p>diffninja ranks hunks so a reviewer knows where to start. It does not approve, block or merge anything. A low or auto-passed rank means no signal was found, not that the code is correct. A human still owns the decision.</p>',
    "</div>",
  ].join("\n");
}

function renderNav(items: readonly ReviewItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const links = items
    .map((item, index) => {
      const rank = index + 1;
      return [
        `<li><a class="toc-link toc-${item.status}" href="#item-${rank}">`,
        `<span class="toc-rank">#${rank}</span>`,
        `<span class="toc-path mono">${escapeHtml(item.file)}</span>`,
        `<span class="toc-status">${escapeHtml(STATUS_LABEL[item.status])}</span>`,
        "</a></li>",
      ].join("");
    })
    .join("\n");
  return [
    '<nav class="toc" aria-label="Ranked hunks">',
    '<h2>Jump to a hunk</h2>',
    `<ul class="toc-list">${links}</ul>`,
    "</nav>",
  ].join("\n");
}

function renderItems(items: readonly ReviewItem[]): string {
  if (items.length === 0) {
    return '<p class="empty">No hunks were reviewed in this diff.</p>';
  }
  const cards = items
    .map((item, index) => renderItem(item, index + 1))
    .join("\n");
  return `<section class="cards" aria-label="Ranked hunks">${cards}</section>`;
}

function renderItem(item: ReviewItem, rank: number): string {
  const open = STATUS_EXPANDED[item.status] ? " open" : "";
  const status = STATUS_LABEL[item.status];
  const special = item.special
    ? `<span class="pill pill-special">Manual review: ${escapeHtml(item.special)}</span>`
    : "";

  return [
    `<details class="card card-${item.status}" id="item-${rank}"${open}>`,
    "<summary>",
    `<span class="rank">#${rank}</span>`,
    `<span class="path" title="${escapeHtml(item.file)}">${escapeHtml(item.file)}</span>`,
    `<span class="pill pill-${item.status}">${escapeHtml(status)}</span>`,
    special,
    `<span class="lines">+${formatInteger(item.added)} <span class="del">-${formatInteger(item.removed)}</span> lines</span>`,
    "</summary>",
    renderItemBody(item),
    "</details>",
  ].join("\n");
}

function renderItemBody(item: ReviewItem): string {
  const priority = Number.isFinite(item.priority)
    ? Math.min(100, Math.max(0, Math.round(item.priority)))
    : 0;
  const facts = [
    `<li><span class="k">File</span><span class="v">${escapeHtml(item.file)}</span></li>`,
    item.header
      ? `<li><span class="k">Hunk</span><span class="v">${escapeHtml(item.header)}</span></li>`
      : "",
    `<li><span class="k">Lines</span><span class="v">${formatInteger(item.oldStart)} in the old file, ${formatInteger(item.newStart)} in the new file</span></li>`,
    `<li><span class="k">Priority</span><span class="v">${formatInteger(item.priority)} / 100</span></li>`,
  ].filter((fact) => fact !== "");

  const reasons =
    item.reasons.length > 0
      ? [
          '<h3 class="section-h">Reasons</h3>',
          `<ul class="chips">${item.reasons.map((reason) => `<li class="chip">${escapeHtml(reason)}</li>`).join("")}</ul>`,
        ].join("\n")
      : '<p class="muted">No reasons were recorded for this hunk.</p>';

  return [
    '<div class="body">',
    `<p class="note">${escapeHtml(STATUS_NOTE[item.status])}</p>`,
    `<ul class="facts">${facts.join("")}</ul>`,
    `<div class="bar" role="img" aria-label="Priority ${escapeHtml(formatInteger(item.priority))} of 100"><span class="bar-fill bar-fill-${item.status}" style="width:${priority}%"></span></div>`,
    reasons,
    renderJudgment(item),
    renderItemFlow(item.callFlow),
    renderDiff(item.diff),
    "</div>",
  ].join("\n");
}

/** Per-hunk call-flow context, when the diff produced any. */
function renderItemFlow(callFlow: readonly string[] | undefined): string {
  if (!callFlow || callFlow.length === 0) {
    return "";
  }
  const entries = callFlow
    .map((entry) => `<li>${escapeHtml(entry)}</li>`)
    .join("\n");
  return [
    '<section class="item-flow">',
    '<h3 class="section-h">Call flow for this hunk</h3>',
    `<ol class="flow">${entries}</ol>`,
    "</section>",
  ].join("\n");
}

function renderJudgment(item: ReviewItem): string {
  const judgment = item.judgment;
  if (!judgment) {
    return '<p class="muted">No model judgment was recorded for this hunk.</p>';
  }
  const confidence = Number.isFinite(judgment.confidence)
    ? `${Math.round(Math.min(1, Math.max(0, judgment.confidence)) * 100)}%`
    : "n/a";
  const cells = [
    judgmentCell("Risk", formatRubricScore(judgment.risk)),
    judgmentCell("Bug likelihood", `${Math.round(judgment.bug * 100)}%`),
    judgmentCell("Needs context", `${Math.round(judgment.needsHuman * 100)}%`),
    judgmentCell("Confidence", confidence),
    judgmentCell("Category", judgment.category || "unclassified"),
  ];
  return [
    '<section class="judgment">',
    '<h3 class="section-h">Model estimates</h3>',
    `<ul class="jv-grid">${cells.join("")}</ul>`,
    '<p class="estimate">Risk is a probability-weighted score from 0 to 3. Bug likelihood and missing-context likelihood are estimated probabilities. Confidence reflects the score and category distributions. None of these values proves a bug or proves safety.</p>',
    "</section>",
  ].join("\n");
}

function judgmentCell(label: string, value: string): string {
  return `<li class="jv"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></li>`;
}

function renderDiff(diff: string): string {
  const text = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  if (text === "") {
    return '<p class="muted">No diff text was captured for this hunk.</p>';
  }
  const lines = text
    .split("\n")
    .map(
      (line) =>
        `<span class="dl dl-${classifyDiffLine(line)}">${escapeHtml(line)}</span>`,
    )
    .join("\n");
  return [
    '<div class="diff-wrap">',
    `<pre class="diff">${lines}</pre>`,
    "</div>",
  ].join("\n");
}

function classifyDiffLine(line: string): string {
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

function renderExtras(report: ReviewReport): string {
  const flow =
    report.callFlow.length > 0
      ? report.callFlow
          .map((entry) => `<li>${escapeHtml(entry)}</li>`)
          .join("\n")
      : '<li class="muted">No call-flow context was captured for this diff.</li>';
  const legend = STATUS_ORDER.map(
    (status) =>
      `<li><span class="pill pill-${status}">${escapeHtml(STATUS_LABEL[status])}</span> <span class="muted">${escapeHtml(STATUS_NOTE[status])}</span></li>`,
  ).join("\n");

  return [
    '<section class="extras">',
    "<details>",
    `<summary>Legend and how ranking works (${STATUS_ORDER.length} statuses)</summary>`,
    `<ul class="legend">${legend}</ul>`,
    '<p class="estimate">Priority runs 0 to 100 and orders the page. Every hunk opens expanded so the full diff is visible; collapse any card to focus.</p>',
    "</details>",
    "<details>",
    `<summary>Call flow (${report.callFlow.length} entries)</summary>`,
    `<ol class="flow">${flow}</ol>`,
    "</details>",
    "</section>",
  ].join("\n");
}

function renderFooter(report: ReviewReport): string {
  return [
    '<footer class="foot">',
    `<p>Source: <span class="mono">${escapeHtml(report.source)}</span></p>`,
    `<p>Generated by diffninja at ${escapeHtml(report.createdAt)} in ${escapeHtml(report.mode)} mode using ${formatInteger(report.modelCalls)} API calls.</p>`,
    "<p>This page is a static file: it runs no scripts and makes no network requests. Every diff line is escaped text.</p>",
    "<p>Not a merge approval. A human reviewer remains responsible for the change.</p>",
    "</footer>",
  ].join("\n");
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

function formatInteger(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "n/a";
}

function formatRubricScore(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value * 10) / 10} / 3`;
}

/** Escape text for HTML element and attribute contexts. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f1ea;
  --panel: #fffdf9;
  --sunken: #f9f5ef;
  --ink: #2b2521;
  --ink-soft: #6b5f56;
  --line: #e6dbcf;
  --line-strong: #d8c9b8;
  --accent: #c05a1d;
  --accent-bg: #fdf0e6;
  --accent-line: #e5b593;
  --teal: #12615d;
  --teal-bg: #e8f2f1;
  --teal-line: #a8ccc9;
  --warn: #a2701f;
  --warn-ink: #8a5410;
  --warn-bg: #fdf3e2;
  --warn-line: #e8c894;
  --alarm: #c22e2e;
  --alarm-bg: #fdecec;
  --alarm-line: #f0b3b3;
  --add: #14615c;
  --add-bg: #e9f3f1;
  --del: #a2432a;
  --del-bg: #fbeee9;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1917;
    --panel: #242120;
    --sunken: #1f1c1b;
    --ink: #f2ece5;
    --ink-soft: #b3a69b;
    --line: #3a3330;
    --line-strong: #4d443e;
    --accent: #f09355;
    --accent-bg: #32251d;
    --accent-line: #6d4529;
    --teal: #6cc5bd;
    --teal-bg: #182827;
    --teal-line: #2f5c58;
    --warn: #e0b372;
    --warn-ink: #e0b372;
    --warn-bg: #2e2418;
    --warn-line: #6b4f26;
    --alarm: #ff8a8a;
    --alarm-bg: #331f1e;
    --alarm-line: #7a3a36;
    --add: #7fd0c6;
    --add-bg: #152a29;
    --del: #f0a48b;
    --del-bg: #2f1f1a;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 400 16px/1.55 var(--sans);
}
.wrap { max-width: 1060px; margin: 0 auto; padding: 26px 20px 64px; }
h1, h2, h3 { margin: 0; line-height: 1.25; }
p { margin: 0; }
a { color: var(--teal); }
.mono, code { font-family: var(--mono); }
.muted { color: var(--ink-soft); }
.masthead {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 18px;
  border-bottom: 2px solid var(--line-strong);
}
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}
.brand-mark {
  width: 15px;
  height: 15px;
  background: linear-gradient(90deg, var(--accent) 0 50%, var(--teal) 50% 100%);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}
h1 { font-size: clamp(1.35rem, 1.05rem + 1.3vw, 1.9rem); overflow-wrap: anywhere; }
.meta { font-size: 13.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--sunken);
  color: var(--ink-soft);
}
.badge-mock { background: var(--accent-bg); border-color: var(--accent-line); color: var(--accent); }
.badge-live { background: var(--teal-bg); border-color: var(--teal-line); color: var(--teal); }
.banner {
  border: 1px solid var(--line-strong);
  border-left-width: 5px;
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--sunken);
  font-size: 14px;
}
.banner h2 { font-size: 12.5px; letter-spacing: 0.12em; text-transform: uppercase; }
.banner p { margin-top: 6px; }
.banner-mock { background: var(--accent-bg); border-color: var(--accent-line); border-left-color: var(--accent); }
.banner-warn { background: var(--warn-bg); border-color: var(--warn-line); }
.banner-scope { background: var(--panel); border-left-color: var(--teal); }
.warn-list { margin: 6px 0 0; padding-left: 20px; }
.warn-list li { overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; margin: 0; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; }
.stat dt { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); }
.stat dd { margin: 2px 0 0; font-family: var(--mono); font-size: 20px; font-weight: 600; }
.stat-attention dd { color: var(--alarm); }
.stat-uncertain dd { color: var(--warn-ink); }
.stat-low dd { color: var(--ink-soft); }
.stat-passed dd { color: var(--teal); }
.toc {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  padding: 12px 0;
  margin-bottom: 8px;
}
.toc h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 8px; }
.toc-list { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }
.toc-list > li { min-width: 0; max-width: 100%; }
.toc-link {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 5px 11px 5px 9px;
  text-decoration: none;
  color: var(--ink);
  background: var(--panel);
  font-size: 12.5px;
}
.toc-link:hover, .toc-link:focus-visible { border-color: var(--teal); color: var(--teal); }
.toc-rank { font-family: var(--mono); font-weight: 700; color: var(--ink-soft); }
.toc-path { min-width: 0; max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-status { flex: 0 0 auto; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); }
.toc-attention .toc-status { color: var(--alarm); font-weight: 700; }
.toc-uncertain .toc-status { color: var(--warn-ink); }
.toc-passed .toc-status { color: var(--teal); }
.cards { margin: 0; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 5px solid var(--line-strong);
  border-radius: 14px;
  margin: 0 0 12px;
  overflow: hidden;
}
.card-attention {
  border-left-color: var(--alarm);
  box-shadow: 0 0 0 1px var(--alarm-line);
}
.card-attention > summary { background: var(--alarm-bg); }
.card-attention > summary:hover { background: var(--alarm-bg); }
.card-uncertain { border-left-color: var(--warn); }
.card-low { border-left-color: var(--line-strong); }
.card-passed { border-left-color: var(--teal); }
.card > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
}
.card > summary::-webkit-details-marker { display: none; }
.card > summary::after {
  content: "\\25B8";
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-soft);
  transition: transform 0.15s ease;
}
.card[open] > summary::after { transform: rotate(90deg); }
.card > summary:hover { background: var(--sunken); }
.card > summary:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
.rank {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-soft);
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px 7px;
}
.path { flex: 1 1 220px; min-width: 0; font-family: var(--mono); font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.pill {
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.pill-attention { background: var(--alarm-bg); color: var(--alarm); border-color: var(--alarm); }
.pill-uncertain { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-line); }
.pill-low { background: var(--sunken); color: var(--ink-soft); border-color: var(--line-strong); }
.pill-passed { background: var(--teal-bg); color: var(--teal); border-color: var(--teal-line); }
.pill-special { background: var(--del-bg); color: var(--del); border-color: var(--del); max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.lines { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; }
.lines .del { color: var(--del); }
.body { border-top: 1px solid var(--line); padding: 0 14px 14px; }
.note { margin: 12px 0; font-size: 13.5px; color: var(--ink-soft); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 16px; margin: 0 0 12px; padding: 0; list-style: none; }
.facts li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.facts .k { flex: 0 0 auto; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); }
.facts .v { min-width: 0; font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.bar { height: 7px; border: 1px solid var(--line); border-radius: 999px; background: var(--sunken); overflow: hidden; margin: 0 0 12px; }
.bar-fill { display: block; height: 100%; background: linear-gradient(90deg, var(--teal), var(--accent)); }
.bar-fill-attention { background: var(--alarm); }
.bar-fill-uncertain { background: var(--warn); }
.bar-fill-low { background: var(--line-strong); }
.bar-fill-passed { background: var(--teal); }
.card-attention .chip { border-color: var(--alarm-line); background: var(--alarm-bg); }
.section-h { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); margin: 0 0 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
.chip {
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--sunken);
  padding: 3px 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.judgment { margin: 0 0 12px; }
.item-flow { margin: 0 0 12px; }
.jv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.jv { background: var(--sunken); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
.jv .k { display: block; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); }
.jv .v { font-family: var(--mono); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.estimate { margin-top: 8px; font-size: 12px; color: var(--ink-soft); }
.diff-wrap {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--sunken);
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
pre.diff {
  margin: 0;
  padding: 10px 0;
  min-width: max-content;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
  tab-size: 4;
  white-space: pre;
}
.dl { display: block; padding: 0 14px; }
.dl-context { color: var(--ink); }
.dl-add { background: var(--add-bg); color: var(--add); }
.dl-del { background: var(--del-bg); color: var(--del); }
.dl-hunk { background: var(--teal-bg); color: var(--teal); font-weight: 600; }
.dl-meta { color: var(--ink-soft); }
.empty { padding: 20px 0; color: var(--ink-soft); }
.extras { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
.extras details { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.extras summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
  padding: 11px 14px;
  font-size: 14px;
  font-weight: 600;
}
.extras summary::-webkit-details-marker { display: none; }
.extras summary::after {
  content: "\\25B8";
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-soft);
  transition: transform 0.15s ease;
}
.extras details[open] summary::after { transform: rotate(90deg); }
.extras > details > p, .legend, .flow { margin: 0; padding: 0 14px 14px; }
.legend { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.legend li { overflow-wrap: anywhere; }
.flow { list-style: none; }
.flow li { font-family: var(--mono); font-size: 12.5px; padding: 6px 0; border-top: 1px dashed var(--line); overflow-wrap: anywhere; }
.flow li:first-child { border-top: 0; }
.foot { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-soft); }
.foot p { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 680px) {
  .wrap { padding: 18px 13px 48px; }
  .toc { position: static; padding: 10px 0; }
  .toc-link { width: 100%; }
  .toc-path { max-width: none; flex: 1 1 auto; }
  .facts { grid-template-columns: 1fr; }
  .stat dd { font-size: 17px; }
  .card > summary { gap: 8px; padding: 11px 12px; }
  .body { padding: 0 12px 12px; }
}
`;
