import {
  CALL_FLOW_MAX_CHILDREN,
  CALL_FLOW_MAX_CROSS_FILE_CHILDREN,
  CALL_FLOW_MAX_DEPTH,
  CALL_FLOW_MAX_NODES,
  CALL_FLOW_MAX_ROOTS,
} from "./call-flow.js";
import {
  CALL_FLOW_DEFAULT_DEPTH,
  CALL_FLOW_DEPTHS,
  CALL_FLOW_MODES,
  CALL_FLOW_NAV_SOURCE,
} from "./call-flow-nav.js";
import { escapeHtml } from "./escape-html.js";
import type { FlowMode } from "./call-flow-nav.js";
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
 * JavaScript disabled: mode sections stack under their own headings, tree
 * nodes fold with native `<details>`, and the resolved definition of a call —
 * line-numbered and escaped — sits in its own `<details>` under the call. The
 * appended script switches modes, keeps an explicit trail of the functions the
 * reviewer visited, limits the graph to a depth below the focused call, and
 * repeats one node's server-rendered source in a single panel; it reads every
 * label from the escaped DOM and never receives report text.
 *
 * Node identity is an occurrence path (`0-2-1`), never a key or a name, so
 * duplicate and hostile keys stay distinct, and trail entries carry the file
 * section as well, so the same path in two files stays two entries. Status
 * reaches the reviewer as a glyph plus color for a call that was added,
 * removed, or contains a change, and plain dimmed text for an unchanged call.
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
    '<nav class="cf-crumbs" id="cf-crumbs" aria-label="Visited call trail" hidden></nav>',
    // One panel the script fills with the focused call's definition; without the
    // script each call keeps its own server-rendered source disclosure instead.
    '<details class="cf-src-panel" id="cf-src-panel" hidden>',
    '<summary class="cf-src-panel-sum">Source details</summary>',
    '<div class="cf-src-panel-body" id="cf-src-panel-body"></div>',
    "</details>",
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

const MODES: readonly FlowMode[] = CALL_FLOW_MODES;

const AVAILABILITY_NOTE = {
  available: "No call tree reaches a changed file in this range. This is not evidence of safety.",
  "needs-git-range": "Call paths need a git range. This input was a patch, so no call trees were built.",
  "no-changes": "No call path reaches a changed file. This is not evidence of safety.",
  failed: "Call-flow analysis failed, so no call trees were built. The diff review is unaffected.",
} satisfies Record<CallFlowAvailability, string>;

/** Call paths drawn per file in Sequence mode before the omitted-path note. */
const SEQUENCE_LIMIT = 10;

/** What the serializer keeps per changed file; the UI states the same bounds. */
const BOUNDS_TEXT =
  `roots ≤${CALL_FLOW_MAX_ROOTS}, depth ≤${CALL_FLOW_MAX_DEPTH} edges, ` +
  `≤${CALL_FLOW_MAX_CHILDREN} calls per node (up to ${CALL_FLOW_MAX_CROSS_FILE_CHILDREN} more when the callee is defined in another file), ` +
  `${CALL_FLOW_MAX_NODES} nodes per file`;

const GRAPH_NODE_HEIGHT = 40;
/** Extra box height for the one-line description the backend may attach. */
const GRAPH_DESC_HEIGHT = 13;
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
    `<p class="cf-prov" title="${escapeHtml(`Bounds per file: ${BOUNDS_TEXT}. Source is the complete resolved definition at the reviewed revision. Dynamic calls may be absent.`)}">Syntactic calls · depth ≤4 · + added · − removed · ~ changed</p>`,
    `<p class="cf-note">${escapeHtml(coverage)}</p>`,
    "</div>",
  ].join("\n");
}

/** Mode anchors work without JavaScript (each jumps to its section); the
 *  script marks the active one with aria-current once all modes are switchable.
 *  The depth control exists only with the script and only bounds the graph: it
 *  counts call levels below the focused call, and the focus itself resets it. */
function renderControls(): string {
  const links = MODES.map(
    (mode) =>
      `<a class="cf-mode-link" data-cf-mode="${mode}" href="#cf-f1-${mode}">${MODE_LABEL[mode]}</a>`,
  ).join("");
  const depths = CALL_FLOW_DEPTHS.map(
    (depth) =>
      `<button type="button" class="cf-depth-btn" data-cf-depth="${depth}"` +
      ` aria-pressed="${depth === CALL_FLOW_DEFAULT_DEPTH ? "true" : "false"}"` +
      ` title="Show ${depth === "all" ? "every serialized call" : `${depth} call ${depth === 1 ? "level" : "levels"}`} below the focus">` +
      `${depth === "all" ? "All" : depth}</button>`,
  ).join("");
  return [
    '<div class="cf-controls">',
    `<div class="cf-modes" role="group" aria-label="Call flow mode">${links}</div>`,
    '<div class="cf-depth enhanced" role="group" aria-label="Graph depth below the focused call">',
    '<span class="cf-depth-label">Graph depth</span>',
    depths,
    "</div>",
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
      ? `<p class="cf-bounds">Bounds reached for this file: ${escapeHtml(BOUNDS_TEXT)}. Calls cut at a bound are omitted.</p>`
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

/** The resolved definition of one call. It is a native disclosure, so the actual
 *  source is readable without the script, and the script clones this body into
 *  its single panel instead of sending report text through the DOM builder. */
function renderSource(node: CallFlowNode, path: string, at: number): string {
  const source = node.source;
  if (!source) {
    return `<details class="cf-source" id="cf-f${at}-src-${path}">` +
      '<summary class="cf-src-sum">Source unavailable</summary>' +
      '<div class="cf-src-body"><p class="cf-src-note">No resolved definition source for this call.</p></div></details>';
  }
  const location = sourceLocationText(source);
  const lines = source.text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const body =
    lines.every((line) => line.trim() === "")
      ? '<p class="cf-src-note">No definition text was captured for this call.</p>'
      : [
          '<pre class="cf-src-code">',
          lines
            .map(
              (line, index) =>
                '<span class="cf-src-line">' +
                `<span class="cf-src-no" aria-hidden="true">${source.line + index}</span>` +
                `${escapeHtml(line)}</span>`,
            )
            .join(""),
          "</pre>",
        ].join("");
  const ref = source.ref === "" ? "" : ` · resolved from ${source.ref}`;
  return [
    `<details class="cf-source" id="cf-f${at}-src-${path}">`,
    `<summary class="cf-src-sum mono">${escapeHtml(location)}</summary>`,
    '<div class="cf-src-body">',
    `<p class="cf-src-ref mono">${escapeHtml(`Definition in ${location}${ref}`)}</p>`,
    body,
    "</div>",
    "</details>",
  ].join("");
}

/** Identity and the two files a node is known by: the resolved definition file
 *  when the backend resolved one, and the call-site file the node carries. */
function nodeAttrs(node: CallFlowNode, path: string, at: number): string {
  const source = node.source;
  return [
    ` id="cf-f${at}-t-${path}"`,
    ` data-cf-file="${at}"`,
    ` data-cf-path="${path}"`,
    source ? ` data-cf-srcfile="${escapeHtml(source.file)}"` : "",
    node.file === undefined ? "" : ` data-cf-nodefile="${escapeHtml(node.file)}"`,
  ].join("");
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
    node.description ? `<span class="cf-desc">${escapeHtml(node.description)}</span>` : "",
    // An anchor, not a button: it reaches the disclosure below without the script.
    `<a class="cf-src-link" href="#cf-f${at}-src-${id}" data-cf-source` +
      ` data-cf-file="${at}" data-cf-path="${id}">${node.source ? "source" : "details"}</a>`,
  ]
    .filter((part) => part !== "")
    .join("");
  const classes = ["cf-node", `cf-st-${status}`];
  if (inFile) classes.push("cf-infile");
  const kids = node.children;
  const source = renderSource(node, id, at);
  if (kids.length === 0) {
    return `<li class="${classes.join(" ")} cf-leaf"${nodeAttrs(node, id, at)}><span class="cf-row">${row}</span>${source}</li>`;
  }
  const children = kids
    .map((child, childAt) => renderTreeNode(child, path.concat([childAt]), at, changedFile))
    .join("\n");
  return [
    `<li class="${classes.join(" ")}"${nodeAttrs(node, id, at)}>`,
    '<details class="cf-fold" open>',
    `<summary class="cf-row">${row}</summary>`,
    `<ul class="cf-children">${children}</ul>`,
    "</details>",
    source,
  ]
    .filter((part) => part !== "")
    .join("");
}

/** The mark is drawn only for a call that changed; `same` keeps its label dim. */
function statusBadge(status: CallFlowStatus, extra: string): string {
  const mark = STATUS_MARK[status];
  return [
    mark === "" ? "" : `<span class="${extra} ${extra}-${status}" aria-hidden="true">${mark}</span>`,
    `<span class="sr">${STATUS_WORD[status]}</span>`,
  ].join("");
}

/** The resolved-definition record the backend attaches when it resolved one. */
type ResolvedSource = NonNullable<CallFlowNode["source"]>;

/** `file:line` or `file:line-endLine` for the resolved definition. */
function sourceLocationText(source: ResolvedSource): string {
  const end = source.endLine;
  return `${source.file}:${end > source.line ? `${source.line}-${end}` : `${source.line}`}`;
}

/** `file:line` when both are known, `file:line-endLine` for a call that spans
 *  lines, the file alone when the line is not known. */
function locationText(node: CallFlowNode): string {
  const file = node.file ?? "";
  const line = node.line ?? null;
  const end = node.endLine ?? null;
  if (line === null) return file;
  const span = end !== null && end > line ? `${line}-${end}` : `${line}`;
  return file === "" ? `line ${span}` : `${file}:${span}`;
}

function renderGraphMode(view: FileView, at: number): string {
  const figures = view.trees
    .map((tree, root) => {
      const layout = layoutTree(tree, [root]);
      const edges = layout.edges
        .map((edge, index) => renderGraphEdge(edge, index + 1, layout.edges.length, at))
        .join("");
      const boxes = layout.boxes
        .map((box) => renderGraphNode(box, at, view.file))
        .join("");
      return [
        `<div class="cf-graph-frame" data-cf-graph="${at}:${root}">`,
        '<div class="cf-camera-tools enhanced" role="group" aria-label="Graph framing">',
        '<button type="button" data-cf-camera="out" aria-label="Zoom out">−</button>',
        '<output class="cf-scale" aria-label="Graph scale">100%</output>',
        '<button type="button" data-cf-camera="in" aria-label="Zoom in">+</button>',
        '<button type="button" data-cf-camera="overview" title="Fit all retained calls. Labels may be small.">Overview</button>',
        '<button type="button" data-cf-camera="readable" title="Readable size at the selected function">Readable</button>',
        '<span class="cf-note">Drag / swipe to pan</span>',
        '</div>',
        '<div class="cf-svg-wrap">',
        `<svg class="cf-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="${escapeHtml(`Call graph for ${tree.label}`)}">`,
        edges,
        boxes,
        "</svg></div></div>",
      ].join("");
    })
    .join("\n");
  return modeSection(
    "graph",
    at,
    `${figures}<p class="cf-note cf-edge-note">Boxes select and show source. + and numbered edges focus a branch. Numbers identify static calls, not execution order.</p>`,
  );
}

interface GraphBox {
  readonly node: CallFlowNode;
  readonly path: readonly number[];
  x: number;
  y: number;
  readonly width: number;
  /** Taller when the backend attached a description line. */
  readonly height: number;
  readonly labelChars: number;
  readonly locChars: number;
  readonly descChars: number;
}

interface GraphLayout {
  readonly boxes: GraphBox[];
  readonly edges: Array<{ from: GraphBox; to: GraphBox }>;
  readonly width: number;
  readonly height: number;
}

/**
 * Hand layout: one row per call depth, boxes packed left to right and centred
 * per row, elbow edges from parent bottom to child top. A row is as tall as its
 * tallest box, so a description line on one call never overlaps the next row.
 * The enhanced viewport frames these coordinates without shrinking text.
 * Without JavaScript the native-size diagram scrolls inside its container.
 */
function layoutTree(root: CallFlowNode, rootPath: readonly number[]): GraphLayout {
  const levels: GraphBox[][] = [];
  const boxes: GraphBox[] = [];
  const edges: Array<{ from: GraphBox; to: GraphBox }> = [];
  const walk = (node: CallFlowNode, path: readonly number[], parent: GraphBox | null): void => {
    const loc = locationText(node);
    const description = node.description ?? "";
    const labelChars = Math.max(1, node.label.length + (node.status === "same" ? 0 : 2));
    const width = Math.ceil(
      Math.min(
        GRAPH_MAX_WIDTH,
        Math.max(
          GRAPH_MIN_WIDTH,
          48 +
            Math.max(
              labelChars * GRAPH_CHAR,
              loc.length * GRAPH_LOC_CHAR,
              description.length * GRAPH_LOC_CHAR,
            ),
        ),
      ),
    );
    const box: GraphBox = {
      node,
      path,
      x: 0,
      y: 0,
      width,
      height: description === "" ? GRAPH_NODE_HEIGHT : GRAPH_NODE_HEIGHT + GRAPH_DESC_HEIGHT,
      labelChars: Math.floor((width - 48) / GRAPH_CHAR),
      locChars: Math.floor((width - 24) / GRAPH_LOC_CHAR),
      descChars: Math.floor((width - 24) / GRAPH_LOC_CHAR),
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
  const levelHeights = levels.map((level) => Math.max(...level.map((box) => box.height)));
  const widest = Math.max(...levelWidths, GRAPH_MIN_WIDTH) + GRAPH_PAD * 2;
  let top = GRAPH_PAD;
  levels.forEach((level, depth) => {
    let x = GRAPH_PAD + Math.max(0, (widest - GRAPH_PAD * 2 - levelWidths[depth]) / 2);
    const y = top;
    top += levelHeights[depth] + GRAPH_LEVEL_GAP;
    for (const box of level) {
      box.x = Math.round(x);
      box.y = y;
      x += box.width + GRAPH_COLUMN_GAP;
    }
  });
  const height =
    GRAPH_PAD * 2 +
    levelHeights.reduce((total, level) => total + level, 0) +
    Math.max(0, levels.length - 1) * GRAPH_LEVEL_GAP;
  return { boxes, edges, width: Math.round(widest), height: Math.round(height) };
}

/** Elbow edge plus the number of that call in the serialized diagram. The
 *  number is a link, because it zooms into the callee the edge points at. */
function renderGraphEdge(
  edge: { from: GraphBox; to: GraphBox },
  number: number,
  total: number,
  at: number,
): string {
  const { from, to } = edge;
  const id = to.path.join("-");
  const x1 = Math.round(from.x + from.width / 2);
  const y1 = Math.round(from.y + from.height);
  const x2 = Math.round(to.x + to.width / 2);
  const y2 = Math.round(to.y);
  const mid = Math.round(y1 + (y2 - y1) / 2);
  const title = `${from.node.label} → ${to.node.label} · call ${number} of ${total} in serialized order`;
  return [
    `<path class="cf-edge" data-cf-edge-child="${id}"`,
    ` d="M${x1} ${y1} V${mid} H${x2} V${y2}"></path>`,
    `<a class="cf-edge-num" data-cf-edge="${number}" href="#cf-f${at}-t-${id}" data-cf-zoom data-cf-file="${at}" data-cf-path="${id}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<circle cx="${x2}" cy="${mid}" r="9"></circle>`,
    `<text class="cf-edge-num-text" x="${x2}" y="${mid + 4}" text-anchor="middle">${number}</text>`,
    "</a>",
  ].join("");
}

function renderGraphNode(box: GraphBox, at: number, changedFile: string): string {
  const node = box.node;
  const path = box.path.join("-");
  const status = node.status;
  const loc = locationText(node);
  const source = node.source;
  const description = node.description ?? "";
  const desc = description === "" ? "" : clip(description, box.descChars);
  const inFile = node.file === changedFile;
  const action = `href="#cf-f${at}-src-${path}" data-cf-source`;
  const title = [
    node.label,
    loc === "" ? "no source location" : loc,
    STATUS_WORD[status],
    description,
    source ? `definition in ${sourceLocationText(source)}` : "no resolved definition source",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const mark = STATUS_MARK[status];
  const label = clip(mark ? `${mark} ${node.label}` : node.label, box.labelChars);
  return [
    `<a class="cf-gnode cf-st-${status}${inFile ? " cf-infile" : ""}" ${action} data-cf-file="${at}" data-cf-path="${path}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="7"></rect>`,
    `<text class="cf-glabel" x="${box.x + 12}" y="${loc === "" && desc === "" ? box.y + 25 : box.y + 17}">${escapeHtml(label)}</text>`,
    loc === ""
      ? ""
      : `<text class="cf-gloc" x="${box.x + 12}" y="${box.y + 31}">${escapeHtml(clip(loc, box.locChars))}</text>`,
    desc === ""
      ? ""
      : `<text class="cf-gdesc" x="${box.x + 12}" y="${loc === "" ? box.y + 31 : box.y + 44}">${escapeHtml(desc)}</text>`,
    "</a>",
    `<a class="cf-gzoom" href="#cf-f${at}-t-${path}" data-cf-zoom data-cf-file="${at}" data-cf-path="${path}" aria-label="Zoom into ${escapeHtml(node.label)}">`,
    `<circle cx="${box.x + box.width - 13}" cy="${box.y + 13}" r="10"></circle>`,
    `<text x="${box.x + box.width - 13}" y="${box.y + 17}" text-anchor="middle">+</text>`,
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
    `<p class="cf-note">Static call paths, not execution order.</p><ol class="cf-paths" data-cf-path-limit="${SEQUENCE_LIMIT}">${paths.map((chain) => renderPath(chain, at)).join("\n")}</ol>${note}`,
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
): string {
  const leaf = chain[chain.length - 1];
  const chips = chain
    .map((step) => renderChip(step, at))
    .join('<span class="cf-arrow" aria-hidden="true">→</span>');
  return `<li class="cf-path" data-cf-file="${at}" data-cf-path="${leaf.path.join("-")}">${chips}</li>`;
}

/** A chip is the step's zoom target plus, when the backend resolved it, its own
 *  source link: without the script both are plain anchors that reach the tree. */
function renderChip(step: { node: CallFlowNode; path: readonly number[] }, at: number): string {
  const path = step.path.join("-");
  const node = step.node;
  const status = node.status;
  const loc = locationText(node);
  const title = loc === "" ? "" : ` title="${escapeHtml(loc)}"`;
  return [
    `<span class="cf-chip cf-st-${status}"${title}>`,
    `<a class="cf-chip-zoom" href="#cf-f${at}-t-${path}" data-cf-zoom data-cf-file="${at}" data-cf-path="${path}">`,
    statusBadge(status, "cf-chip-badge"),
    `<span class="cf-chip-label mono">${escapeHtml(node.label)}</span>`,
    loc === "" ? "" : `<span class="cf-chip-loc mono">${escapeHtml(loc)}</span>`,
    "</a>",
    node.description ? `<span class="cf-desc">${escapeHtml(node.description)}</span>` : "",
    `<a class="cf-src-link" href="#cf-f${at}-src-${path}" data-cf-source` +
      ` data-cf-file="${at}" data-cf-path="${path}">${node.source ? "source" : "details"}</a>`,
    "</span>",
  ]
    .filter((part) => part !== "")
    .join("");
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
.cf-ready .cf-controls { position: sticky; top: var(--toolbar-height, 0px); z-index: 4; background: var(--bg); padding: 8px 0; }
.cf, .cf-files, .cf-file-body, .cf-mode { min-width: 0; }
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
  flex-wrap: nowrap;
  gap: 6px;
  font-size: 12.5px;
  padding-bottom: 3px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.cf-crumb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  max-width: 34ch;
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
  white-space: nowrap;
}
.cf-crumb[aria-current] { border-color: var(--cursor); font-weight: 600; }
.cf-crumb-label { overflow: hidden; text-overflow: ellipsis; }
.cf-crumb-file {
  flex: 0 0 auto;
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--ink-soft);
}
.cf-sep { flex: 0 0 auto; color: var(--ink-soft); }
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
.cf-ready .cf-mode-head { display: none; }
.cf-ready .cf-mode + .cf-mode { margin-top: 0; border-top: 0; }
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
  max-width: 100%;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--sunken);
  overscroll-behavior: contain;
}
.cf-svg { display: block; max-width: none; }
.cf-ready .cf-svg-wrap { height: clamp(280px, 48vh, 440px); overflow: hidden; touch-action: none; cursor: grab; }
.cf-ready .cf-svg-wrap:focus-visible { outline: 2px solid var(--cursor); outline-offset: 2px; }
.cf-ready .cf-svg-wrap.cf-dragging { cursor: grabbing; user-select: none; }
.cf-ready .cf-svg { width: 100%; height: 100%; }
.cf-graph-frame + .cf-graph-frame { margin-top: 14px; }
.cf-camera-tools { align-items: center; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.cf-camera-tools button { min-height: 36px; font-size: 12px; }
.cf-scale { min-width: 4ch; text-align: center; font: 11px var(--mono); color: var(--ink-soft); }
.cf-omitted { display: none; }
.cf-ready .cf-omitted { display: block; }
.cf-node.cf-selected > .cf-row, .cf-node.cf-selected > .cf-fold > .cf-row,
.cf-chip.cf-selected { outline: 2px solid var(--cursor); outline-offset: 1px; border-radius: 5px; }
.cf-edge { fill: none; stroke: var(--line-strong); stroke-width: 1.5; }
.cf-gnode rect { fill: var(--panel); stroke: var(--line-strong); stroke-width: 1.5; }
.cf-gnode:focus-visible { outline: none; }
.cf-gzoom circle { fill: var(--panel); stroke: var(--line-strong); }
.cf-gzoom text { fill: var(--ink); font: 14px var(--mono); }
.cf-gzoom:hover circle, .cf-gzoom:focus-visible circle { stroke: var(--cursor); stroke-width: 2; }
.cf-gzoom:focus-visible { outline: none; }
.cf-glabel { font-family: var(--mono); font-size: 12px; fill: var(--ink); }
.cf-gloc { font-family: var(--mono); font-size: 10px; fill: var(--ink-soft); }
.cf-gnode.cf-st-same rect { stroke: var(--line); fill: transparent; }
.cf-gnode.cf-st-same .cf-glabel { fill: var(--ink-soft); }
.cf-gnode:not(.cf-st-same) rect { stroke: var(--cf-color); fill: var(--cf-fill); }
.cf-gnode:not(.cf-st-same) .cf-glabel { fill: var(--cf-color); }
.cf-gnode:hover rect, .cf-gnode:focus-visible rect { stroke: var(--cursor); stroke-width: 2.5; }
.cf-gnode.cf-selected rect { stroke: var(--cursor); stroke-width: 3; }
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
}
.cf-chip:hover, .cf-chip:focus-within { border-color: var(--cursor); }
.cf-chip-zoom {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  color: inherit;
  text-decoration: none;
}
.cf-chip-label { min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.cf-chip-loc { font-size: 10.5px; color: var(--ink-soft); }
.cf-chip.cf-st-same .cf-chip-label { color: var(--ink-soft); }
.cf-chip:not(.cf-st-same) { border-color: var(--cf-color); background: var(--cf-fill); }
.cf-chip:not(.cf-st-same) .cf-chip-label { color: var(--cf-color); }
.cf-chip .cf-desc { max-width: 28ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-arrow { color: var(--ink-soft); font-size: 12px; }
/* One description line per call, only when the backend attached one. */
.cf-desc { font-size: 11.5px; color: var(--ink-soft); font-style: italic; overflow-wrap: anywhere; }
.cf-depth { align-items: center; gap: 4px; }
.cf-depth-label { font-size: 12px; color: var(--ink-soft); }
.cf-depth-btn { padding: 3px 9px; font-size: 12px; }
.cf-depth-btn[aria-pressed="true"] { border-color: var(--cursor); background: var(--sunken); font-weight: 600; }
/* Numbered, clickable call order on the graph edges. */
.cf-edge-num circle { fill: var(--panel); stroke: var(--line-strong); stroke-width: 1.5; }
.cf-edge-num text { font-family: var(--mono); font-size: 10.5px; fill: var(--ink-soft); }
.cf-edge-num:hover circle, .cf-edge-num:focus-visible circle { stroke: var(--cursor); stroke-width: 2; }
.cf-edge-num:hover text, .cf-edge-num:focus-visible text { fill: var(--cursor); font-weight: 700; }
.cf-edge-num:focus-visible { outline: none; }
.cf-gdesc { font-family: var(--mono); font-size: 10px; font-style: italic; fill: var(--ink-soft); }
/* Resolved definition of one call: a native disclosure without the script, and
   the body the script clones into its single shared panel. */
.cf-source { margin: 3px 0 3px 24px; }
.cf-ready .cf-source { display: none; }
.cf-src-sum { width: fit-content; cursor: pointer; list-style: none; font-size: 11.5px; color: var(--ink-soft); }
.cf-src-sum::-webkit-details-marker { display: none; }
.cf-src-sum::before { content: "▸"; margin-right: 6px; font-size: 10px; transition: transform 0.15s ease; display: inline-block; }
.cf-source[open] > .cf-src-sum::before { transform: rotate(90deg); }
.cf-src-sum:hover, .cf-src-sum:focus-visible { color: var(--cursor); }
.cf-src-body { padding: 6px 0 4px; }
.cf-src-ref { margin: 0 0 5px; font-size: 11.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.cf-src-code {
  margin: 0;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--sunken);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-x: auto;
}
.cf-src-line { display: block; white-space: pre; }
.cf-src-no {
  display: inline-block;
  width: 4ch;
  margin-right: 10px;
  text-align: right;
  color: var(--ink-soft);
  user-select: none;
}
.cf-src-note { margin: 0; font-size: 11.5px; color: var(--ink-soft); font-style: italic; }
.cf-src-panel {
  padding: 8px 12px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
}
.cf-src-panel-sum { width: fit-content; cursor: pointer; font-size: 12.5px; font-weight: 600; }
.cf-src-panel-body { padding-top: 6px; }
.cf-src-panel-body { max-height: 40vh; overflow: auto; }
.cf-src-head-line { margin: 0 0 6px; font-size: 12px; color: var(--ink-soft); overflow-wrap: anywhere; }
.cf-src-missing { margin: 0; }
.cf-src-link {
  font-size: 11.5px;
  color: var(--ink-soft);
  text-decoration: underline dotted;
  white-space: nowrap;
}
.cf-src-link:hover, .cf-src-link:focus-visible { color: var(--cursor); }
@media (max-width: 680px) {
  .cf-jump ul { max-height: 38vh; }
  .cf-jump-link { width: 100%; }
  .cf-jump-path { max-width: none; flex: 1 1 auto; }
  .cf-file-body { padding: 0 11px 12px; }
  .cf-crumb { max-width: 24ch; }
  .cf-crumb-file { max-width: 12ch; }
  .cf-source { margin-left: 10px; }
  .cf-src-no { width: 3ch; margin-right: 7px; }
  .cf-chip, .cf-chip-zoom { min-width: 0; flex-wrap: wrap; }
  .cf-chip-loc { overflow-wrap: anywhere; }
}
`;

/**
 * Progressive enhancement for the rendered call flow. Nothing here is
 * interpolated: the visited trail, mode, depth and the source text all come from
 * attributes and text already escaped in the DOM, and the navigation state
 * machine is the module the unit tests call (see CALL_FLOW_NAV_SOURCE).
 */
export const CALL_FLOW_SCRIPT = `
(function () {
  'use strict';
  ${CALL_FLOW_NAV_SOURCE}
  var view = document.getElementById('view-call-flow');
  if (!view) return;
  var host = view.querySelector('.cf');
  if (!host) return;
  var files = Array.prototype.slice.call(view.querySelectorAll('.cf-file'));
  var modeLinks = Array.prototype.slice.call(view.querySelectorAll('[data-cf-mode]'));
  var depthButtons = Array.prototype.slice.call(view.querySelectorAll('[data-cf-depth]'));
  var crumbNav = document.getElementById('cf-crumbs');
  var sourcePanel = document.getElementById('cf-src-panel');
  var sourceBody = document.getElementById('cf-src-panel-body');
  var state = cfNav.createState();
  var graphViews = new WeakMap();
  var graphSelections = new WeakMap();
  var drag = null;
  var suppressClick = false;

  function rectOf(rect) {
    return {
      x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')),
      width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')),
    };
  }

  function paintCamera(graph, camera) {
    var info = graphViews.get(graph);
    state = cfNav.setCamera(state, info.key, camera);
    graph.setAttribute('viewBox', [camera.x, camera.y, info.size.width / camera.scale, info.size.height / camera.scale].join(' '));
    var frame = graph.closest('.cf-graph-frame');
    frame.querySelector('.cf-scale').textContent = Math.round(camera.scale * 100) + '%';
    frame.querySelector('[data-cf-camera="out"]').disabled = camera.scale <= 1;
    frame.querySelector('[data-cf-camera="in"]').disabled = camera.scale >= 2.5;
  }

  function frameGraph(graph) {
    var wrap = graph.parentElement;
    if (state.mode !== 'graph' || !wrap.clientWidth || !wrap.clientHeight || !graph.getClientRects().length) return;
    var boxes = graph.querySelectorAll('a.cf-gnode:not([hidden]) rect');
    if (!boxes.length) return;
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (var i = 0; i < boxes.length; i++) {
      var box = rectOf(boxes[i]);
      left = Math.min(left, box.x); top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
    }
    var selected = graph.querySelector('a.cf-gnode.cf-selected:not([hidden]) rect');
    var bounds = { x: left - 16, y: top - 16, width: right - left + 32, height: bottom - top + 32 };
    var size = { width: wrap.clientWidth, height: wrap.clientHeight };
    var target = rectOf(selected || boxes[0]);
    var branch = state.branch;
    var key = graph.closest('.cf-graph-frame').getAttribute('data-cf-graph') + '/' +
      (branch ? cfNav.key(branch.file, branch.path) : '') + '/' + state.depth;
    graphViews.set(graph, { key: key, bounds: bounds, size: size, target: target });
    var camera = state.cameras[key];
    camera = camera ? cfNav.constrain(camera, bounds, size) : cfNav.frame(bounds, size, target);
    var selection = selected ? selected.parentElement.getAttribute('data-cf-path') : '';
    // Only a new cross-view selection can move an existing camera. Returning to
    // the same selection preserves even a deliberately panned-away viewport.
    if (selected && graphSelections.has(graph) && graphSelections.get(graph) !== selection &&
        (target.x < camera.x || target.y < camera.y ||
         target.x + target.width > camera.x + size.width / camera.scale ||
         target.y + target.height > camera.y + size.height / camera.scale)) {
      camera = cfNav.frame(bounds, size, target);
    }
    graphSelections.set(graph, selection);
    paintCamera(graph, camera);
  }

  function frameGraphs() {
    var graphs = view.querySelectorAll('.cf-svg:not([hidden])');
    for (var i = 0; i < graphs.length; i++) frameGraph(graphs[i]);
  }

  function cameraAction(graph, action) {
    var info = graphViews.get(graph);
    if (!info) return;
    var camera = state.cameras[info.key];
    if (action === 'readable' || action === 'overview') {
      camera = cfNav.frame(info.bounds, info.size, info.target, action === 'overview');
    } else {
      camera = cfNav.zoom(camera, action === 'in' ? 1.25 : 0.8,
        { x: info.size.width / 2, y: info.size.height / 2 }, info.bounds, info.size);
    }
    paintCamera(graph, camera);
  }

  function fileAt(index) {
    for (var i = 0; i < files.length; i++) {
      if (files[i].getAttribute('data-cf-file') === String(index)) return files[i];
    }
    return null;
  }

  function each(list, at) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-cf-path') === at) return list[i];
    }
    return null;
  }

  function nodeAt(index, path) {
    var file = fileAt(index);
    return file === null ? null : each(file.querySelectorAll('li.cf-node'), path);
  }

  // Where the focus is right now: no entry means the whole file list is shown.
  function focusAt() {
    var entry = cfNav.current(state);
    return {
      file: entry === null ? null : entry.file,
      path: entry === null ? '' : entry.path,
    };
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
        sections[j].hidden = sections[j].getAttribute('data-cf-mode-body') !== state.mode;
      }
    }
    var focus = focusAt();
    for (var k = 0; k < modeLinks.length; k++) {
      var name = modeLinks[k].getAttribute('data-cf-mode');
      if (name === state.mode) modeLinks[k].setAttribute('aria-current', 'true');
      else modeLinks[k].removeAttribute('aria-current');
      if (focus.file !== null) modeLinks[k].setAttribute('href', '#cf-f' + focus.file + '-' + name);
    }
    for (var d = 0; d < depthButtons.length; d++) {
      var pressed = String(depthButtons[d].getAttribute('data-cf-depth')) === String(state.depth);
      depthButtons[d].setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    var depthControl = host.querySelector('.cf-depth');
    if (depthControl) depthControl.hidden = state.mode !== 'graph';
  }

  function applyFocus() {
    var selected = focusAt();
    var branch = state.branch;
    var focus = { file: branch === null ? null : branch.file, path: branch === null ? '' : branch.path };
    var depth = state.depth;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var mine = focus.file === null || file.getAttribute('data-cf-file') === String(focus.file);
      file.hidden = focus.file !== null && !mine;
      var nodes = file.querySelectorAll('li.cf-node');
      for (var n = 0; n < nodes.length; n++) {
        var path = nodes[n].getAttribute('data-cf-path');
        nodes[n].hidden = !mine || !cfNav.visibleNode(path, focus.path, 'all');
        nodes[n].classList.toggle('cf-selected', Number(file.getAttribute('data-cf-file')) === selected.file && path === selected.path);
        nodes[n].classList.toggle(
          'cf-ancestor',
          mine && focus.path !== '' && path !== focus.path && cfNav.onChain(path, focus.path),
        );
      }
      var gNodes = file.querySelectorAll('a.cf-gnode, a.cf-gzoom');
      for (var g = 0; g < gNodes.length; g++) {
        var gPath = gNodes[g].getAttribute('data-cf-path');
        gNodes[g].toggleAttribute('hidden', !mine || !cfNav.under(gPath, focus.path) || !cfNav.visibleNode(gPath, focus.path, depth));
        gNodes[g].classList.toggle('cf-selected', Number(file.getAttribute('data-cf-file')) === selected.file && gPath === selected.path);
      }
      var edges = file.querySelectorAll('path.cf-edge');
      for (var e = 0; e < edges.length; e++) {
        var child = edges[e].getAttribute('data-cf-edge-child');
        edges[e].toggleAttribute('hidden', !mine || !cfNav.visibleCall(child, focus.path, depth));
      }
      var numbers = file.querySelectorAll('a.cf-edge-num');
      for (var c = 0; c < numbers.length; c++) {
        var target = numbers[c].getAttribute('data-cf-path');
        numbers[c].toggleAttribute('hidden', !mine || !cfNav.visibleCall(target, focus.path, depth));
      }
      var graphs = file.querySelectorAll('.cf-svg');
      for (var s = 0; s < graphs.length; s++) {
        var graph = graphs[s];
        var shown = graph.querySelector('a.cf-gnode:not([hidden])');
        graph.toggleAttribute('hidden', !shown);
        graph.closest('.cf-graph-frame').hidden = !shown;
        if (shown) frameGraph(graph);
      }
      var paths = file.querySelectorAll('.cf-path');
      var pathList = file.querySelector('.cf-paths');
      var limit = pathList ? Number(pathList.getAttribute('data-cf-path-limit')) : 0;
      var matching = [];
      var preferred = -1;
      for (var p = 0; p < paths.length; p++) {
        var leaf = paths[p].getAttribute('data-cf-path');
        paths[p].hidden = true;
        if (mine && cfNav.under(leaf, focus.path)) {
          if (preferred < 0 && Number(file.getAttribute('data-cf-file')) === selected.file && cfNav.under(leaf, selected.path)) preferred = matching.length;
          matching.push(paths[p]);
        }
      }
      var matches = matching.length;
      for (var m = 0; m < Math.min(matches, limit); m++) {
        matching[m === limit - 1 && preferred >= limit ? preferred : m].hidden = false;
      }
      var chips = file.querySelectorAll('.cf-chip');
      for (var h = 0; h < chips.length; h++) {
        var link = chips[h].querySelector('[data-cf-path]');
        chips[h].classList.toggle('cf-selected', Number(file.getAttribute('data-cf-file')) === selected.file && link.getAttribute('data-cf-path') === selected.path);
      }
      var omitted = file.querySelector('.cf-omitted');
      if (omitted) {
        omitted.hidden = matches <= limit;
        omitted.textContent = 'Showing ' + Math.min(matches, limit) + ' of ' + matches + ' call paths; focus a branch to narrow.';
      }
    }
  }

  function labelAt(index, path) {
    var node = nodeAt(index, path);
    var label = node === null ? null : node.querySelector('.cf-label');
    return label === null ? '' : label.textContent;
  }

  function fileLabel(index) {
    var file = fileAt(index);
    var path = file === null ? null : file.querySelector('.cf-file-path');
    return path === null ? '' : path.textContent;
  }

  // Receiver file transitions: the resolved definition file when the backend
  // found one, the call-site file next, then the section the call is drawn in.
  function receiverFile(index, path) {
    var node = nodeAt(index, path);
    if (node !== null) {
      var source = node.getAttribute('data-cf-srcfile');
      if (source) return source;
      var callsite = node.getAttribute('data-cf-nodefile');
      if (callsite) return callsite;
    }
    return fileLabel(index);
  }

  function sep() {
    var span = document.createElement('span');
    span.className = 'cf-sep';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '/';
    return span;
  }

  function crumb(text, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'cf-crumb';
    if (index < 0) button.setAttribute('data-cf-root', '');
    else button.setAttribute('data-cf-crumb', String(index));
    var label = document.createElement('span');
    label.className = 'cf-crumb-label';
    label.textContent = text;
    button.appendChild(label);
    return button;
  }

  // The trail is the history of focused calls, so going back is clicking a tab:
  // every visit after it is dropped. A tab shows the file only where the
  // receiver file changes, which is what makes a cross-file step visible.
  function renderCrumbs() {
    if (!crumbNav) return;
    while (crumbNav.firstChild) crumbNav.removeChild(crumbNav.firstChild);
    var trail = state.trail;
    if (trail.length === 0) {
      crumbNav.hidden = true;
      return;
    }
    crumbNav.appendChild(crumb('All files', -1));
    var previous = '';
    for (var i = 0; i < trail.length; i++) {
      var entry = trail[i];
      var label = labelAt(entry.file, entry.path) || entry.path;
      var file = receiverFile(entry.file, entry.path);
      crumbNav.appendChild(sep());
      var tab = crumb(label, i);
      tab.setAttribute('title', file === '' ? label : label + ' · ' + file);
      if (i === trail.length - 1) tab.setAttribute('aria-current', 'true');
      if (file !== '' && (i === 0 || file !== previous)) {
        var tag = document.createElement('span');
        tag.className = 'cf-crumb-file mono';
        tag.textContent = file;
        tab.appendChild(tag);
      }
      previous = file;
      crumbNav.appendChild(tab);
    }
    crumbNav.hidden = false;
  }

  function note(text) {
    var paragraph = document.createElement('p');
    paragraph.className = 'cf-note cf-src-missing';
    paragraph.textContent = text;
    return paragraph;
  }

  // The single panel repeats the focused call's definition, cloned from the
  // disclosure the renderer escaped and line-numbered. No report text is parsed
  // or interpreted here; a call without a resolved definition says so.
  function showSource(index, path) {
    if (!sourcePanel || !sourceBody) return;
    var disclosure = document.getElementById('cf-f' + index + '-src-' + path);
    var body = disclosure === null ? null : disclosure.querySelector('.cf-src-body');
    while (sourceBody.firstChild) sourceBody.removeChild(sourceBody.firstChild);
    var head = document.createElement('p');
    head.className = 'cf-src-head-line mono';
    var where = receiverFile(index, path);
    head.textContent = labelAt(index, path) + (where === '' ? '' : ' · ' + where);
    sourceBody.appendChild(head);
    if (body) sourceBody.appendChild(body.cloneNode(true));
    else sourceBody.appendChild(note('No resolved definition source for this call. The call site above is all the report has.'));
    sourcePanel.hidden = false;
    sourcePanel.open = true;
    if (sourcePanel.scrollIntoView) sourcePanel.scrollIntoView({ block: 'nearest' });
  }

  function hideSource() {
    if (!sourcePanel || sourcePanel.hidden) return;
    sourcePanel.hidden = true;
    if (sourceBody) {
      while (sourceBody.firstChild) sourceBody.removeChild(sourceBody.firstChild);
    }
  }

  function reveal() {
    var focus = focusAt();
    if (focus.file === null) return;
    var file = fileAt(focus.file);
    if (!file) return;
    file.open = true;
    var section = file.querySelector('[data-cf-mode-body="' + state.mode + '"]');
    if (!section) return;
    var targets = section.querySelectorAll(state.mode === 'tree' ? 'li.cf-node' : state.mode === 'graph' ? 'a.cf-gnode' : '.cf-path:not([hidden]) .cf-chip-zoom');
    var target = each(targets, focus.path);
    if (!target) return;
    var fold = state.mode === 'tree' ? target.querySelector('.cf-fold') : null;
    if (fold) fold.open = true;
    var step = target;
    while (step && step !== view) {
      if (step.tagName === 'DETAILS') step.open = true;
      step = step.parentElement;
    }
    if (state.mode === 'tree') target = target.querySelector('.cf-label');
    if (state.mode === 'graph') {
      frameGraphs();
      target = target.closest('.cf-graph-frame');
    }
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (target && target.focus && state.mode !== 'graph') target.focus({ preventScroll: true });
  }

  function refresh(scrollCrumbs) {
    applyMode();
    applyFocus();
    renderCrumbs();
    if (scrollCrumbs && crumbNav && !crumbNav.hidden && crumbNav.scrollIntoView) {
      crumbNav.scrollIntoView({ block: 'nearest' });
    }
  }

  // Every path that changes the focus keeps an open source panel in step with
  // it, so the panel never describes a call the trail has left behind.
  function settle() {
    reveal();
    var focus = focusAt();
    if (sourcePanel && !sourcePanel.hidden && focus.file !== null) showSource(focus.file, focus.path);
  }

  function inspectSource(index, path) {
    state = cfNav.inspect(state, index, path);
    // Inspection must not move the canvas underneath the pointer.
    var graph = fileAt(index).querySelector('.cf-gnode[data-cf-path="' + path + '"]');
    if (graph && state.mode === 'graph') graphSelections.set(graph.closest('svg'), path);
    refresh(false);
    showSource(index, path);
  }

  function focusOn(index, path) {
    var next = cfNav.visit(state, index, path);
    if (next === state) return;
    state = next;
    refresh(true);
    settle();
  }

  function goBack(index) {
    var next = cfNav.truncate(state, index);
    if (next !== state) {
      state = next;
      refresh(true);
    }
    settle();
  }

  function clearFocus(scrollBack) {
    if (state.trail.length === 0) return;
    state = cfNav.clear(state);
    refresh(false);
    hideSource();
    if (scrollBack) host.scrollIntoView({ block: 'start' });
  }

  function setMode(next) {
    var change = cfNav.setMode(state, next);
    if (change === state) return;
    state = change;
    refresh(false);
    reveal();
  }

  function setDepth(value) {
    var change = cfNav.setDepth(state, value);
    if (change === state) return;
    state = change;
    refresh(false);
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;
    var cameraButton = event.target.closest('[data-cf-camera]');
    if (cameraButton) {
      cameraAction(cameraButton.closest('.cf-graph-frame').querySelector('svg'), cameraButton.getAttribute('data-cf-camera'));
      return;
    }
    var crumbButton = event.target.closest('.cf-crumb');
    if (crumbButton) {
      event.preventDefault();
      if (crumbButton.hasAttribute('data-cf-root')) clearFocus(false);
      else goBack(Number(crumbButton.getAttribute('data-cf-crumb')));
      return;
    }
    var depth = event.target.closest('[data-cf-depth]');
    if (depth) {
      event.preventDefault();
      setDepth(depth.getAttribute('data-cf-depth'));
      return;
    }
    var source = event.target.closest('[data-cf-source]');
    if (source) {
      event.preventDefault();
      inspectSource(Number(source.getAttribute('data-cf-file')), source.getAttribute('data-cf-path'));
      return;
    }
    var zoom = event.target.closest('[data-cf-zoom]');
    if (zoom) {
      event.preventDefault();
      focusOn(Number(zoom.getAttribute('data-cf-file')), zoom.getAttribute('data-cf-path'));
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
      hideSource();
      if (state.trail.length) clearFocus(false);
      var target = document.getElementById(jump.hash.slice(1));
      if (target) target.open = true;
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (view.hidden) return;
    if (!event.target.closest) return;
    var canvas = event.target.closest('.cf-svg-wrap');
    if (canvas) {
      var graph = canvas.querySelector('svg'), info = graphViews.get(graph);
      var moves = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
      if (info && moves[event.key]) {
        event.preventDefault();
        paintCamera(graph, cfNav.pan(state.cameras[info.key], moves[event.key][0], moves[event.key][1], info.bounds, info.size));
        return;
      }
      if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault();
        cameraAction(graph, event.key === '-' ? 'out' : 'in');
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        cameraAction(graph, 'readable');
        return;
      }
    }
    var link = event.target.closest('a[data-cf-zoom], a[data-cf-source]');
    if (link && event.key === 'Enter') {
      // A focused SVG link gets no default activation in every engine; inside
      // the report it means "zoom into this node" or "show this source", so do
      // that instead of the bare anchor jump the href would perform.
      event.preventDefault();
      var index = Number(link.getAttribute('data-cf-file')), path = link.getAttribute('data-cf-path');
      if (link.hasAttribute('data-cf-source')) inspectSource(index, path);
      else focusOn(index, path);
      return;
    }
    if (event.key === 'Escape' && sourcePanel && !sourcePanel.hidden) {
      event.preventDefault();
      hideSource();
      return;
    }
    if (event.key === 'Escape' && state.trail.length) {
      event.preventDefault();
      clearFocus(true);
    }
  });

  view.addEventListener('pointerdown', function (event) {
    var wrap = event.target.closest('.cf-svg-wrap');
    if (!wrap || event.button !== 0 || !event.isPrimary) return;
    suppressClick = false;
    drag = { wrap: wrap, id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  view.addEventListener('pointermove', function (event) {
    if (!drag || drag.id !== event.pointerId) return;
    var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    drag.wrap.setPointerCapture(event.pointerId);
    drag.wrap.classList.add('cf-dragging');
    var graph = drag.wrap.querySelector('svg'), info = graphViews.get(graph);
    if (info) paintCamera(graph, cfNav.pan(state.cameras[info.key], dx, dy, info.bounds, info.size));
    drag.x = event.clientX; drag.y = event.clientY;
  });
  function finishDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved && event.type === 'pointerup';
    drag.wrap.classList.remove('cf-dragging');
    if (drag.wrap.hasPointerCapture(event.pointerId)) drag.wrap.releasePointerCapture(event.pointerId);
    drag = null;
  }
  view.addEventListener('pointerup', finishDrag);
  view.addEventListener('pointercancel', finishDrag);
  view.addEventListener('click', function (event) {
    if (!suppressClick) return;
    suppressClick = false;
    if (!event.target.closest('.cf-svg-wrap')) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  var wraps = view.querySelectorAll('.cf-svg-wrap');
  for (var w = 0; w < wraps.length; w++) {
    wraps[w].tabIndex = 0;
    wraps[w].setAttribute('role', 'region');
    wraps[w].setAttribute('aria-label', 'Pannable call graph. Arrow keys pan, plus and minus zoom, Home restores readable size.');
  }
  view.addEventListener('focusin', function (event) {
    var link = event.target.closest('.cf-gnode, .cf-gzoom, .cf-edge-num');
    if (!link || !link.matches(':focus-visible')) return;
    var graph = link.closest('svg'), info = graphViews.get(graph);
    var node = each(graph.querySelectorAll('.cf-gnode'), link.getAttribute('data-cf-path'));
    if (!info || !node) return;
    var target = rectOf(node.querySelector('rect'));
    var camera = state.cameras[info.key];
    if (target.x < camera.x || target.y < camera.y || target.x + target.width > camera.x + info.size.width / camera.scale ||
        target.y + target.height > camera.y + info.size.height / camera.scale) {
      paintCamera(graph, cfNav.frame(info.bounds, info.size, target));
    }
  });
  if (typeof ResizeObserver !== 'undefined') {
    var observer = new ResizeObserver(frameGraphs);
    for (var r = 0; r < wraps.length; r++) observer.observe(wraps[r]);
  } else window.addEventListener('resize', frameGraphs);
  view.addEventListener('toggle', frameGraphs, true);

  upgradeLabels();
  host.classList.add('cf-ready');
  refresh(false);
}());
`;
