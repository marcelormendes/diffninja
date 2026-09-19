/**
 * Serialization of engine diff trees into the report's bounded per-file call
 * flows. Everything here is a pure function of engine `DiffNode` results: the
 * ASCII renderings stay untouched for the judgment context, and the structured
 * trees are never parsed back out of that text.
 */

import type { DiffNode, DiffTreeResult } from "../types.js";
import type { DefinitionDetail } from "./source.js";
import type { CallFlowFile, CallFlowNode, CallFlowStatus, ReviewItem, ReviewUnit } from "./types.js";

/**
 * Bounds per changed file. They exist so one huge file cannot push an unbounded
 * report into the HTML, and every bound that drops content sets
 * `CallFlowFile.truncated`.
 */
export const CALL_FLOW_MAX_ROOTS = 8;
/** Edges below a root. The engine already stops expanding at the same depth. */
export const CALL_FLOW_MAX_DEPTH = 4;
export const CALL_FLOW_MAX_CHILDREN = 8;
/**
 * Extra children allowed per node beyond {@link CALL_FLOW_MAX_CHILDREN} when the
 * callee is defined in another file. Without it a wide call graph drops exactly
 * the calls a reader cannot see in the file under review.
 */
export const CALL_FLOW_MAX_CROSS_FILE_CHILDREN = 8;
export const CALL_FLOW_MAX_NODES = 160;

/**
 * Definition source and prose for one node, supplied by the review service so
 * this module stays a pure function of the engine result plus that lookup. It is
 * only called for nodes that survive the bounds.
 */
export type CallFlowNodeDetail = (node: DiffNode) => DefinitionDetail;

/**
 * Files with actual text hunks. Units parsed from `diff --git` metadata (mode,
 * rename, binary) carry a `File metadata` header and no hunk, so they never get
 * a call-flow entry.
 */
function textHunkFiles(units: readonly ReviewUnit[]): Set<string> {
  const files = new Set<string>();
  for (const unit of units) {
    if (unit.header.startsWith("@@")) files.add(unit.file);
  }
  return files;
}

/** Distinct changed-hunk files in report rank order; metadata-only files are excluded. */
export function reportOrderedTextHunkFiles(
  items: readonly ReviewItem[],
  units: readonly ReviewUnit[],
): string[] {
  const withHunks = textHunkFiles(units);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!withHunks.has(item.file) || seen.has(item.file)) continue;
    seen.add(item.file);
    ordered.push(item.file);
  }
  return ordered;
}

/**
 * Whether tree `node` is defined in `file`, calls into it anywhere below, or is
 * a call the engine resolved to a definition in it. A caller several frames up
 * is exactly the reach the report has to make visible, and a callee defined in
 * `file` is a call this file's reader cannot see at all.
 */
export function treeTouchesFile(node: DiffNode, file: string): boolean {
  if (node.file === file || node.definition?.file === file) return true;
  return node.children.some(child => treeTouchesFile(child, file));
}

/** One file's view of one engine tree: which nodes lead to that file. */
interface FileView {
  relevant: Map<DiffNode, boolean>;
}

/** One file's remaining node budget, shared by every tree serialized for it. */
interface SerializeBudget {
  remaining: number;
  truncated: boolean;
}

/** Bottom-up file relevance, used to prioritize branches within pruning bounds. */
function relevantNodes(root: DiffNode, file: string): Map<DiffNode, boolean> {
  const relevant = new Map<DiffNode, boolean>();
  const visit = (node: DiffNode): boolean => {
    let childHit = false;
    for (const child of node.children) {
      if (visit(child)) childHit = true;
    }
    const hit = node.file === file || node.definition?.file === file || childHit;
    relevant.set(node, hit);
    return hit;
  };
  visit(root);
  return relevant;
}

/**
 * Derive report statuses bottom-up. The engine's `same`/`added`/`removed` says
 * nothing about a caller whose own definition is unchanged but whose callee
 * changed, so a `same` node with any changed descendant becomes `changed`.
 * Children are visited before the parent, and this runs on the whole engine
 * tree, so a branch a later bound drops still leaves its ancestors marked.
 */
function deriveStatuses(
  node: DiffNode,
  derived: Map<DiffNode, CallFlowStatus>,
): CallFlowStatus {
  let changedChild = false;
  for (const child of node.children) {
    if (deriveStatuses(child, derived) !== "same") changedChild = true;
  }
  const status: CallFlowStatus =
    node.status !== "same" ? node.status : changedChild ? "changed" : "same";
  derived.set(node, status);
  return status;
}

/**
 * Priority for one child within its file's view, lowest first. Branches that
 * reach the file outrank branches that do not, and a changed branch outranks an
 * unchanged one, so a bounded file keeps what the diff actually moved.
 */
function childPriority(
  child: DiffNode,
  view: FileView,
  derived: Map<DiffNode, CallFlowStatus>,
): number {
  const changed = derived.get(child) !== "same";
  const relevant = view.relevant.get(child) === true;
  if (relevant) return changed ? 0 : 1;
  return changed ? 2 : 3;
}

/**
 * Children to serialize under `node`, in source order.
 *
 * Retain caller and callee context across files. When the breadth bound cuts
 * children, paths reaching this file and changed branches win the budget, and a
 * callee defined in another file gets a second allowance on top of the regular
 * one: that call is the reach the reader cannot see in this file at all.
 * Survivors keep source order; scoping must not silently hide downstream calls.
 */
function visibleChildren(
  node: DiffNode,
  view: FileView,
  derived: Map<DiffNode, CallFlowStatus>,
  budget: SerializeBudget,
): DiffNode[] {
  const candidates = node.children;
  if (candidates.length <= CALL_FLOW_MAX_CHILDREN) return candidates;
  const ranked = [...candidates].sort(
    (left, right) => childPriority(left, view, derived) - childPriority(right, view, derived),
  );
  const kept = new Set(ranked.slice(0, CALL_FLOW_MAX_CHILDREN));
  const callerFile = node.definition?.file ?? node.file;
  let extra = 0;
  for (const child of ranked.slice(CALL_FLOW_MAX_CHILDREN)) {
    if (extra >= CALL_FLOW_MAX_CROSS_FILE_CHILDREN) break;
    const calleeFile = child.definition?.file;
    if (calleeFile === undefined || calleeFile === callerFile) continue;
    kept.add(child);
    extra += 1;
  }
  // Only a call that actually left the report is a truncation: the extra
  // allowance can cover a wide node completely, and claiming a cut that never
  // happened would make the flag mean nothing.
  if (kept.size < candidates.length) budget.truncated = true;
  return candidates.filter(child => kept.has(child));
}

function serializeNode(
  node: DiffNode,
  depth: number,
  view: FileView,
  derived: Map<DiffNode, CallFlowStatus>,
  budget: SerializeBudget,
  detail?: CallFlowNodeDetail,
): CallFlowNode | null {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return null;
  }
  budget.remaining -= 1;
  const children: CallFlowNode[] = [];
  if (depth >= CALL_FLOW_MAX_DEPTH) {
    if (node.children.length > 0) budget.truncated = true;
  } else if (node.children.length > 0) {
    const visible = visibleChildren(node, view, derived, budget);
    // Spend the shared budget on relevant changes first, then restore source
    // order. Otherwise a wide early sibling can hide a late changed call.
    const ranked = [...visible].sort(
      (left, right) => childPriority(left, view, derived) - childPriority(right, view, derived),
    );
    const serializedChildren = new Map<DiffNode, CallFlowNode>();
    for (const child of ranked) {
      const childNode = serializeNode(child, depth + 1, view, derived, budget, detail);
      if (childNode === null) break;
      serializedChildren.set(child, childNode);
    }
    for (const child of visible) {
      const childNode = serializedChildren.get(child);
      if (childNode) children.push(childNode);
    }
  }
  // SAFETY: deriveStatuses walked this tree before serialization, so every
  // visited node has an entry; the fallback only satisfies the Map's type.
  const serialized: CallFlowNode = {
    key: node.key,
    label: node.label,
    status: derived.get(node) ?? "same",
    children,
  };
  if (node.file !== undefined) serialized.file = node.file;
  if (node.line !== undefined) serialized.line = node.line;
  if (node.endLine !== undefined) serialized.endLine = node.endLine;
  const resolved = detail?.(node);
  if (resolved?.description !== undefined) serialized.description = resolved.description;
  if (resolved?.source !== undefined) serialized.source = resolved.source;
  return serialized;
}

function buildCallFlowFile(
  file: string,
  trees: readonly DiffTreeResult[],
  detail?: CallFlowNodeDetail,
): CallFlowFile {
  const budget: SerializeBudget = { remaining: CALL_FLOW_MAX_NODES, truncated: false };
  const roots: CallFlowNode[] = [];
  const seen = new Set<string>();
  for (const tree of trees) {
    if (!treeTouchesFile(tree.tree, file)) continue;
    // A definition has one diff in a snapshot pair. Deduplicate roots without
    // serializing their potentially large subtrees just to compare identity.
    const signature = JSON.stringify([tree.tree.key, tree.tree.file, tree.tree.line, tree.tree.status]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (roots.length >= CALL_FLOW_MAX_ROOTS) {
      budget.truncated = true;
      break;
    }
    const derived = new Map<DiffNode, CallFlowStatus>();
    deriveStatuses(tree.tree, derived);
    const view: FileView = { relevant: relevantNodes(tree.tree, file) };
    const root = serializeNode(tree.tree, 0, view, derived, budget, detail);
    if (root === null) break;
    roots.push(root);
  }
  return { file, trees: roots, truncated: budget.truncated };
}

/**
 * One bounded entry per file with actual text hunks that at least one tree
 * reaches, in the order given. Files no tree reaches are omitted rather than
 * reported as an empty tree. `detail` adds definition source and prose; without
 * it the trees carry structure only.
 */
export function buildCallFlows(
  files: readonly string[],
  trees: readonly DiffTreeResult[],
  detail?: CallFlowNodeDetail,
): CallFlowFile[] {
  const entries: CallFlowFile[] = [];
  for (const file of files) {
    const entry = buildCallFlowFile(file, trees, detail);
    if (entry.trees.length > 0) entries.push(entry);
  }
  return entries;
}
