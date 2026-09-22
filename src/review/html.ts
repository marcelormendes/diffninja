import type { ReviewItem, ReviewReport, ReviewStatus } from "./types.js";
import {
  ATOMIC_OBSERVATIONS,
  ATOMIC_QUESTIONS,
  OUTCOME_CHOICES,
  type AtomicQuestion,
} from "./jev.js";
import { renderCallFlows, CALL_FLOW_STYLES, CALL_FLOW_SCRIPT } from "./call-flow-html.js";
import { renderBrief, BRIEF_STYLES } from "./evidence-html.js";
import { escapeHtml } from "./escape-html.js";

/**
 * Render a review report as one self-contained HTML document.
 *
 * The document opens on the expected outcome: the pull request text, the intent
 * cross-check, the checks that ran with their limits, and a short reading agenda
 * whose top cards link the changed code, its direct caller or its contract. The
 * call flow and the full diff are the other two views of the same document, so a
 * reviewer reaches a hunk from the agenda in one click and every hunk stays
 * reachable, including the ones no evaluation covers.
 *
 * The page is still a plain diff review underneath: file header, hunks with line
 * numbers and green/red lines, ranking deciding order and severity reaching the
 * reviewer as color. Ranking scores, model probabilities and the adapter's own
 * rubric text stay in the JSON sidecar: the only model-derived content on the
 * page is the hunk's own single-sample typed observations, printed from closed
 * sets under a label that says what they are.
 *
 * Everything is server-rendered, so the report is readable with JavaScript
 * disabled; without the script the three views stack as sections and every hunk
 * is one disclosure away. The single inline script is progressive enhancement:
 * view switching, expand and collapse, status filters that keep their fold
 * state, focus mode, and a keyboard cursor. No report string is placed in the
 * script; it reads labels from the DOM. Every string from a diff, path, pull
 * request body or report field is HTML-escaped.
 */
export function renderReview(report: ReviewReport): string {
  const counts = countStatuses(report.items);
  const body =
    report.items.length === 0
      ? '<p class="empty">No hunks were reviewed in this diff.</p>'
      : [
          '<div class="toolbar" id="toolbar">',
          renderControls(counts),
          renderBreadcrumb(),
          renderNav(report.items),
          "</div>",
          '<p class="empty" id="filter-empty" hidden>No hunks match the selected statuses.</p>',
          renderItems(report.items),
        ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(`diffninja review: ${report.title || "untitled diff"}`)}</title>`,
    `<style>${STYLES}\n${BRIEF_STYLES}\n${CALL_FLOW_STYLES}</style>`,
    "</head>",
    `<body data-default-view="${report.evidence === undefined ? "call-flow" : "brief"}">`,
    '<div class="wrap">',
    renderHeader(report),
    '<nav class="view-switch" aria-label="Report view">',
    '<a href="#view-brief" data-view="brief">Outcome</a>',
    '<a href="#view-call-flow" data-view="call-flow">Call flow</a>',
    '<a href="#view-diff" data-view="diff">Diff</a>',
    "</nav>",
    `<section class="brief" id="view-brief" aria-label="Expected outcome and reading agenda">${renderBrief(report)}</section>`,
    '<section id="view-call-flow" aria-label="Call flow">',
    renderCallFlows(report),
    "</section>",
    '<section id="view-diff" aria-label="Diff">',
    body,
    "</section>",
    renderFooter(report),
    "</div>",
    `<script>${SCRIPT}\n${CALL_FLOW_SCRIPT}</script>`,
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
  low: "Low",
  passed: "Passed",
} satisfies Record<ReviewStatus, string>;

/** A compact legend is the only explanation of the severity colors. */
const STATUS_HINT = {
  attention: "read first",
  uncertain: "needs a human read",
  low: "nothing notable found",
  passed: "unchanged or blank-only",
} satisfies Record<ReviewStatus, string>;


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

function renderHeader(report: ReviewReport): string {
  const files = new Set(report.items.map((item) => item.file)).size;
  const added = sum(report.items.map((item) => item.added));
  const removed = sum(report.items.map((item) => item.removed));
  const scope =
    report.items.length === 0
      ? ""
      : `${report.items.length} hunks in ${files} files, +${formatInteger(added)} / -${formatInteger(removed)} lines, generated ${report.createdAt}`;
  const mode =
    report.mode === "mock"
      ? "Mock data — navigation preview only, not a code assessment."
      : "Live data — review changes before merging.";

  return [
    '<header class="masthead">',
    '<p class="brand"><span class="brand-mark" aria-hidden="true"></span>diffninja</p>',
    `<h1>${escapeHtml(report.title || "Untitled diff")}</h1>`,
    `<p class="meta">Files changed · <span class="mono">${escapeHtml(report.source)}</span></p>`,
    scope === "" ? "" : `<p class="meta">${escapeHtml(scope)}</p>`,
    `<p class="mode-note">${mode}</p>`,
    renderLegend(),
    "</header>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** One color line, no jargon. Counting is left to the filter chips. */
function renderLegend(): string {
  const keys = STATUS_ORDER.map(
    (status) =>
      `<span class="key"><span class="dot dot-${status}" aria-hidden="true"></span>${escapeHtml(`${STATUS_LABEL[status]}: ${STATUS_HINT[status]}`)}</span>`,
  ).join("");
  return `<p class="legend">${keys}</p>`;
}


function renderControls(counts: Record<ReviewStatus, number>): string {
  const chips = STATUS_ORDER.map(
    (status) =>
      `<button type="button" class="pill pill-${status}" data-filter="${status}" data-count="${counts[status]}" aria-pressed="true">` +
      `<span class="dot dot-${status}" aria-hidden="true"></span>${escapeHtml(STATUS_LABEL[status])}` +
      `<span class="pill-n mono">${counts[status]}</span></button>`,
  ).join("");
  return [
    '<div class="controls enhanced" role="group" aria-label="Report controls">',
    '<button type="button" data-action="expand">Expand all</button>',
    '<button type="button" data-action="collapse">Collapse all</button>',
    `<div class="filters" role="group" aria-label="Show or hide hunks by status">${chips}</div>`,
    '<span class="keyboard-help">j/k or arrows move · Enter folds · f focuses · Esc returns</span>',
    "</div>",
  ].join("\n");
}

function renderBreadcrumb(): string {
  return [
    '<nav id="breadcrumb" aria-label="Focus breadcrumb" hidden>',
    '<button type="button" data-action="back">Report</button>',
    '<span class="crumb-sep" aria-hidden="true">/</span>',
    '<span class="crumb-rank mono" id="focus-rank"></span>',
    '<span class="crumb-path mono" id="focus-path"></span>',
    "</nav>",
  ].join("\n");
}

function renderNav(items: readonly ReviewItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const links = items
    .map((item, index) => {
      const rank = index + 1;
      const status = escapeHtml(item.status);
      return [
        "<li>",
        `<a class="toc-link" data-open-hunk href="#item-${rank}">`,
        `<span class="toc-rank mono">#${rank}</span>`,
        `<span class="dot dot-${status}" aria-hidden="true"></span>`,
        `<span class="toc-path mono">${escapeHtml(item.file)}</span>`,
        `<span class="sr">${escapeHtml(STATUS_LABEL[item.status])}</span>`,
        "</a></li>",
      ].join("");
    })
    .join("\n");
  return [
    '<nav class="toc" aria-label="Jump to a hunk">',
    '<button type="button" class="jump-toggle enhanced" aria-expanded="false" aria-controls="jump-links">Jump to a hunk</button>',
    `<ul class="toc-list" id="jump-links">${links}</ul>`,
    "</nav>",
  ].join("\n");
}

function renderItems(items: readonly ReviewItem[]): string {
  const cards = items
    .map((item, index) => renderItem(item, index + 1))
    .join("\n");
  return `<section class="cards" aria-label="Hunks">${cards}</section>`;
}

/** Plain file header row: rank focus button, path, line growth. */
function renderItem(item: ReviewItem, rank: number): string {
  const status = escapeHtml(item.status);
  return [
    // Closed by default: a fresh report opens on the agenda, and the diff stays
    // a short list of hunk headers until a reviewer opens what they came for.
    `<details class="card card-${status}" data-status="${status}" id="item-${rank}">`,
    "<summary>",
    `<span class="rank fallback-rank mono">#${rank}</span>`,
    `<button type="button" class="rank enhanced mono" data-focus aria-label="Focus hunk ${rank}">#${rank}</button>`,
    `<span class="path mono">${escapeHtml(item.file)}</span>`,
    `<span class="sr">${escapeHtml(STATUS_LABEL[item.status])}</span>`,
    `<span class="growth mono"><span class="plus">+${formatInteger(item.added)}</span> <span class="minus">-${formatInteger(item.removed)}</span></span>`,
    `<button type="button" class="focus-button enhanced" data-focus aria-label="Focus hunk ${rank}">Focus</button>`,
    "</summary>",
    renderItemBody(item),
    "</details>",
  ].join("\n");
}

function renderItemBody(item: ReviewItem): string {
  const special =
    item.special === undefined || item.special === ""
      ? ""
      : `<p class="note">Manual review: ${escapeHtml(item.special)}</p>`;
  return [
    '<div class="body">',
    special,
    renderObservations(item),
    item.routing?.evaluation === "not_evaluated"
      ? `<p class="note">Not evaluated: essential context requires ${formatInteger(item.routing.requiredChars)} characters; the limit is ${formatInteger(item.routing.limitChars)}. No model judgment was recorded; manual review is required.</p>`
      : "",
    renderDiff(item.diff),
    "</div>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** Human label per atomic question, in the order the adapter asks them. */
const ATOMIC_QUESTION_LABEL = {
  comparisonChanged: "Comparison changed",
  limitChanged: "Limit, size, or offset changed",
  validationChanged: "Validation or shape check changed",
  failurePropagated: "Failure propagated",
  failureDeferred: "Failure deferred",
  failureDiscarded: "Failure discarded",
} satisfies Record<AtomicQuestion, string>;

/** Spelled out beside an answer the supplied state could not determine. */
const UNDETERMINED_NOTE = "not determined from the supplied state; a person should decide";

/** One rendered answer: its question, the closed set it answers, and the answer. */
interface ObservationRow {
  readonly label: string;
  readonly values: readonly string[];
  readonly value: string;
}

/**
 * What one model sample observed about this hunk, when a sample was taken.
 *
 * Every answer comes from a closed set and is printed only when it is one of the
 * documented values: a value outside its set is named as unrecognized rather
 * than echoed, so no model-authored text reaches the page. The outcome is one
 * unordered choice — changed, unchanged, or unknown — and the six atomic answers
 * are independent existence questions about the added or removed lines, several
 * of which may be `yes` at once.
 *
 * `yes` is a property those lines themselves show; `no` speaks only about the
 * lines the state shows, never about the rest of the codebase; `unknown` means
 * the supplied state cannot determine the answer, and the adapter records it for
 * an answer whose own distribution did not separate one option as well. An answer
 * of `unknown` is printed with its meaning spelled out and is never shown as a
 * finding: it is a fact about the evidence, not about the code. Nothing here reads
 * `reasons` or any other prose. No probability or vendor confidence is shown.
 */
function renderObservations(item: ReviewItem): string {
  const judgment = item.judgment;
  if (judgment === undefined) {
    return "";
  }
  const rows: readonly ObservationRow[] = [
    { label: "Outcome the lines produce", values: OUTCOME_CHOICES, value: judgment.outcome },
    ...ATOMIC_QUESTIONS.map((question) => ({
      label: ATOMIC_QUESTION_LABEL[question],
      values: ATOMIC_OBSERVATIONS,
      value: judgment[question],
    })),
  ];
  const undetermined = new Set<string>();
  const list = rows
    .map((row) => {
      let shown: string;
      if (row.values.includes(row.value)) {
        shown = escapeHtml(row.value);
        if (row.value === "unknown") {
          undetermined.add(row.label);
          shown += ` <span class="obs-unknown">${UNDETERMINED_NOTE}</span>`;
        }
      } else {
        shown = escapeHtml("unrecognized value");
      }
      return `<dt>${escapeHtml(row.label)}</dt><dd class="mono">${shown}</dd>`;
    })
    .join("");
  // The escalation line is the typed-field reading of `status`, not a verdict.
  const hints: string[] = [];
  if (undetermined.size > 0) {
    hints.push(
      `${[...undetermined].join(" and ")} could not be determined from the supplied state, so this hunk is marked for a human read. That is not a claim about the code.`,
    );
  }
  return [
    '<details class="obs">',
    '<summary>Single-sample typed observations</summary>',
    '<div class="obs-body">',
    '<p class="note">One sample for this hunk. Every question is answered on its own, about the added and removed lines and the context listed below: yes when those lines show that property, which several can at once; no when these lines show no such property, which is not a statement about the rest of the code; unknown when the supplied state cannot determine it, never because another question applied. Descriptive answers, not a verdict, and not a merge approval.</p>',
    `<dl class="obs-list">${list}</dl>`,
    // Informational, in the dimmest style the report has.
    ...hints.map((hint) => `<p class="note obs-note">${escapeHtml(hint)}</p>`),
    "</div>",
    "</details>",
  ].join("\n");
}

/** How one rendered diff line is shaped, once it has been classified. */
interface DiffRow {
  readonly kind: "hunk" | "add" | "del" | "context" | "meta" | "note";
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

/**
 * Split a stored hunk into rows with gutter numbers.
 *
 * Classification is positional: the first line of a parsed hunk is the `@@`
 * header and every later line starts with its diff marker. A deletion of a
 * line whose text begins with `--` therefore stays a deletion instead of
 * looking like a `--- file` header. Only a file-metadata unit, which stores
 * `diff --git` / `---` / `+++` lines, is classified by prefix.
 */
function diffRows(diff: string): DiffRow[] {
  const text = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  if (text === "") {
    return [];
  }
  const raw = text.split("\n");
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw[0]);
  if (!header) {
    return raw.map((line) => ({
      kind: "meta" as const,
      text: line,
      oldNo: null,
      newNo: null,
    }));
  }
  let oldNo = Number(header[1]);
  let newNo = Number(header[3]);
  const rows: DiffRow[] = [
    { kind: "hunk", text: raw[0], oldNo: null, newNo: null },
  ];
  for (let i = 1; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line above, so no numbers.
      rows.push({ kind: "note", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line, oldNo: null, newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line, oldNo, newNo: null });
      oldNo += 1;
    } else {
      rows.push({ kind: "context", text: line, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return rows;
}

function renderDiff(diff: string): string {
  const rows = diffRows(diff);
  if (rows.length === 0) {
    return '<p class="note">No diff text was captured for this hunk.</p>';
  }
  // Joined without whitespace: the gutter and code spans are grid items, so the
  // rows must not be separated by text nodes.
  const body = rows
    .map(
      (row) =>
        `<span class="ln ln-${row.kind}">` +
        `<span class="old-no" aria-hidden="true">${row.oldNo === null ? "" : String(row.oldNo)}</span>` +
        `<span class="new-no" aria-hidden="true">${row.newNo === null ? "" : String(row.newNo)}</span>` +
        `<span class="code">${escapeHtml(row.text)}</span>` +
        "</span>",
    )
    .join("");
  return [
    '<div class="diff-wrap">',
    `<pre class="diff">${body}</pre>`,
    "</div>",
  ].join("\n");
}


function renderFooter(report: ReviewReport): string {
  return [
    '<footer class="foot">',
    `<p>Source: <span class="mono">${escapeHtml(report.source)}</span></p>`,
    "<p>Offline report · All changes remain readable without JavaScript · Not a merge approval.</p>",
    "</footer>",
  ].join("\n");
}

// One toolbar script. No report string is interpolated into it: it reads the
// labels it needs from the escaped DOM, so a crafted path, diff or pull request
// body cannot reach the inline script.
const SCRIPT = `
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  var briefView = document.getElementById('view-brief');
  var diffView = document.getElementById('view-diff');
  var flowView = document.getElementById('view-call-flow');
  var viewLinks = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
  var VIEWS = { brief: briefView, 'call-flow': flowView, diff: diffView };
  function showView(name) {
    for (var key in VIEWS) {
      if (VIEWS[key]) VIEWS[key].hidden = key !== name;
    }
    viewLinks.forEach(function (link) {
      if (link.getAttribute('data-view') === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  // The hash may name a view or any element inside one, which is where the
  // agenda and the call flow both point.
  function viewForHash() {
    var hash = location.hash;
    if (hash === '') return null;
    if (VIEWS[hash.slice(1)]) return hash.slice(1);
    var target = document.getElementById(hash.slice(1));
    if (!target) return null;
    for (var key in VIEWS) {
      if (VIEWS[key] && VIEWS[key].contains(target)) return key;
    }
    return null;
  }
  // A new report carries an agenda, so that is what it opens on: the body names
  // the opening view. A report without a cross-check opens on the call flow, its
  // most useful overview, and an explicit hash always wins.
  showView(viewForHash() || document.body.getAttribute('data-default-view') || 'call-flow');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var filters = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var toolbar = document.getElementById('toolbar');
  var breadcrumb = document.getElementById('breadcrumb');
  var focusRank = document.getElementById('focus-rank');
  var focusPath = document.getElementById('focus-path');
  var jump = document.querySelector('.jump-toggle');
  var empty = document.getElementById('filter-empty');
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc-link'));
  var cursor = 0;
  var focusIndex = -1;
  var focusWasOpen = true;
  var returnControl = null;
  var returnScroll = 0;

  function statusesOn() {
    return filters.filter(function (chip) {
      return chip.getAttribute('aria-pressed') === 'true';
    }).map(function (chip) { return chip.getAttribute('data-filter'); });
  }

  function visible() {
    var list = [];
    cards.forEach(function (card, index) { if (!card.hidden) list.push(index); });
    return list;
  }

  function setCursor(index, move) {
    if (index < 0 || index >= cards.length) return;
    cursor = index;
    cards.forEach(function (card, at) { card.classList.toggle('cursor', at === index); });
    if (!move) return;
    var card = cards[index];
    var summary = card.querySelector('summary');
    if (summary) summary.focus({ preventScroll: true });
    measureToolbar();
    card.scrollIntoView({ block: 'start' });
  }

  function apply() {
    var on = statusesOn();
    cards.forEach(function (card, index) {
      card.hidden = focusIndex >= 0 ? index !== focusIndex : on.indexOf(card.getAttribute('data-status')) < 0;
    });
    links.forEach(function (link) {
      var target = document.getElementById(link.hash.slice(1));
      var item = link.parentElement;
      if (target && item) item.hidden = target.hidden;
    });
    filters.forEach(function (chip) { chip.disabled = focusIndex >= 0; });
    document.body.classList.toggle('focus-mode', focusIndex >= 0);
    breadcrumb.hidden = focusIndex < 0;
    var shown = visible();
    if (empty) empty.hidden = shown.length > 0;
    if (!cards[cursor] || cards[cursor].hidden) {
      if (shown.length) setCursor(shown[0], false);
    }
  }

  // One reveal for every link that points at a hunk: clear the view state that
  // could hide it (a status filter, focus mode, another view) and open it.
  function revealHunk(hash) {
    var target = document.getElementById(hash.slice(1));
    if (!target) return false;
    if (focusIndex >= 0) exitFocus();
    filters.forEach(function (chip) { chip.setAttribute('aria-pressed', 'true'); });
    showView('diff');
    apply();
    target.open = true;
    setJump(false);
    setCursor(cards.indexOf(target), true);
    history.replaceState(null, '', hash);
    return true;
  }
  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;
    var link = event.target.closest('[data-view]');
    if (!link) return;
    event.preventDefault();
    if (cards.length && focusIndex >= 0) exitFocus();
    showView(link.getAttribute('data-view'));
    history.replaceState(null, '', link.hash);
  });
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  if (!cards.length) return;
  var filters = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var toolbar = document.getElementById('toolbar');
  var breadcrumb = document.getElementById('breadcrumb');
  var focusRank = document.getElementById('focus-rank');
  var focusPath = document.getElementById('focus-path');
  var jump = document.querySelector('.jump-toggle');
  var empty = document.getElementById('filter-empty');
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc-link'));
  var cursor = 0;
  var focusIndex = -1;
  var focusWasOpen = true;
  var returnControl = null;
  var returnScroll = 0;

  function statusesOn() {
    return filters.filter(function (chip) {
      return chip.getAttribute('aria-pressed') === 'true';
    }).map(function (chip) { return chip.getAttribute('data-filter'); });
  }

  function visible() {
    var list = [];
    cards.forEach(function (card, index) { if (!card.hidden) list.push(index); });
    return list;
  }

  function setCursor(index, move) {
    if (index < 0 || index >= cards.length) return;
    cursor = index;
    cards.forEach(function (card, at) { card.classList.toggle('cursor', at === index); });
    if (!move) return;
    var card = cards[index];
    var summary = card.querySelector('summary');
    if (summary) summary.focus({ preventScroll: true });
    measureToolbar();
    card.scrollIntoView({ block: 'start' });
  }

  function apply() {
    var on = statusesOn();
    cards.forEach(function (card, index) {
      card.hidden = focusIndex >= 0 ? index !== focusIndex : on.indexOf(card.getAttribute('data-status')) < 0;
    });
    links.forEach(function (link) {
      var target = document.getElementById(link.hash.slice(1));
      var item = link.parentElement;
      if (target && item) item.hidden = target.hidden;
    });
    filters.forEach(function (chip) { chip.disabled = focusIndex >= 0; });
    document.body.classList.toggle('focus-mode', focusIndex >= 0);
    breadcrumb.hidden = focusIndex < 0;
    var shown = visible();
    if (empty) empty.hidden = shown.length > 0;
    if (!cards[cursor] || cards[cursor].hidden) {
      if (shown.length) setCursor(shown[0], false);
    }
  }

  function enterFocus(index, control) {
    if (index < 0 || index >= cards.length || focusIndex >= 0) return;
    var card = cards[index];
    focusIndex = index;
    focusWasOpen = card.open;
    returnControl = control && control.focus ? control : null;
    returnScroll = window.scrollY;
    card.open = true;
    focusRank.textContent = '#' + (index + 1);
    var path = card.querySelector('.path');
    focusPath.textContent = path ? path.textContent : '';
    apply();
    setCursor(index, true);
  }

  function exitFocus() {
    if (focusIndex < 0) return;
    var index = focusIndex;
    var card = cards[index];
    var control = returnControl;
    card.open = focusWasOpen;
    focusIndex = -1;
    returnControl = null;
    apply();
    setCursor(index, false);
    window.scrollTo(0, returnScroll);
    if (control && control.isConnected) control.focus({ preventScroll: true });
    else {
      var summary = card.querySelector('summary');
      if (summary) summary.focus({ preventScroll: true });
    }
  }

  function setJump(open) {
    if (jump) jump.setAttribute('aria-expanded', String(open));
    if (toolbar) toolbar.setAttribute('data-jump', open ? 'open' : 'closed');
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;
    var button = event.target.closest('button');
    var card = event.target.closest('.card');
    var at = card ? cards.indexOf(card) : -1;
    if (at >= 0) setCursor(at, false);
    if (button && button.hasAttribute('data-focus')) {
      event.preventDefault();
      if (at === focusIndex) exitFocus();
      else enterFocus(at, button);
      return;
    }
    if (button && button.getAttribute('data-action') === 'back') { exitFocus(); return; }
    if (button && button.getAttribute('data-filter')) {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      apply();
      return;
    }
    var action = button && button.getAttribute('data-action');
    if (action === 'expand' || action === 'collapse') {
      visible().forEach(function (index) { cards[index].open = action === 'expand'; });
      return;
    }
    if (button && button === jump) { setJump(jump.getAttribute('aria-expanded') !== 'true'); return; }
    // Both the agenda's evidence links and the call flow's "View diff" links
    // land on a hunk, whether or not the current filters would hide it.
    var openHunk = event.target.closest('[data-open-hunk], .toc-link');
    if (openHunk) {
      event.preventDefault();
      revealHunk(openHunk.hash);
    }
  });

  document.addEventListener('focusin', function (event) {
    if (!event.target.closest) return;
    var card = event.target.closest('.card');
    if (card) setCursor(cards.indexOf(card), false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (diffView.hidden) return;
    if (!event.target.closest) return;
    if (event.key === 'Escape') {
      if (focusIndex >= 0) { event.preventDefault(); exitFocus(); }
      return;
    }
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    var list = visible();
    if (!list.length) return;
    // j/k and the arrow keys both move the review cursor, per the toolbar hint.
    var step = 0;
    if (!event.shiftKey && (event.key === 'j' || event.key === 'ArrowDown')) step = 1;
    else if (!event.shiftKey && (event.key === 'k' || event.key === 'ArrowUp')) step = -1;
    if (step !== 0) {
      event.preventDefault();
      var at = list.indexOf(cursor);
      var next = at < 0 ? list[0] : list[Math.max(0, Math.min(list.length - 1, at + step))];
      setCursor(next, true);
      return;
    }
    if (event.key === 'Enter') {
      // A focused control keeps its own native activation.
      if (event.target.closest('summary, button, a')) return;
      if (!cards[cursor]) return;
      event.preventDefault();
      cards[cursor].open = !cards[cursor].open;
      return;
    }
    if (event.key === 'f' && focusIndex < 0 && cards[cursor]) {
      event.preventDefault();
      enterFocus(cursor, cards[cursor].querySelector('[data-focus]'));
    }
  });

  function measureToolbar() {
    if (!toolbar) return;
    document.documentElement.style.setProperty('--toolbar-height', toolbar.offsetHeight + 'px');
  }

  apply();
  setCursor(cursor, false);
  measureToolbar();
  // A link back into the report opens the hunk it names, in the view that shows
  // it, instead of landing on a closed card in a hidden section.
  if (location.hash && cards.length && !diffView.hidden) revealHunk(location.hash);
  else if (location.hash) {
    var initial = document.getElementById(location.hash.slice(1));
    var initialAt = initial ? cards.indexOf(initial) : -1;
    if (initialAt >= 0) setCursor(initialAt, true);
  }
  // Browser back and forward, and a hash typed or pasted into the address bar,
  // arrive as a hash change rather than a load: route them the same way.
  window.addEventListener('hashchange', function () {
    var name = viewForHash();
    if (name) showView(name);
    if (cards.length && location.hash && !diffView.hidden) revealHunk(location.hash);
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureToolbar).observe(toolbar);
  window.addEventListener('resize', measureToolbar);
}());
`;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #ffffff;
  --sunken: #f6f8fa;
  --ink: #1f2328;
  --ink-soft: #59636e;
  --line: #d1d9e0;
  --line-strong: #afb8c1;
  --accent: #59636e;
  --teal: #276b64;
  --teal-bg: #e8f2f1;
  --warn: #805511;
  --warn-bg: #fdf3e2;
  --alarm: #c22e2e;
  --alarm-bg: #fdecec;
  --add: #116329;
  --add-bg: #dafbe1;
  --del: #82071e;
  --del-bg: #ffebe9;
  --cursor: #2f6fae;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #0d1117;
    --sunken: #161b22;
    --ink: #e6edf3;
    --ink-soft: #9198a1;
    --line: #30363d;
    --line-strong: #6e7681;
    --accent: #9198a1;
    --teal: #6cc5bd;
    --teal-bg: #182827;
    --warn: #e0b372;
    --warn-bg: #2e2418;
    --alarm: #ff8a8a;
    --alarm-bg: #331f1e;
    --add: #aff5b4;
    --add-bg: #123821;
    --del: #ffdcd7;
    --del-bg: #3f1b22;
    --cursor: #7aa7d8;
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
.wrap { max-width: 1280px; margin: 0 auto; padding: 26px 20px 64px; }
h1, h2, h3 { margin: 0; line-height: 1.25; }
p { margin: 0; }
a { color: var(--teal); }
.mono, code { font-family: var(--mono); }
.muted { color: var(--ink-soft); }
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.masthead {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-bottom: 12px;
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
.mode-note { font-size: 12.5px; color: var(--ink-soft); }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
  color: var(--ink-soft);
}
.key { display: inline-flex; align-items: center; gap: 6px; }
.dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex: 0 0 auto;
  border: 1px solid transparent;
  background: var(--line-strong);
}
.dot-attention { background: var(--alarm); }
.dot-uncertain { background: var(--warn); }
.dot-low { background: var(--line-strong); }
.dot-passed { background: var(--teal); }
.view-switch { display: flex; gap: 4px; margin: 14px 0; border-bottom: 1px solid var(--line); }
.view-switch a { color: var(--ink-soft); padding: 8px 16px; text-decoration: none; border-bottom: 2px solid transparent; }
.view-switch a:hover, .view-switch a:focus-visible { color: var(--ink); }
.js .view-switch [aria-current] { color: var(--ink); border-bottom-color: var(--cursor); font-weight: 600; }
.toolbar {
  position: sticky; top: 0; z-index: 5; background: var(--bg);
  border-bottom: 1px solid var(--line); padding: 10px 0; margin-bottom: 14px;
}
[hidden], .enhanced { display: none !important; }
.js .enhanced { display: inline-flex !important; }
.js .fallback-rank { display: none; }
.js .jump-toggle { display: none !important; }
.controls, .filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.controls { width: 100%; }
button { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--teal); }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--cursor); outline-offset: 2px; }
button:disabled { cursor: default; opacity: .65; }
.pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 11px; font-size: 12px; }
.pill-n { font-size: 11px; color: var(--ink-soft); }
[data-filter][aria-pressed="false"] { opacity: .5; text-decoration: line-through; }
.keyboard-help { font-size: 12px; color: var(--ink-soft); }
#breadcrumb { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 6px; overflow-wrap: anywhere; }
.crumb-sep { color: var(--ink-soft); }
.crumb-path { overflow-wrap: anywhere; }
.toc { padding-top: 10px; }
.toc-list { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; max-height: 22vh; overflow-y: auto; }
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
.toc-link:hover, .toc-link:focus-visible { border-color: var(--cursor); }
.toc-rank { font-weight: 700; color: var(--ink-soft); }
.toc-path { min-width: 0; max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.js .card.cursor { outline: 2px solid var(--cursor); outline-offset: 3px; }
.card { scroll-margin-top: calc(var(--toolbar-height, 0px) + 14px); }
.focus-mode .wrap { max-width: none; }
.focus-mode .masthead, .focus-mode .foot { display: none; }
.focus-mode .controls, .focus-mode .toc { display: none !important; }
.cards { margin: 0; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 5px solid var(--line-strong);
  border-radius: 6px;
  margin: 0 0 12px;
  overflow: hidden;
}
.card-attention { border-left-color: var(--alarm); }
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
  padding: 10px 14px;
  background: var(--sunken);
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
.card > summary:hover { filter: brightness(0.98); }
.card > summary:focus-visible { outline: 2px solid var(--cursor); outline-offset: -2px; }
.rank {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-soft);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px 7px;
}
.path { flex: 1 1 240px; min-width: 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.growth { font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; }
.growth .plus { color: var(--add); }
.growth .minus { color: var(--del); }
.focus-button { font-size: 12px; padding: 3px 8px; }
.body { border-top: 1px solid var(--line); padding: 0 0 2px; }
.note { margin: 12px 14px; font-size: 13px; color: var(--ink-soft); overflow-wrap: anywhere; }
.obs { margin: 10px 14px; }
.obs > summary { cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
.obs-body { border: 1px dashed var(--line-strong); border-radius: 6px; padding: 8px 10px; margin-top: 6px; }
.obs-body .note { margin: 0 0 6px; font-size: 12.5px; }
.obs-note { font-style: italic; }
.obs-unknown { font-family: var(--sans); color: var(--ink-soft); }
.obs-list { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 12px; margin: 0; }
.obs-list dt { font-size: 12.5px; color: var(--ink-soft); }
.obs-list dd { margin: 0; font-size: 12.5px; overflow-wrap: anywhere; }
.diff-wrap {
  border-top: 1px solid var(--line);
  background: var(--panel);
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
pre.diff {
  display: grid;
  grid-template-columns: max-content max-content minmax(min-content, 1fr);
  margin: 0;
  padding: 6px 0;
  min-width: max-content;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 4;
  white-space: pre;
}
.ln { display: contents; }
.old-no, .new-no {
  text-align: right;
  padding: 0 8px 0 10px;
  color: var(--ink-soft);
  background: var(--sunken);
  border-right: 1px solid var(--line);
  user-select: none;
}
.code { padding: 0 14px; }
.ln-add > .code { color: var(--add); }
.ln-del > .code { color: var(--del); }
.ln-add > .code, .ln-add > .old-no, .ln-add > .new-no { background: var(--add-bg); }
.ln-del > .code, .ln-del > .old-no, .ln-del > .new-no { background: var(--del-bg); }
.ln-hunk > .code { color: var(--ink-soft); font-weight: 600; }
.ln-hunk > span { background: var(--sunken); }
.card-attention .ln-hunk > span { background: var(--alarm-bg); }
.card-uncertain .ln-hunk > span { background: var(--warn-bg); }
.card-passed .ln-hunk > span { background: var(--teal-bg); }
.ln-meta > .code { color: var(--ink-soft); }
.ln-note > .code { color: var(--ink-soft); font-style: italic; }
.empty { padding: 18px 0; color: var(--ink-soft); }
.foot { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-soft); }
.foot p { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 680px) {
  .wrap { padding: 18px 13px 48px; }
  .js .jump-toggle { display: inline-flex !important; }
  .js .toc-list { display: none; }
  .js .toolbar[data-jump="open"] .toc-list { display: flex; }
  .toc-list { margin-top: 8px; max-height: 40vh; overflow-y: auto; }
  .toc-list > li { width: 100%; }
  .keyboard-help { display: none; }
  .toc-link { width: 100%; }
  .toc-path { max-width: none; flex: 1 1 auto; }
  .card > summary { gap: 8px; padding: 10px 12px; }
  .growth { flex: 0 0 auto; }
  pre.diff { font-size: 12px; }
  .code { padding: 0 12px; }
}
`;

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

