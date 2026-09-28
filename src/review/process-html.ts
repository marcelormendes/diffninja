/**
 * The business view of a review: the reviewing agent's explanation drawn for
 * a person who does not know this part of the product.
 *
 * Each process becomes a flowchart: steps in the order they happen, decisions
 * with their labelled exits, and the steps this change adds, alters, or takes
 * away highlighted, like a diff laid over the process instead of over the code.
 * Under each chart the same steps are a numbered list carrying what the chart
 * has no room for: the rule behind a step, how a changed step worked before,
 * the functions that carry it out (their purpose first, their name second), and
 * links to the hunks that change it. The business rules follow as before and
 * after, and a glossary gives every listed function's purpose.
 *
 * Everything is server-rendered SVG and HTML with no script, so it reads the
 * same without JavaScript and inside the pull request page's drawer. Every
 * string is the agent's text or a path from the report, and all of it is
 * HTML-escaped; the layout is a pure function of the explanation, so the same
 * explanation always draws the same chart.
 */

import { escapeHtml } from "./escape-html.js";
import {
  exitsOf,
  purposesOf,
  type BusinessProcess,
  type BusinessRule,
  type ExplainedFunction,
  type ExplanationChange,
  type ProcessStep,
  wrapWords,
} from "./explanation.js";
import type { ReviewReport } from "./types.js";

export interface BusinessViewOptions {
  /** Link for a hunk id, or undefined when this page has no diff to link to. */
  readonly hunkHref?: (itemId: string) => string | undefined;
  /** Leave out the function glossary (the call-flow view shows the purposes). */
  readonly glossary?: boolean;
  /** Leave out the attribution line when the page around it already says who explained it. */
  readonly attribution?: boolean;
  /** Whether each chart's step-by-step list starts open; a compact embed starts it folded. */
  readonly stepsOpen?: boolean;
}

const CHANGE_WORD = {
  added: "New",
  changed: "Changed",
  removed: "Removed",
  unchanged: "",
} satisfies Record<ExplanationChange, string>;

const CHANGE_SENTENCE = {
  added: "added by this change",
  changed: "changed by this change",
  removed: "removed by this change",
  unchanged: "unchanged",
} satisfies Record<ExplanationChange, string>;

/** Chart geometry, in SVG user units (pixels at 100%). */
const NODE_WIDTH = 264;
const WRAP_CHARS = 30;
/** A decision's slanted sides leave less room for its question. */
const DECISION_WRAP_CHARS = 25;
const LINE_HEIGHT = 18;
const TAG_ROW = 16;
const NODE_PAD_Y = 11;
const LAYER_GAP = 60;
/** Heights inside the gap between two rows: where an elbow turns, where lane edges leave and arrive. */
const GAP_TURN = 26;
const GAP_DEPART = 34;
const GAP_ARRIVE = 12;
const COLUMN_GAP = 36;
const LANE_GAP = 18;
const CHART_PAD = 14;
const DECISION_INSET = 16;

/**
 * The whole business view, or a note saying why there is none.
 */
export function renderBusinessView(report: ReviewReport, options: BusinessViewOptions = {}): string {
  const explanation = report.agentExplanation;
  if (explanation === undefined) {
    return `<p class="bp-note bp-absent">No business explanation yet. The reviewing agent writes one with finish_review: what each function does, the processes this change touches, and its business rules. diffninja never writes it itself.</p>`;
  }
  const functions = new Map((report.functions ?? []).map((fn) => [fn.id, fn]));
  const purposes = purposesOf(report);
  const ranks = new Map(report.items.map((item, index) => [item.id, index + 1]));
  const itemFiles = new Map(report.items.map((item) => [item.id, item.file]));
  const { processes, rules } = explanation;
  const context: RenderContext = { functions, purposes, ranks, itemFiles, hunkHref: options.hunkHref, stepsOpen: options.stepsOpen !== false };
  const parts = [
    '<div class="bp">',
    '<div class="bp-head">',
    options.attribution === false
      ? ""
      : `<p class="bp-by">Explained by ${escapeHtml(explanation.explainedBy)} from the code: its reading of what the change does, not a verdict.</p>`,
    renderLegend(),
    "</div>",
  ].filter((part) => part !== "");
  processes.forEach((process, index) => parts.push(renderProcess(process, index + 1, context)));
  if (rules.length > 0) parts.push(renderRules(rules, context));
  if (options.glossary !== false) parts.push(renderGlossary(report.functions ?? [], purposes));
  parts.push("</div>");
  return parts.join("\n");
}

interface RenderContext {
  readonly functions: ReadonlyMap<string, ExplainedFunction>;
  readonly purposes: ReadonlyMap<string, string>;
  readonly ranks: ReadonlyMap<string, number>;
  readonly itemFiles: ReadonlyMap<string, string>;
  readonly hunkHref?: (itemId: string) => string | undefined;
  readonly stepsOpen: boolean;
}

function renderLegend(): string {
  const chip = (change: ExplanationChange, word: string) =>
    `<span class="bp-legend-item"><span class="bp-swatch bp-swatch-${change}" aria-hidden="true"></span>${word}</span>`;
  return [
    '<p class="bp-legend" aria-label="Legend">',
    chip("added", "New in this change"),
    chip("changed", "Changed"),
    chip("removed", "Removed"),
    chip("unchanged", "Unchanged, for context"),
    "</p>",
  ].join("");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function processTally(process: BusinessProcess): string {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const step of process.steps) if (step.change !== "unchanged") counts[step.change] += 1;
  const parts = [
    counts.added > 0 ? `${counts.added} new` : "",
    counts.changed > 0 ? `${counts.changed} changed` : "",
    counts.removed > 0 ? `${counts.removed} removed` : "",
  ].filter((part) => part !== "");
  return `${plural(process.steps.length, "step")}${parts.length > 0 ? ` · ${parts.join(", ")}` : " · none changed"}`;
}

function renderProcess(process: BusinessProcess, at: number, context: RenderContext): string {
  const layout = layoutProcess(process);
  return [
    `<section class="bp-process" id="bp-process-${at}" aria-labelledby="bp-process-${at}-title">`,
    '<header class="bp-process-head">',
    `<h3 class="bp-process-title" id="bp-process-${at}-title">${escapeHtml(process.title)}</h3>`,
    `<p class="bp-process-tally">${escapeHtml(processTally(process))}</p>`,
    "</header>",
    '<div class="bp-chart-wrap">',
    renderChart(process, layout, at),
    "</div>",
    renderStepList(process, at, context),
    "</section>",
  ].join("\n");
}

interface StepBox {
  readonly step: ProcessStep;
  readonly index: number;
  readonly lines: string[];
  readonly layer: number;
  x: number;
  y: number;
  readonly width: number;
  readonly height: number;
}

interface ChartEdge {
  readonly from: StepBox;
  readonly to: StepBox;
  when?: string;
  /** adjacent: next layer down; lane-right: a skip down the right side; lane-left: a loop back up the left side. */
  readonly route: "adjacent" | "lane-right" | "lane-left";
  /** Lane number within its side, 0 nearest the chart. */
  readonly lane: number;
  /** This exit's place along its step's bottom edge, left to right by where it heads. */
  slot: number;
  slots: number;
}

export interface ProcessLayout {
  readonly boxes: StepBox[];
  readonly edges: ChartEdge[];
  /** Top and bottom of each layer's row, so edges can run in the gaps between rows. */
  readonly rows: ReadonlyMap<number, { readonly top: number; readonly bottom: number }>;
  /** Where the right and left lanes start: just outside the widest row. */
  readonly rightEdge: number;
  readonly leftEdge: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Layered top-to-bottom layout. A step sits one layer below the lowest step
 * that leads forward into it (forward means later in the list), so branches of
 * a decision sit side by side and rejoin below, in the order the decision lists
 * them. Every arrow leaves a box through its bottom and enters one through its
 * top, and between them it only runs through the gaps between rows and the
 * lanes beside the chart: an exit to the next row is an elbow in the gap, one
 * that skips rows runs down a lane on the right, and one that goes back to an
 * earlier step (a retry) runs up a lane on the left. No arrow crosses a box.
 */
export function layoutProcess(process: BusinessProcess): ProcessLayout {
  const steps = process.steps;
  const index = new Map(steps.map((step, at) => [step.id, at]));
  const exits = exitsOf(process);
  const layers: number[] = steps.map(() => -1);
  steps.forEach((step, at) => {
    if (layers[at] < 0) layers[at] = at === 0 ? 0 : layers[at - 1] + 1;
    for (const exit of exits.get(step.id) ?? []) {
      const target = index.get(exit.to)!;
      if (target > at) layers[target] = Math.max(layers[target], layers[at] + 1);
    }
  });
  const boxes: StepBox[] = steps.map((step, at) => {
    const lines = wrapWords(step.text, step.kind === "decision" ? DECISION_WRAP_CHARS : WRAP_CHARS);
    return {
      step,
      index: at,
      lines,
      layer: layers[at],
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_PAD_Y * 2 + TAG_ROW + lines.length * LINE_HEIGHT,
    };
  });
  const byLayer = new Map<number, StepBox[]>();
  for (const box of boxes) {
    const row = byLayer.get(box.layer) ?? [];
    row.push(box);
    byLayer.set(box.layer, row);
  }
  const layerIds = [...byLayer.keys()].sort((a, b) => a - b);

  // Within a row, a step follows the step above that leads into it, in that
  // step's own exit order, so a decision's first exit sits on the left.
  const place = new Map<StepBox, number>();
  for (const layer of layerIds) {
    const row = byLayer.get(layer)!;
    const key = (box: StepBox): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const parent of boxes) {
        if (parent.layer !== layer - 1) continue;
        (exits.get(parent.step.id) ?? []).forEach((exit, at) => {
          if (exit.to === box.step.id) best = Math.min(best, (place.get(parent) ?? 0) * 100 + at);
        });
      }
      return best;
    };
    const keys = new Map(row.map((box) => [box, key(box)]));
    row.sort((a, b) => keys.get(a)! - keys.get(b)! || a.index - b.index);
    row.forEach((box, at) => place.set(box, at));
  }

  const edges: ChartEdge[] = [];
  let rightLanes = 0;
  let leftLanes = 0;
  for (const box of boxes) {
    for (const exit of exits.get(box.step.id) ?? []) {
      const target = boxes[index.get(exit.to)!];
      const route = target.index <= box.index || target.layer <= box.layer
        ? ("lane-left" as const)
        : target.layer === box.layer + 1 ? ("adjacent" as const) : ("lane-right" as const);
      const lane = route === "lane-right" ? rightLanes++ : route === "lane-left" ? leftLanes++ : 0;
      const edge: ChartEdge = { from: box, to: target, route, lane, slot: 0, slots: 1 };
      if (exit.when !== undefined) edge.when = exit.when;
      edges.push(edge);
    }
  }

  const rowWidth = (row: StepBox[]) => row.length * NODE_WIDTH + (row.length - 1) * COLUMN_GAP;
  const core = Math.max(...layerIds.map((layer) => rowWidth(byLayer.get(layer)!)));
  const leftSpace = leftLanes === 0 ? 0 : leftLanes * LANE_GAP + 14;
  const rightSpace = rightLanes === 0 ? 0 : rightLanes * LANE_GAP + 14;
  const rows = new Map<number, { top: number; bottom: number }>();
  let top = CHART_PAD;
  for (const layer of layerIds) {
    const row = byLayer.get(layer)!;
    const height = Math.max(...row.map((box) => box.height));
    let x = CHART_PAD + leftSpace + (core - rowWidth(row)) / 2;
    for (const box of row) {
      box.x = Math.round(x);
      box.y = Math.round(top + (height - box.height) / 2);
      x += NODE_WIDTH + COLUMN_GAP;
    }
    rows.set(layer, { top: Math.round(top), bottom: Math.round(top + height) });
    top += height + LAYER_GAP;
  }

  // Exits leave a box's bottom left to right in the direction each one heads,
  // so no two of them cross on the way out.
  const heading = (edge: ChartEdge): number =>
    edge.route === "lane-left" ? -1e6 - edge.lane : edge.route === "lane-right" ? 1e6 + edge.lane : edge.to.x;
  for (const box of boxes) {
    const out = edges.filter((edge) => edge.from === box).sort((a, b) => heading(a) - heading(b));
    out.forEach((edge, at) => {
      edge.slot = at;
      edge.slots = out.length;
    });
  }
  return {
    boxes,
    edges,
    rows,
    leftEdge: CHART_PAD + leftSpace,
    rightEdge: CHART_PAD + leftSpace + core,
    width: Math.round(CHART_PAD * 2 + leftSpace + core + rightSpace),
    height: Math.round(top - LAYER_GAP + CHART_PAD),
  };
}

function stepOutline(box: StepBox): string {
  const { x, y, width, height } = box;
  if (box.step.kind === "decision") {
    const inset = DECISION_INSET;
    const mid = y + height / 2;
    return `<path class="bp-shape" d="M${x + inset} ${y} H${x + width - inset} L${x + width} ${mid} L${x + width - inset} ${y + height} H${x + inset} L${x} ${mid} Z"></path>`;
  }
  const radius = box.step.kind === "start" || box.step.kind === "end" ? Math.min(height / 2, 22) : 8;
  return `<rect class="bp-shape" x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"></rect>`;
}

function kindWord(step: ProcessStep): string {
  if (step.kind === "start") return "Starts";
  if (step.kind === "decision") return "Decision";
  if (step.kind === "end") return "Outcome";
  return "Step";
}

function renderNode(box: StepBox, at: number): string {
  const step = box.step;
  const number = box.index + 1;
  const tag = CHANGE_WORD[step.change];
  const center = box.x + box.width / 2;
  const head = `${number} · ${kindWord(step)}${tag === "" ? "" : ` · ${tag}`}`;
  const lines = box.lines
    .map((line, index) =>
      `<text class="bp-text" x="${center}" y="${box.y + NODE_PAD_Y + TAG_ROW + 13 + index * LINE_HEIGHT}" text-anchor="middle">${escapeHtml(line)}</text>`)
    .join("");
  const title = [
    `${number}. ${step.text}`,
    CHANGE_SENTENCE[step.change],
    step.detail ?? "",
    step.before === undefined ? "" : `Before: ${step.before}`,
  ].filter((part) => part !== "").join(" · ");
  return [
    `<a class="bp-node bp-kind-${step.kind} bp-${step.change}" href="#bp-p${at}-s${number}">`,
    `<title>${escapeHtml(title)}</title>`,
    stepOutline(box),
    `<text class="bp-tag" x="${center}" y="${box.y + NODE_PAD_Y + 10}" text-anchor="middle">${escapeHtml(head.toUpperCase())}</text>`,
    lines,
    "</a>",
  ].join("");
}

function edgeLabel(x: number, y: number, text: string, anchor: "start" | "middle" | "end"): string {
  const width = Math.round(text.length * 6.6 + 10);
  const left = anchor === "start" ? x - 4 : anchor === "end" ? x - width + 4 : x - width / 2;
  return [
    `<rect class="bp-when-bg" x="${Math.round(left)}" y="${y - 11}" width="${width}" height="16" rx="8"></rect>`,
    `<text class="bp-when" x="${Math.round(left + width / 2)}" y="${y + 1}" text-anchor="middle">${escapeHtml(text)}</text>`,
  ].join("");
}

function renderEdge(edge: ChartEdge, layout: ProcessLayout, marker: string): string {
  const { from, to } = edge;
  const classes = `bp-edge${to.step.change === "unchanged" && from.step.change === "unchanged" ? "" : " bp-edge-changed"}`;
  const end = ` marker-end="url(#${marker})"`;
  const spread = edge.slots <= 1 ? 0 : (edge.slot - (edge.slots - 1) / 2) * Math.min(70, (from.width - 60) / (edge.slots - 1));
  const x1 = Math.round(from.x + from.width / 2 + spread);
  const y1 = from.y + from.height;
  const below = layout.rows.get(from.layer)!.bottom;
  const above = layout.rows.get(to.layer)!.top;
  const y2 = to.y - 2;
  const label = edge.when === undefined ? "" : edgeLabel(x1 + 5, below + 15, edge.when, "start");
  if (edge.route === "adjacent") {
    const x2 = Math.round(to.x + to.width / 2);
    const mid = below + GAP_TURN;
    const path = x1 === x2 ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} V${mid} H${x2} V${y2}`;
    return `<path class="${classes}" d="${path}"${end}></path>${label}`;
  }
  // A lane edge crosses the gap under its source, runs down (or back up) its
  // lane, and crosses the gap over its target, each at its own height so two
  // lane edges in one gap stay apart.
  const depart = below + GAP_DEPART + (edge.lane % 2) * 7;
  const arrive = above - GAP_ARRIVE - (edge.lane % 2) * 7;
  const right = edge.route === "lane-right";
  const lane = right ? layout.rightEdge + 14 + edge.lane * LANE_GAP : layout.leftEdge - 14 - edge.lane * LANE_GAP;
  const x2 = Math.round(to.x + to.width / 2 + (right ? 22 : -22));
  const back = right ? "" : " bp-edge-back";
  return `<path class="${classes}${back}" d="M${x1} ${y1} V${depart} H${lane} V${arrive} H${x2} V${y2}"${end}></path>${label}`;
}

function renderChart(process: BusinessProcess, layout: ProcessLayout, at: number): string {
  const marker = `bp-arrow-${at}`;
  return [
    `<svg class="bp-chart" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${escapeHtml(`Flowchart of ${process.title}; the numbered list below describes each step.`)}">`,
    "<defs>",
    `<marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="bp-arrow" d="M0 0 L10 5 L0 10 z"></path></marker>`,
    "</defs>",
    layout.edges.map((edge) => renderEdge(edge, layout, marker)).join(""),
    layout.boxes.map((box) => renderNode(box, at)).join(""),
    "</svg>",
  ].join("");
}

/** The functions that carry a step out: purpose first, the code's own name under it. */
function renderDoneBy(ids: readonly string[], context: RenderContext): string {
  const entries = ids.map((id) => {
    const fn = context.functions.get(id);
    const purpose = context.purposes.get(id);
    const name = fn === undefined ? id : `${fn.name} · ${fn.file}:${fn.line}`;
    return [
      '<li class="bp-fn">',
      purpose === undefined ? "" : `<span class="bp-fn-purpose">${escapeHtml(purpose)}</span>`,
      `<span class="bp-fn-name mono">${escapeHtml(name)}</span>`,
      "</li>",
    ].join("");
  });
  return `<div class="bp-done-by"><span class="bp-label">Done by</span><ul class="bp-fns">${entries.join("")}</ul></div>`;
}

function renderHunkLinks(hunks: readonly string[], context: RenderContext): string {
  const links = hunks.map((id) => {
    const rank = context.ranks.get(id);
    const file = context.itemFiles.get(id) ?? "";
    const label = rank === undefined ? id : `#${rank} ${file}`;
    const href = context.hunkHref?.(id);
    return href === undefined
      ? `<span class="bp-hunk mono">${escapeHtml(label)}</span>`
      : `<a class="bp-hunk mono" data-open-hunk href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  return `<p class="bp-hunks"><span class="bp-label">In the diff</span>${links.join("")}</p>`;
}

function renderStepList(process: BusinessProcess, at: number, context: RenderContext): string {
  const index = new Map(process.steps.map((step, position) => [step.id, position + 1]));
  const exits = exitsOf(process);
  const items = process.steps.map((step, position) => {
    const number = position + 1;
    const tag = CHANGE_WORD[step.change];
    const out = exits.get(step.id) ?? [];
    const next = step.kind === "decision" || out.length > 1
      ? out.map((exit) => `${exit.when === undefined ? "" : `${exit.when}: `}go to ${index.get(exit.to)}`).join("; ")
      : out.length === 1 && index.get(out[0].to) !== number + 1 ? `Then go to ${index.get(out[0].to)}` : "";
    return [
      `<li class="bp-step bp-${step.change}" id="bp-p${at}-s${number}" value="${number}">`,
      '<p class="bp-step-line">',
      tag === "" ? "" : `<span class="bp-chip bp-chip-${step.change}">${tag}</span>`,
      step.kind === "decision" ? '<span class="bp-chip bp-chip-kind">Decision</span>' : "",
      `<span class="bp-step-text">${escapeHtml(step.text)}</span>`,
      "</p>",
      step.detail === undefined ? "" : `<p class="bp-detail">${escapeHtml(step.detail)}</p>`,
      step.before === undefined ? "" : `<p class="bp-before"><span class="bp-label">Before</span>${escapeHtml(step.before)}</p>`,
      next === "" ? "" : `<p class="bp-next">${escapeHtml(next)}</p>`,
      step.functions === undefined ? "" : renderDoneBy(step.functions, context),
      step.hunks === undefined ? "" : renderHunkLinks(step.hunks, context),
      "</li>",
    ].filter((part) => part !== "").join("");
  });
  return [
    `<details class="bp-steps-box"${context.stepsOpen ? " open" : ""}>`,
    `<summary class="bp-steps-sum">Step by step: the rules, what changed, and the code behind each step</summary>`,
    `<ol class="bp-steps" aria-label="${escapeHtml(`Steps of ${process.title}`)}">${items.join("")}</ol>`,
    "</details>",
  ].join("");
}

function renderRules(rules: readonly BusinessRule[], context: RenderContext): string {
  const items = rules.map((rule) => {
    const tag = CHANGE_WORD[rule.change];
    return [
      `<li class="bp-rule bp-${rule.change}">`,
      '<p class="bp-rule-line">',
      tag === "" ? '<span class="bp-chip bp-chip-unchanged">Kept</span>' : `<span class="bp-chip bp-chip-${rule.change}">${tag}</span>`,
      `<span class="bp-rule-text">${escapeHtml(rule.text)}</span>`,
      "</p>",
      rule.before === undefined ? "" : `<p class="bp-before"><span class="bp-label">Before</span>${escapeHtml(rule.before)}</p>`,
      rule.hunks === undefined ? "" : renderHunkLinks(rule.hunks, context),
      "</li>",
    ].filter((part) => part !== "").join("");
  });
  return [
    '<section class="bp-rules" aria-labelledby="bp-rules-title">',
    '<h3 class="bp-section-title" id="bp-rules-title">Business rules</h3>',
    `<ul class="bp-rule-list">${items.join("")}</ul>`,
    "</section>",
  ].join("\n");
}

function renderGlossary(functions: readonly ExplainedFunction[], purposes: ReadonlyMap<string, string>): string {
  if (functions.length === 0) return "";
  const row = (fn: ExplainedFunction) => [
    "<li class=\"bp-gloss-item\">",
    `<span class="bp-fn-purpose">${escapeHtml(purposes.get(fn.id) ?? "No purpose given.")}</span>`,
    `<span class="bp-fn-name mono">${escapeHtml(`${fn.name} · ${fn.file}:${fn.line}`)}</span>`,
    "</li>",
  ].join("");
  const product = functions.filter((fn) => !fn.inTests);
  const tests = functions.filter((fn) => fn.inTests);
  return [
    '<details class="bp-glossary">',
    `<summary class="bp-section-title">What each function does (${functions.length})</summary>`,
    product.length === 0 ? "" : `<ul class="bp-gloss">${product.map(row).join("")}</ul>`,
    tests.length === 0 ? "" : `<p class="bp-gloss-head">In tests</p><ul class="bp-gloss">${tests.map(row).join("")}</ul>`,
    "</details>",
  ].filter((part) => part !== "").join("\n");
}

/**
 * Styles for the business view. They use the host page's color tokens with
 * fallbacks, so the report page and the pull request drawer both draw it in
 * their own palette, light and dark.
 */
export const BUSINESS_STYLES = `
.bp { --bp-add: var(--add-ink, var(--add, #1f7a3e)); --bp-add-bg: var(--add-bg, #e3f7e8);
  --bp-chg: var(--warn, #945f00); --bp-chg-bg: var(--warn-bg, #fcf1d6);
  --bp-del: var(--alarm, #c42032); --bp-del-bg: var(--alarm-bg, #fde8ea);
  --bp-edge: var(--line-strong, #a9b0c8);
  display: flex; flex-direction: column; gap: 22px; margin-top: 14px; font-family: var(--sans); }
.bp-head { display: flex; flex-direction: column; gap: 8px; }
.bp-by, .bp-note { font-size: 13.5px; color: var(--ink-soft); max-width: 90ch; }
.bp-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--ink-soft); }
.bp-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.bp-swatch { width: 14px; height: 10px; border-radius: 3px; border: 1.5px solid var(--bp-edge); background: var(--panel, transparent); }
.bp-swatch-added { border-color: var(--bp-add); background: var(--bp-add-bg); }
.bp-swatch-changed { border-color: var(--bp-chg); background: var(--bp-chg-bg); }
.bp-swatch-removed { border-color: var(--bp-del); border-style: dashed; background: var(--bp-del-bg); }
.bp-process { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel, transparent); }
.bp-process-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; }
.bp-process-title { font-size: 18px; font-weight: 650; }
.bp-process-tally { font-size: 13px; color: var(--ink-soft); }
.bp-chart-wrap { overflow-x: auto; overscroll-behavior-x: contain; padding: 4px 0; }
.bp-chart { display: block; margin: 0 auto; max-width: none; font-family: var(--sans); }
.bp-node { cursor: pointer; }
.bp-node .bp-shape { fill: var(--panel, #fff); stroke: var(--bp-edge); stroke-width: 1.5; }
.bp-node:hover .bp-shape, .bp-node:focus .bp-shape { stroke: var(--cursor, var(--accent)); }
.bp-node:focus { outline: none; }
.bp-node:focus-visible .bp-shape { stroke-width: 3; }
.bp-kind-start .bp-shape, .bp-kind-end .bp-shape { fill: var(--sunken, #f6f8fa); }
.bp-node.bp-added .bp-shape { fill: var(--bp-add-bg); stroke: var(--bp-add); stroke-width: 2.2; }
.bp-node.bp-changed .bp-shape { fill: var(--bp-chg-bg); stroke: var(--bp-chg); stroke-width: 2.2; }
.bp-node.bp-removed .bp-shape { fill: var(--bp-del-bg); stroke: var(--bp-del); stroke-width: 2; stroke-dasharray: 6 4; }
.bp-text { fill: var(--ink); font-size: 13.5px; font-weight: 550; }
.bp-node.bp-removed .bp-text { text-decoration: line-through; fill: var(--ink-soft); }
.bp-tag { fill: var(--ink-soft); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; }
.bp-node.bp-added .bp-tag { fill: var(--bp-add); }
.bp-node.bp-changed .bp-tag { fill: var(--bp-chg); }
.bp-node.bp-removed .bp-tag { fill: var(--bp-del); }
.bp-edge { fill: none; stroke: var(--bp-edge); stroke-width: 1.6; }
.bp-edge-changed { stroke: var(--ink-soft); }
.bp-edge-back { stroke-dasharray: 5 4; }
.bp-arrow { fill: var(--ink-soft); }
.bp-when-bg { fill: var(--bg, #fff); stroke: var(--line); }
.bp-when { fill: var(--ink); font-size: 11px; font-weight: 650; }
.bp-steps-sum { cursor: pointer; font-size: 13.5px; font-weight: 600; color: var(--ink-soft); width: fit-content; }
.bp-steps-box[open] > .bp-steps-sum { margin-bottom: 10px; }
.bp-steps { margin: 0; padding-left: 28px; display: flex; flex-direction: column; gap: 10px; }
.bp-step { padding: 2px 0 2px 4px; scroll-margin-top: 80px; }
.bp-step::marker { color: var(--ink-soft); font-weight: 650; }
.bp-step:target { background: var(--sunken); border-radius: 6px; }
.bp-step-line, .bp-rule-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 14.5px; font-weight: 550; }
.bp-step.bp-removed .bp-step-text, .bp-rule.bp-removed .bp-rule-text { text-decoration: line-through; color: var(--ink-soft); }
.bp-detail, .bp-next { margin-top: 3px; font-size: 13.5px; color: var(--ink-soft); max-width: 90ch; }
.bp-before { margin-top: 3px; font-size: 13.5px; color: var(--ink-soft); display: flex; gap: 8px; align-items: baseline; }
.bp-label { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin-right: 8px; }
.bp-chip { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink-soft); }
.bp-chip-added { color: var(--bp-add); border-color: var(--bp-add); background: var(--bp-add-bg); }
.bp-chip-changed { color: var(--bp-chg); border-color: var(--bp-chg); background: var(--bp-chg-bg); }
.bp-chip-removed { color: var(--bp-del); border-color: var(--bp-del); background: var(--bp-del-bg); }
.bp-done-by { margin-top: 6px; display: flex; gap: 8px; align-items: baseline; }
.bp-fns, .bp-gloss { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.bp-fn, .bp-gloss-item { display: flex; flex-direction: column; gap: 1px; }
.bp-fn-purpose { font-size: 13.5px; color: var(--ink); }
.bp-fn-name { font-size: 11.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.bp-hunks { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; }
.bp-hunk { padding: 1px 7px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink-soft); text-decoration: none; overflow-wrap: anywhere; }
a.bp-hunk:hover { border-color: var(--cursor, var(--accent)); color: var(--ink); }
.bp-rules { display: flex; flex-direction: column; gap: 10px; }
.bp-section-title { font-size: 15px; font-weight: 650; }
.bp-rule-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.bp-rule { padding: 10px 12px; border: 1px solid var(--line); border-left-width: 3px; border-radius: 8px; }
.bp-rule.bp-added { border-left-color: var(--bp-add); }
.bp-rule.bp-changed { border-left-color: var(--bp-chg); }
.bp-rule.bp-removed { border-left-color: var(--bp-del); }
.bp-glossary > summary { cursor: pointer; }
.bp-glossary[open] > summary { margin-bottom: 10px; }
.bp-gloss-head { margin: 14px 0 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
@media (max-width: 640px) {
  .bp-process { padding: 12px; }
  .bp-steps { padding-left: 22px; }
  .bp-done-by, .bp-before { flex-direction: column; gap: 2px; }
}
`;
