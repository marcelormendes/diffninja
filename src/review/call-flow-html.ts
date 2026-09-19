import { escapeHtml } from "./escape-html.js";
import type {
  CallFlowAvailability,
  CallFlowFile,
  CallFlowNode,
  CallFlowStatus,
  ReviewItem,
  ReviewReport,
  ReviewStatus,
} from "./types.js";

/**
 * Call-flow navigation for a review report: Tree, Graph and Sequence views of
 * the syntactic call trees that touch each changed file.
 *
 * Everything is server-rendered, so all three modes are readable with
 * JavaScript disabled: mode sections stack under their own headings, and tree
 * nodes fold with native `<details>`. The appended script only switches modes,
 * zooms into a subtree and rebuilds the breadcrumb; it reads every label from
 * the escaped DOM and never receives report text.
 *
 * Node identity is an occurrence path (`0-2-1`), never a key or a name, so
 * duplicate and hostile keys stay distinct. Status reaches the reviewer as a
 * glyph plus color for a call that was added, removed, or contains a change,
 * and plain dimmed text for an unchanged call.
 */
export function renderCallFlows(report: ReviewReport): string {
  const files = collectFiles(report.callFlows, report.items);
  if (files.length === 0) {
    return `<p class="cf-note cf-absence">${escapeHtml(AVAILABILITY_NOTE[report.callFlowAvailability])}</p>`;
  }
  return [
    '<div class="cf">',
    renderSummary(files, new Set(report.items.map(item => item.file)).size),
    renderControls(),
    renderJump(files),
    '<nav class="cf-crumbs" id="cf-crumbs" aria-label="Call flow focus" hidden></nav>',
    '<div class="cf-files">',
    files.map((view, index) => renderFile(view, index + 1)).join("\n"),
    "</div>",
    "</div>",
  ].join("\n");
}

/** Order a reviewer reads in: most severe changed file first, then report order. */
const SEVERITY_RANK = {
  attention: 0,
  uncertain: 1,
  low: 2,
  passed: 3,
} satisfies Record<ReviewStatus, number>;


const SEVERITY_WORD = {
  attention: "Attention",
  uncertain: "Uncertain",
  low: "Low",
  passed: "Passed",
} satisfies Record<ReviewStatus, string>;

const STATUS_WORD = {
  same: "unchanged",
  added: "added",
  removed: "removed",
  changed: "changed",
} satisfies Record<CallFlowStatus, string>;

const STATUS_MARK = {
  same: "",
  added: "+",
  removed: "−",
  changed: "~",
} satisfies Record<CallFlowStatus, string>;

const MODE_LABEL = {
  tree: "Tree",
  graph: "Graph",
  sequence: "Sequence",
} as const;

type FlowMode = keyof typeof MODE_LABEL;

const MODES: readonly FlowMode[] = ["tree", "graph", "sequence"];

const AVAILABILITY_NOTE = {
  available: "No call tree reaches a changed file in this range. This is not evidence of safety.",
  "needs-git-range": "Call paths need a git range. This input was a patch, so no call trees were built.",
  "no-changes": "No call path reaches a changed file. This is not evidence of safety.",
  failed: "Call-flow analysis failed, so no call trees were built. The diff review is unaffected.",
} satisfies Record<CallFlowAvailability, string>;

/** Call paths drawn per file in Sequence mode before the omitted-path note. */
const SEQUENCE_LIMIT = 10;

const GRAPH_NODE_HEIGHT = 40;
const GRAPH_LEVEL_GAP = 32;
const GRAPH_COLUMN_GAP = 20;
const GRAPH_PAD = 8;
/** Advance width of the 12px / 10px monospace label faces used in the graph. */
const GRAPH_CHAR = 7.4;
const GRAPH_LOC_CHAR = 6.2;
const GRAPH_MIN_WIDTH = 132;
const GRAPH_MAX_WIDTH = 300;

interface FileView {
  readonly file: string;
  /** Most severe hunk status in this file, whatever the report priority says. */
  readonly status: ReviewStatus;
  /** 1-based report rank of the hunk the View diff link opens. */
  readonly rank: number;
  readonly trees: readonly CallFlowNode[];
  readonly truncated: boolean;
}


/** Most severe hunk per file, and the earliest hunk of that severity. */
function hunkRanks(items: readonly ReviewItem[]): Map<string, { status: ReviewStatus; rank: number }> {
  const ranks = new Map<string, { status: ReviewStatus; rank: number }>();
  for (const [index, item] of items.entries()) {
    const status = item.status;
    const seen = ranks.get(item.file);
    if (seen === undefined || SEVERITY_RANK[status] < SEVERITY_RANK[seen.status]) {
      ranks.set(item.file, { status, rank: index + 1 });
    }
  }
  return ranks;
}


/** One diagram section per changed file with structured call paths. */
function collectFiles(
  callFlows: readonly CallFlowFile[],
  items: readonly ReviewItem[],
): FileView[] {
  const ranks = hunkRanks(items);
  const views: FileView[] = [];
  const seen = new Set<string>();
  for (const entry of callFlows) {
    const { file, trees } = entry;
    const hunk = ranks.get(file);
    if (!hunk || trees.length === 0 || seen.has(file)) continue;
    seen.add(file);
    views.push({
      file,
      status: hunk.status,
      rank: hunk.rank,
      trees,
      truncated: entry.truncated === true,
    });
  }
  // Most severe file first; ties keep report order.
  views.sort(compareViews);
  return views;
}

function compareViews(a: FileView, b: FileView): number {
  return SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status] || a.rank - b.rank;
}

function countNodes(trees: readonly CallFlowNode[]): number {
  let total = 0;
  for (const tree of trees) {
    total += 1;
    total += countNodes(tree.children);
  }
  return total;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function renderSummary(files: readonly FileView[], totalFiles: number): string {
  const calls = files.reduce((total, view) => total + countNodes(view.trees), 0);
  const coverage = `${plural(calls, "call")} across ${files.length} of ${totalFiles} changed files`;
  return [
    '<div class="cf-head">',
    '<p class="cf-prov" title="Up to 8 roots, 4 edges deep, 8 children per node and 160 nodes per file. Dynamic calls may be absent.">Syntactic calls · depth ≤4 · + added · − removed · ~ changed</p>',
    `<p class="cf-note">${escapeHtml(coverage)}</p>`,
    "</div>",
  ].join("\n");
}

/** Mode anchors work without JavaScript (each jumps to its section); the
 *  script marks the active one with aria-current once all modes are switchable. */
function renderControls(): string {
  const links = MODES.map(
    (mode) =>
      `<a class="cf-mode-link" data-cf-mode="${mode}" href="#cf-f1-${mode}">${MODE_LABEL[mode]}</a>`,
  ).join("");
  return [
    '<div class="cf-controls">',
    `<div class="cf-modes" role="group" aria-label="Call flow mode">${links}</div>`,
    '<p class="cf-note cf-order">Call paths, not execution order</p>',
    "</div>",
  ].join("\n");
}

/** Severity dot, screen-reader word and call count, shared by nav and header. */
function fileFacts(view: FileView) {
  return {
    dot: `<span class="dot dot-${view.status}" aria-hidden="true"></span>`,
    tone: `<span class="sr">${escapeHtml(SEVERITY_WORD[view.status])}</span>`,
    count: plural(countNodes(view.trees), "call"),
  };
}

function renderJump(files: readonly FileView[]): string {
  const links = files
    .map((view, index) => {
      const { dot, tone, count } = fileFacts(view);
      return [
        '<li><a class="cf-jump-link" href="#cf-f',
        `${index + 1}">`,
        dot,
        `<span class="cf-jump-path mono">${escapeHtml(view.file)}</span>`,
        `<span class="cf-jump-count mono">${escapeHtml(count)}</span>`,
        tone,
        "</a></li>",
      ].join("");
    })
    .join("\n");
  return [
    '<nav class="cf-jump" aria-label="Call flow files">',
    `<ul>${links}</ul>`,
    "</nav>",
  ].join("\n");
}

/** One file section: severity, path, call count and its diff link. */
function renderFile(view: FileView, at: number): string {
  const { dot, tone, count } = fileFacts(view);
  const status = view.status;
  const diff = `<a class="cf-diff-link" data-flow-diff href="#item-${view.rank}">View diff #${view.rank}</a>`;
  return [
    `<details class="cf-file cf-file-${status}" id="cf-f${at}" data-cf-file="${at}"${at === 1 ? " open" : ""}>`,
    '<summary class="cf-file-head">',
    dot,
    `<span class="cf-file-path mono">${escapeHtml(view.file)}</span>`,
    tone,
    `<span class="cf-file-count mono">${escapeHtml(count)}</span>`,
    diff,
    "</summary>",
    '<div class="cf-file-body">',
    view.truncated
      ? '<p class="cf-bounds">Bounds reached for this file: roots ≤8, depth ≤4 edges, ≤8 calls per node, 160 nodes. Calls cut at a bound are omitted.</p>'
      : "",
    renderModes(view, at),
    "</div>",
    "</details>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderModes(view: FileView, at: number): string {
  return [
    renderTreeMode(view, at),
    renderGraphMode(view, at),
    renderSequenceMode(view, at),
  ].join("\n");
}

function modeSection(mode: FlowMode, at: number, body: string): string {
  return [
    `<section class="cf-mode cf-mode-${mode}" id="cf-f${at}-${mode}" data-cf-mode-body="${mode}">`,
    `<h3 class="cf-mode-head">${MODE_LABEL[mode]}</h3>`,
    body,
    "</section>",
  ].join("\n");
}

function renderTreeMode(view: FileView, at: number): string {
  const trees = view.trees
    .map((tree, root) => renderTreeNode(tree, [root], at, view.file))
    .join("\n");
  return modeSection("tree", at, `<ul class="cf-tree">${trees}</ul>`);
}

function renderTreeNode(
  node: CallFlowNode,
  path: readonly number[],
  at: number,
  changedFile: string,
): string {
  const id = path.join("-");
  const status = node.status;
  const inFile = node.file === changedFile;
  const loc = locationText(node);
  // The label is the zoom target. It stays a plain span without JavaScript (a
  // dead button would be worse) and the script upgrades it into a real button.
  const zoom =
    `<span class="cf-label mono" data-cf-zoom data-cf-file="${at}" data-cf-path="${id}"` +
    ` title="Zoom into ${escapeHtml(node.label)}">${escapeHtml(node.label)}</span>`;
  const row = [
    statusBadge(status, "cf-badge"),
    zoom,
    loc === ""
      ? '<span class="cf-loc cf-loc-none">no source location</span>'
      : `<span class="cf-loc mono">${escapeHtml(loc)}</span>`,
  ]
    .filter((part) => part !== "")
    .join("");
  const classes = ["cf-node", `cf-st-${status}`];
  if (inFile) classes.push("cf-infile");
  const kids = node.children;
  if (kids.length === 0) {
    return `<li class="${classes.join(" ")} cf-leaf" id="cf-f${at}-t-${id}" data-cf-file="${at}" data-cf-path="${id}"><span class="cf-row">${row}</span></li>`;
  }
  const children = kids
    .map((child, childAt) => renderTreeNode(child, path.concat([childAt]), at, changedFile))
    .join("\n");
  return [
    `<li class="${classes.join(" ")}" id="cf-f${at}-t-${id}" data-cf-file="${at}" data-cf-path="${id}">`,
    '<details class="cf-fold" open>',
    `<summary class="cf-row">${row}</summary>`,
    `<ul class="cf-children">${children}</ul>`,
    "</details>",
    "</li>",
  ].join("");
}

/** The mark is drawn only for a call that changed; `same` keeps its label dim. */
function statusBadge(status: CallFlowStatus, extra: string): string {
  const mark = STATUS_MARK[status];
  return [
    mark === "" ? "" : `<span class="${extra} ${extra}-${status}" aria-hidden="true">${mark}</span>`,
    `<span class="sr">${STATUS_WORD[status]}</span>`,
  ].join("");
}

/** `file:line` when both are known, the file alone when the line is not. */
function locationText(node: CallFlowNode): string {
  const file = node.file ?? "";
  const line = node.line ?? null;
  if (file === "") return line === null ? "" : `line ${line}`;
  return line === null ? file : `${file}:${line}`;
}

function renderGraphMode(view: FileView, at: number): string {
  const figures = view.trees
    .map((tree, root) => {
      const layout = layoutTree(tree, [root]);
      const edges = layout.edges.map(renderGraphEdge).join("");
      const boxes = layout.boxes
        .map((box) => renderGraphNode(box, at, view.file))
        .join("");
      return [
        '<div class="cf-svg-wrap">',
        `<svg class="cf-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="${escapeHtml(`Call graph for ${tree.label}`)}">`,
        edges,
        boxes,
        "</svg></div>",
      ].join("");
    })
    .join("\n");
  return modeSection("graph", at, figures);
}

interface GraphBox {
  readonly node: CallFlowNode;
  readonly path: readonly number[];
  x: number;
  y: number;
  readonly width: number;
  readonly labelChars: number;
  readonly locChars: number;
}

interface GraphLayout {
  readonly boxes: GraphBox[];
  readonly edges: Array<{ from: GraphBox; to: GraphBox }>;
  readonly width: number;
  readonly height: number;
}

/**
 * Hand layout: one row per call depth, boxes packed left to right and centred
 * per row, elbow edges from parent bottom to child top. The SVG keeps its
 * pixel size so labels stay readable; the wrapper scrolls instead of the page.
 */
function layoutTree(root: CallFlowNode, rootPath: readonly number[]): GraphLayout {
  const levels: GraphBox[][] = [];
  const boxes: GraphBox[] = [];
  const edges: Array<{ from: GraphBox; to: GraphBox }> = [];
  const walk = (node: CallFlowNode, path: readonly number[], parent: GraphBox | null): void => {
    const loc = locationText(node);
    const labelChars = Math.max(1, node.label.length + (node.status === "same" ? 0 : 2));
    const width = Math.ceil(
      Math.min(
        GRAPH_MAX_WIDTH,
        Math.max(GRAPH_MIN_WIDTH, 24 + Math.max(labelChars * GRAPH_CHAR, loc.length * GRAPH_LOC_CHAR)),
      ),
    );
    const box: GraphBox = {
      node,
      path,
      x: 0,
      y: 0,
      width,
      labelChars: Math.floor((width - 24) / GRAPH_CHAR),
      locChars: Math.floor((width - 24) / GRAPH_LOC_CHAR),
    };
    const depth = path.length - 1;
    const level = levels[depth];
    if (level === undefined) levels[depth] = [box];
    else level.push(box);
    boxes.push(box);
    if (parent !== null) edges.push({ from: parent, to: box });
    node.children.forEach((child, childAt) => walk(child, path.concat([childAt]), box));
  };
  walk(root, rootPath, null);

  const levelWidths = levels.map(
    (level) =>
      level.reduce((total, box) => total + box.width, 0) +
      GRAPH_COLUMN_GAP * Math.max(0, level.length - 1),
  );
  const widest = Math.max(...levelWidths, GRAPH_MIN_WIDTH) + GRAPH_PAD * 2;
  levels.forEach((level, depth) => {
    let x = GRAPH_PAD + Math.max(0, (widest - GRAPH_PAD * 2 - levelWidths[depth]) / 2);
    const y = GRAPH_PAD + depth * (GRAPH_NODE_HEIGHT + GRAPH_LEVEL_GAP);
    for (const box of level) {
      box.x = Math.round(x);
      box.y = y;
      x += box.width + GRAPH_COLUMN_GAP;
    }
  });
  const height =
    GRAPH_PAD * 2 + levels.length * GRAPH_NODE_HEIGHT + Math.max(0, levels.length - 1) * GRAPH_LEVEL_GAP;
  return { boxes, edges, width: Math.round(widest), height: Math.round(height) };
}

function renderGraphEdge(edge: { from: GraphBox; to: GraphBox }): string {
  const { from, to } = edge;
  const x1 = Math.round(from.x + from.width / 2);
  const y1 = Math.round(from.y + GRAPH_NODE_HEIGHT);
  const x2 = Math.round(to.x + to.width / 2);
  const y2 = Math.round(to.y);
  const mid = Math.round(y1 + (y2 - y1) / 2);
  return [
    `<path class="cf-edge" data-cf-edge-child="${to.path.join("-")}"`,
    ` d="M${x1} ${y1} V${mid} H${x2} V${y2}"></path>`,
  ].join("");
}

function renderGraphNode(box: GraphBox, at: number, changedFile: string): string {
  const node = box.node;
  const path = box.path.join("-");
  const status = node.status;
  const loc = locationText(node);
  const inFile = node.file === changedFile;
  const title = [node.label, loc === "" ? "no source location" : loc, STATUS_WORD[status]].join(" · ");
  const mark = STATUS_MARK[status];
  const label = clip(mark ? `${mark} ${node.label}` : node.label, box.labelChars);
  return [
    `<a class="cf-gnode cf-st-${status}${inFile ? " cf-infile" : ""}" href="#cf-f${at}-t-${path}" data-cf-zoom data-cf-file="${at}" data-cf-path="${path}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${GRAPH_NODE_HEIGHT}" rx="7"></rect>`,
    `<text class="cf-glabel" x="${box.x + 12}" y="${loc === "" ? box.y + 25 : box.y + 17}">${escapeHtml(label)}</text>`,
    loc === ""
      ? ""
      : `<text class="cf-gloc" x="${box.x + 12}" y="${box.y + 31}">${escapeHtml(clip(loc, box.locChars))}</text>`,
    "</a>",
  ]
    .filter((part) => part !== "")
    .join("");
}

/** The graph truncates visually; the full label stays in the node title. */
function clip(text: string, maxChars: number): string {
  if (maxChars < 2 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function renderSequenceMode(view: FileView, at: number): string {
  const paths: Array<Array<{ node: CallFlowNode; path: readonly number[] }>> = [];
  view.trees.forEach((tree, root) => collectPaths(tree, [root], [], paths));
  const shown = Math.min(paths.length, SEQUENCE_LIMIT);
  const note = `<p class="cf-note cf-omitted"${paths.length <= SEQUENCE_LIMIT ? " hidden" : ""}>Showing ${shown} of ${paths.length} call paths; focus a branch to narrow.</p>`;
  return modeSection(
    "sequence",
    at,
    `<ol class="cf-paths" data-cf-path-limit="${SEQUENCE_LIMIT}">${paths.map((chain, index) => renderPath(chain, at, index >= SEQUENCE_LIMIT)).join("\n")}</ol>${note}`,
  );
}

function collectPaths(
  node: CallFlowNode,
  path: readonly number[],
  chain: Array<{ node: CallFlowNode; path: readonly number[] }>,
  out: Array<Array<{ node: CallFlowNode; path: readonly number[] }>>,
): void {
  const next = chain.concat([{ node, path }]);
  const kids = node.children;
  if (kids.length === 0) {
    out.push(next);
    return;
  }
  kids.forEach((child, childAt) => collectPaths(child, path.concat([childAt]), next, out));
}

function renderPath(
  chain: ReadonlyArray<{ node: CallFlowNode; path: readonly number[] }>,
  at: number,
  hidden: boolean,
): string {
  const leaf = chain[chain.length - 1];
  const chips = chain
    .map((step) => renderChip(step, at))
    .join('<span class="cf-arrow" aria-hidden="true">→</span>');
  return `<li class="cf-path" data-cf-file="${at}" data-cf-path="${leaf.path.join("-")}"${hidden ? " hidden" : ""}>${chips}</li>`;
}

function renderChip(step: { node: CallFlowNode; path: readonly number[] }, at: number): string {
  const path = step.path.join("-");
  const status = step.node.status;
  const loc = locationText(step.node);
  const title = loc === "" ? "" : ` title="${escapeHtml(loc)}"`;
  return [
    `<a class="cf-chip cf-st-${status}" href="#cf-f${at}-t-${path}" data-cf-zoom data-cf-file="${at}" data-cf-path="${path}"${title}>`,
    statusBadge(status, "cf-chip-badge"),
    `<span class="cf-chip-label mono">${escapeHtml(step.node.label)}</span>`,
    loc === "" ? "" : `<span class="cf-chip-loc mono">${escapeHtml(loc)}</span>`,
    "</a>",
  ].join("");
}

export const CALL_FLOW_STYLES = `
.cf { display: flex; flex-direction: column; gap: 12px; margin-top: 18px; }
/* Mode sections, folded files and the breadcrumb are toggled with the hidden
   attribute, so the module carries that rule itself instead of relying on the page. */
.cf [hidden] { display: none !important; }
.cf-head { display: flex; flex-direction: column; gap: 4px; }
.cf-prov { font-size: 12.5px; font-weight: 600; color: var(--ink-soft); }
.cf-note { font-size: 12.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.cf-absence { padding: 16px 0; }
.cf-bounds {
  margin: 12px 0 0;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.cf-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.cf-modes {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel);
}
.cf-mode-link {
  display: inline-flex;
  align-items: center;
  padding: 5px 14px;
  font-size: 12.5px;
  color: var(--ink-soft);
  text-decoration: none;
  border-right: 1px solid var(--line);
}
.cf-mode-link:last-child { border-right: 0; }
.cf-mode-link:hover, .cf-mode-link:focus-visible { color: var(--ink); background: var(--sunken); }
.js .cf-mode-link[aria-current] { color: var(--ink); background: var(--sunken); font-weight: 600; }
.cf-order { margin-left: auto; }
.cf-jump ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 22vh;
  overflow-y: auto;
}
.cf-jump-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  padding: 5px 11px 5px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  font-size: 12.5px;
  text-decoration: none;
}
.cf-jump-link:hover, .cf-jump-link:focus-visible { border-color: var(--cursor); }
.cf-jump-path { min-width: 0; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf-jump-count { color: var(--ink-soft); white-space: nowrap; }
.cf-crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.cf-crumb {
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
}
.cf-crumb[aria-current] { border-color: var(--cursor); font-weight: 600; }
.cf-sep { color: var(--ink-soft); }
.cf-files { display: flex; flex-direction: column; gap: 12px; }
.cf-file {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 5px solid var(--line-strong);
  border-radius: 6px;
  overflow: hidden;
}
.cf-file { --cf-color: var(--ink-soft); --cf-fill: var(--sunken); }
.cf-file-attention { border-left-color: var(--alarm); --cf-color: var(--alarm); --cf-fill: var(--alarm-bg); }
.cf-file-uncertain { border-left-color: var(--warn); --cf-color: var(--warn); --cf-fill: var(--warn-bg); }
.cf-file-low { border-left-color: var(--line-strong); }
.cf-file-passed { border-left-color: var(--teal); --cf-color: var(--teal); --cf-fill: var(--teal-bg); }
.cf-file-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 14px;
  background: var(--sunken);
  cursor: pointer;
  list-style: none;
}
.cf-file-head::-webkit-details-marker { display: none; }
.cf-file-head::after {
  content: "▸";
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-soft);
  transition: transform 0.15s ease;
}
.cf-file[open] > .cf-file-head::after { transform: rotate(90deg); }
.cf-file-head:focus-visible { outline: 2px solid var(--cursor); outline-offset: -2px; }
.cf-file-path { flex: 1 1 260px; min-width: 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.cf-file-count { font-size: 12px; color: var(--ink-soft); white-space: nowrap; }
.cf-diff-link { font-size: 12px; white-space: nowrap; }
.cf-file-body { border-top: 1px solid var(--line); padding: 0 14px 14px; }
.cf-mode { padding-top: 12px; }
.cf-mode + .cf-mode { margin-top: 12px; border-top: 1px dashed var(--line); }
.cf-mode-head {
  margin: 0 0 8px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.cf-tree, .cf-children { list-style: none; margin: 0; padding: 0; }
.cf-children { margin-left: 15px; padding-left: 10px; border-left: 1px dashed var(--line); }
.cf-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 3px 0; }
.cf-fold > .cf-row { cursor: pointer; list-style: none; }
.cf-fold > .cf-row::-webkit-details-marker { display: none; }
.cf-fold > .cf-row::before { content: "▸"; font-size: 10px; color: var(--ink-soft); transition: transform 0.15s ease; }
.cf-fold[open] > .cf-row::before { transform: rotate(90deg); }
.cf-node.cf-infile > .cf-row, .cf-node.cf-infile > .cf-fold > .cf-row { background: var(--sunken); border-radius: 5px; }
.cf-badge, .cf-chip-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-width: 16px;
  height: 16px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.cf-badge, .cf-chip-badge { color: var(--cf-color); background: var(--cf-fill); }
.cf-label {
  font: 400 12.5px/1.35 var(--mono);
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  text-align: left;
  overflow-wrap: anywhere;
}
.js .cf-label { cursor: pointer; }
.js .cf-label:hover, .cf-label:focus-visible { border-color: var(--line-strong); background: var(--panel); }
.cf-label:focus-visible { outline: 2px solid var(--cursor); outline-offset: 1px; }
.cf-loc { font-size: 11.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.cf-loc-none { font-style: italic; }
.cf-node { --cf-node-color: var(--cf-color); --cf-node-weight: 600; --cf-node-decoration: none; }
.cf-node.cf-st-same { --cf-node-color: var(--ink-soft); --cf-node-weight: 400; }
.cf-node.cf-st-removed { --cf-node-decoration: line-through; }
.cf-label { color: var(--cf-node-color); font-weight: var(--cf-node-weight); text-decoration: var(--cf-node-decoration); }
.cf-node.cf-ancestor > .cf-fold > .cf-row { display: none; }
.cf-node.cf-ancestor > .cf-fold > .cf-children { margin: 0; padding: 0; border: 0; }
.cf-svg-wrap {
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--sunken);
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.cf-svg { display: block; }
.cf-svg-wrap + .cf-svg-wrap { margin-top: 10px; }
.cf-edge { fill: none; stroke: var(--line-strong); stroke-width: 1.5; }
.cf-gnode rect { fill: var(--panel); stroke: var(--line-strong); stroke-width: 1.5; }
.cf-gnode:hover rect, .cf-gnode:focus-visible rect { stroke: var(--cursor); stroke-width: 2.5; }
.cf-gnode:focus-visible { outline: none; }
.cf-glabel { font-family: var(--mono); font-size: 12px; fill: var(--ink); }
.cf-gloc { font-family: var(--mono); font-size: 10px; fill: var(--ink-soft); }
.cf-gnode.cf-st-same rect { stroke: var(--line); fill: transparent; }
.cf-gnode.cf-st-same .cf-glabel { fill: var(--ink-soft); }
.cf-gnode:not(.cf-st-same) rect { stroke: var(--cf-color); fill: var(--cf-fill); }
.cf-gnode:not(.cf-st-same) .cf-glabel { fill: var(--cf-color); }
.cf-paths { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; }
.cf-path {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
}
.cf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 9px 2px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  text-decoration: none;
}
.cf-chip:hover, .cf-chip:focus-visible { border-color: var(--cursor); }
.cf-chip-label { font-size: 12px; overflow-wrap: anywhere; }
.cf-chip-loc { font-size: 10.5px; color: var(--ink-soft); }
.cf-chip.cf-st-same .cf-chip-label { color: var(--ink-soft); }
.cf-chip:not(.cf-st-same) { border-color: var(--cf-color); background: var(--cf-fill); }
.cf-chip:not(.cf-st-same) .cf-chip-label { color: var(--cf-color); }
.cf-arrow { color: var(--ink-soft); font-size: 12px; }
@media (max-width: 680px) {
  .cf-order { margin-left: 0; }
  .cf-jump ul { max-height: 38vh; }
  .cf-jump-link { width: 100%; }
  .cf-jump-path { max-width: none; flex: 1 1 auto; }
  .cf-file-body { padding: 0 11px 12px; }
}
`;

/**
 * Progressive enhancement for the rendered call flow. Nothing here is
 * interpolated: the active mode, the zoom target and the breadcrumb labels all
 * come from attributes and text already escaped in the DOM.
 */
export const CALL_FLOW_SCRIPT = `
(function () {
  'use strict';
  var view = document.getElementById('view-call-flow');
  if (!view) return;
  var host = view.querySelector('.cf');
  if (!host) return;
  var files = Array.prototype.slice.call(view.querySelectorAll('.cf-file'));
  var modeLinks = Array.prototype.slice.call(view.querySelectorAll('[data-cf-mode]'));
  var crumbNav = document.getElementById('cf-crumbs');
  var modes = ['tree', 'graph', 'sequence'];
  var mode = 'tree';
  var focus = null;

  function fileAt(index) {
    for (var i = 0; i < files.length; i++) {
      if (files[i].getAttribute('data-cf-file') === String(index)) return files[i];
    }
    return null;
  }

  function under(path, at) {
    return at === '' || path === at || path.indexOf(at + '-') === 0;
  }

  function onChain(path, at) {
    return at === '' || path === at || at.indexOf(path + '-') === 0;
  }

  function each(list, at) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-cf-path') === at) return list[i];
    }
    return null;
  }

  // A tree label is inert markup until the page has scripts. Upgrade it into a
  // real button so zoom is clickable and reachable by keyboard.
  function upgradeLabels() {
    var labels = Array.prototype.slice.call(view.querySelectorAll('span.cf-label[data-cf-zoom]'));
    for (var i = 0; i < labels.length; i++) {
      var span = labels[i];
      var button = document.createElement('button');
      button.type = 'button';
      button.className = span.className;
      button.textContent = span.textContent;
      button.setAttribute('data-cf-zoom', '');
      button.setAttribute('data-cf-file', span.getAttribute('data-cf-file'));
      button.setAttribute('data-cf-path', span.getAttribute('data-cf-path'));
      button.setAttribute('aria-label', 'Zoom into ' + span.textContent);
      var title = span.getAttribute('title');
      if (title) button.setAttribute('title', title);
      span.parentNode.replaceChild(button, span);
    }
  }

  function applyMode() {
    for (var i = 0; i < files.length; i++) {
      var sections = files[i].querySelectorAll('[data-cf-mode-body]');
      for (var j = 0; j < sections.length; j++) {
        sections[j].hidden = sections[j].getAttribute('data-cf-mode-body') !== mode;
      }
    }
    var at = focus ? focus.file : files.length ? Number(files[0].getAttribute('data-cf-file')) : null;
    for (var k = 0; k < modeLinks.length; k++) {
      var name = modeLinks[k].getAttribute('data-cf-mode');
      if (name === mode) modeLinks[k].setAttribute('aria-current', 'true');
      else modeLinks[k].removeAttribute('aria-current');
      if (at !== null) modeLinks[k].setAttribute('href', '#cf-f' + at + '-' + name);
    }
  }

  function applyFocus() {
    var focused = focus ? String(focus.file) : null;
    var at = focus ? focus.path : '';
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var mine = focused === null || file.getAttribute('data-cf-file') === focused;
      if (focus) file.hidden = !mine;
      else file.hidden = false;
      var nodes = file.querySelectorAll('li.cf-node');
      for (var n = 0; n < nodes.length; n++) {
        var path = nodes[n].getAttribute('data-cf-path');
        nodes[n].hidden = !mine || !(under(path, at) || onChain(path, at));
        nodes[n].classList.toggle('cf-ancestor', mine && at !== '' && path !== at && onChain(path, at));
      }
      var gNodes = file.querySelectorAll('a.cf-gnode');
      for (var g = 0; g < gNodes.length; g++) {
        var gPath = gNodes[g].getAttribute('data-cf-path');
        gNodes[g].toggleAttribute('hidden', !mine || !under(gPath, at));
      }
      var edges = file.querySelectorAll('path.cf-edge');
      for (var e = 0; e < edges.length; e++) {
        var child = edges[e].getAttribute('data-cf-edge-child');
        edges[e].toggleAttribute('hidden', !mine || child === at || !under(child, at));
      }
      var graphs = file.querySelectorAll('.cf-svg');
      for (var s = 0; s < graphs.length; s++) {
        var graph = graphs[s];
        var shown = graph.querySelectorAll('a.cf-gnode:not([hidden]) rect');
        graph.toggleAttribute('hidden', shown.length === 0);
        graph.parentElement.hidden = shown.length === 0;
        if (!shown.length) continue;
        var left = Infinity, top = Infinity, right = 0, bottom = 0;
        for (var b = 0; b < shown.length; b++) {
          var box = shown[b];
          var x = Number(box.getAttribute('x')), y = Number(box.getAttribute('y'));
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x + Number(box.getAttribute('width')));
          bottom = Math.max(bottom, y + Number(box.getAttribute('height')));
        }
        graph.setAttribute('viewBox', [left - 8, top - 8, right - left + 16, bottom - top + 16].join(' '));
        graph.setAttribute('width', String(right - left + 16));
        graph.setAttribute('height', String(bottom - top + 16));
      }
      var paths = file.querySelectorAll('.cf-path');
      var pathList = file.querySelector('.cf-paths');
      var limit = pathList ? Number(pathList.getAttribute('data-cf-path-limit')) : 0;
      var matches = 0;
      for (var p = 0; p < paths.length; p++) {
        var leaf = paths[p].getAttribute('data-cf-path');
        var match = mine && under(leaf, at);
        paths[p].hidden = !match || matches >= limit;
        if (match) matches++;
      }
      var omitted = file.querySelector('.cf-omitted');
      if (omitted) {
        omitted.hidden = matches <= limit;
        omitted.textContent = 'Showing ' + Math.min(matches, limit) + ' of ' + matches + ' call paths; focus a branch to narrow.';
      }
    }
  }

  function labelAt(index, path) {
    var file = fileAt(index);
    if (!file) return '';
    var node = each(file.querySelectorAll('li.cf-node'), path);
    var label = node ? node.querySelector('.cf-label') : null;
    return label ? label.textContent : '';
  }

  function fileLabel(index) {
    var file = fileAt(index);
    if (!file) return '';
    var path = file.querySelector('.cf-file-path');
    return path ? path.textContent : '';
  }

  function crumb(text, index, path) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'cf-crumb';
    button.textContent = text;
    button.setAttribute('data-cf-file', String(index));
    button.setAttribute('data-cf-path', path);
    return button;
  }

  function sep() {
    var span = document.createElement('span');
    span.className = 'cf-sep';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '/';
    return span;
  }

  function renderCrumbs() {
    if (!crumbNav) return;
    while (crumbNav.firstChild) crumbNav.removeChild(crumbNav.firstChild);
    if (!focus) {
      crumbNav.hidden = true;
      return;
    }
    var all = crumb('All files', focus.file, '');
    all.setAttribute('data-cf-root', '');
    crumbNav.appendChild(all);
    crumbNav.appendChild(sep());
    var own = crumb(fileLabel(focus.file) || 'file', focus.file, '');
    if (focus.path === '') own.setAttribute('aria-current', 'true');
    crumbNav.appendChild(own);
    var parts = focus.path === '' ? [] : focus.path.split('-');
    var prefix = '';
    for (var i = 0; i < parts.length; i++) {
      prefix = prefix === '' ? parts[i] : prefix + '-' + parts[i];
      crumbNav.appendChild(sep());
      var step = crumb(labelAt(focus.file, prefix) || parts[i], focus.file, prefix);
      if (i === parts.length - 1) step.setAttribute('aria-current', 'true');
      crumbNav.appendChild(step);
    }
    crumbNav.hidden = false;
  }

  function reveal() {
    if (!focus) return;
    var file = fileAt(focus.file);
    if (!file) return;
    file.open = true;
    var section = file.querySelector('[data-cf-mode-body="' + mode + '"]');
    if (!section) return;
    var target = each(section.querySelectorAll('[data-cf-path]'), focus.path);
    if (!target) return;
    var fold = mode === 'tree' ? target.querySelector('.cf-fold') : null;
    if (fold) fold.open = true;
    var step = target;
    while (step && step !== view) {
      if (step.tagName === 'DETAILS') step.open = true;
      step = step.parentElement;
    }
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function setFocus(index, path) {
    focus = { file: index, path: path };
    applyMode();
    applyFocus();
    renderCrumbs();
    reveal();
    crumbNav.scrollIntoView({ block: 'nearest' });
  }

  function clearFocus(scrollBack) {
    focus = null;
    applyFocus();
    renderCrumbs();
    if (scrollBack) host.scrollIntoView({ block: 'start' });
  }

  function setMode(next) {
    if (modes.indexOf(next) < 0) return;
    mode = next;
    applyMode();
    if (mode === 'graph' && !focus) {
      var wraps = view.querySelectorAll('.cf-svg-wrap');
      for (var i = 0; i < wraps.length; i++) {
        var wrap = wraps[i], graph = wrap.querySelector('svg'), root = wrap.querySelector('.cf-gnode rect');
        if (!root || !wrap.clientWidth) continue;
        var origin = Number(graph.getAttribute('viewBox').split(' ')[0]);
        wrap.scrollLeft = Number(root.getAttribute('x')) + Number(root.getAttribute('width')) / 2 - origin - wrap.clientWidth / 2;
      }
    }
    reveal();
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;
    var crumbButton = event.target.closest('.cf-crumb');
    if (crumbButton) {
      event.preventDefault();
      if (crumbButton.hasAttribute('data-cf-root')) clearFocus(false);
      else {
        setFocus(
          Number(crumbButton.getAttribute('data-cf-file')),
          crumbButton.getAttribute('data-cf-path'),
        );
      }
      return;
    }
    var zoom = event.target.closest('[data-cf-zoom]');
    if (zoom) {
      event.preventDefault();
      setFocus(Number(zoom.getAttribute('data-cf-file')), zoom.getAttribute('data-cf-path'));
      return;
    }
    var modeLink = event.target.closest('[data-cf-mode]');
    if (modeLink) {
      event.preventDefault();
      setMode(modeLink.getAttribute('data-cf-mode'));
      return;
    }
    var jump = event.target.closest('.cf-jump-link');
    if (jump) {
      if (focus) clearFocus(false);
      var target = document.getElementById(jump.hash.slice(1));
      if (target) target.open = true;
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (view.hidden) return;
    if (!event.target.closest) return;
    var zoom = event.target.closest('a[data-cf-zoom]');
    if (zoom && event.key === 'Enter') {
      // A focused SVG link gets no default activation in every engine; inside
      // the report it means "zoom into this node", so do that instead of the
      // bare anchor jump the href would perform.
      event.preventDefault();
      setFocus(Number(zoom.getAttribute('data-cf-file')), zoom.getAttribute('data-cf-path'));
      return;
    }
    if (event.key === 'Escape' && focus) {
      event.preventDefault();
      clearFocus(true);
    }
  });

  upgradeLabels();
  applyMode();
  applyFocus();
  renderCrumbs();
}());
`;
