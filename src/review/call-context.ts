import { buildCallSitesFromInfo } from "../calltree.js";
import { allFunctions, type FunctionIndex } from "../extract.js";
import { formatSourceLoc } from "../loc.js";
import type { CallNode, FunctionInfo, SourceLoc } from "../types.js";
import { CALL_FLOW_MAX_DEPTH } from "./call-flow.js";
import type { ReviewUnit } from "./types.js";

type SnapshotSide = "before" | "after";

interface Definition {
  info: FunctionInfo;
  outgoing: Edge[];
  incoming: Edge[];
}

interface Edge {
  node: CallNode;
  owner: Definition;
  target?: Definition;
}

interface ContextGraph {
  definitions: Definition[];
  edges: Edge[];
}

interface SelectedEdge {
  edge: Edge;
  side: SnapshotSide;
  distance: number;
  priority: number;
  repeated: boolean;
}

function locationKey(loc: SourceLoc): string {
  return `${loc.file}\0${loc.line}\0${loc.endLine ?? loc.line}`;
}

/** Expand each body once, rather than building the same descendant tree per caller. */
function contextGraph(index: FunctionIndex): ContextGraph {
  const definitions = allFunctions(index).map<Definition>(info => ({ info, outgoing: [], incoming: [] }));
  const locations = new Map<string, Definition | null>();
  for (const definition of definitions) {
    const { file, line, endLine } = definition.info;
    if (line === undefined) continue;
    const key = locationKey({ file, line, endLine });
    // Line-only engine locations cannot distinguish two definitions on one line.
    locations.set(key, locations.has(key) ? null : definition);
  }
  const edges: Edge[] = [];
  for (const owner of definitions) {
    for (const node of buildCallSitesFromInfo(owner.info, index)) {
      const target = node.definition ? locations.get(locationKey(node.definition)) ?? undefined : undefined;
      const edge = { node, owner, target };
      owner.outgoing.push(edge);
      target?.incoming.push(edge);
      edges.push(edge);
    }
  }
  return { definitions, edges };
}

/** Use changed lines, not the surrounding unchanged lines in a unified hunk. */
function changedLines(unit: ReviewUnit, side: SnapshotSide): number[] {
  let line = side === "before" ? unit.oldStart : unit.newStart;
  const changed: number[] = [];
  for (const text of unit.diff.split("\n").slice(1)) {
    const prefix = text[0];
    if (prefix === (side === "before" ? "-" : "+")) changed.push(line++);
    else if (prefix === " ") line++;
  }
  // An insertion/deletion still has a boundary on the other snapshot.
  return changed.length ? changed : [side === "before" ? unit.oldStart : unit.newStart];
}

function hunkDefinitions(graph: ContextGraph, unit: ReviewUnit, side: SnapshotSide): Definition[] {
  const inFile = graph.definitions.filter(({ info }) => info.file === unit.file && info.line !== undefined);
  const selected = new Set<Definition>();
  for (const line of changedLines(unit, side)) {
    const containing = inFile.filter(({ info }) => info.line! <= line && (info.endLine ?? info.line!) >= line);
    // A nested definition's hunk should not pull in all of its enclosing body's siblings.
    let smallest = Infinity;
    for (const { info } of containing) smallest = Math.min(smallest, info.end - info.start);
    for (const definition of containing) {
      if (definition.info.end - definition.info.start === smallest) selected.add(definition);
    }
  }
  return [...selected];
}

function location(node: { file?: string; line?: number; endLine?: number }): string {
  return node.file !== undefined && node.line !== undefined
    ? formatSourceLoc({ file: node.file, line: node.line, endLine: node.endLine })
    : "unavailable";
}

function renderEdge({ edge, side, repeated }: SelectedEdge): string {
  const { node, target } = edge;
  const context = node.context;
  const lines = [
    `call ${context?.callee ?? node.key} @ ${location(node)}`,
    `  snapshot=${side} target=${context?.target ?? "unresolved"}`,
    `  definition=${context?.parameters ?? "unavailable"}${node.definition ? ` @ ${location(node.definition)}` : ""}`,
    `  mapping=${context?.mapping ?? "unknown"}`,
  ];
  if (context?.arguments === undefined) lines.push("  arguments=unavailable");
  else if (context.arguments.length === 0) lines.push("  arguments=[]");
  else {
    for (const arg of context.arguments) {
      const cut = arg.truncated ? ` truncated=true originalLength=${arg.originalLength}` : "";
      lines.push(`  arg[${arg.position}] -> ${arg.parameter ?? "?"}: ${JSON.stringify(arg.expression)}${cut}`);
    }
  }
  if (context?.omittedArguments) lines.push(`  omitted arguments=${context.omittedArguments} reason=argument-limit`);
  if (repeated) lines.push("  omitted expansion=repeated-definition (distinct call site retained)");
  // Known bodies are expanded through the flat graph, not through this depth-one node.
  if (!target && context?.omittedChildren) lines.push(`  omitted children=${context.omittedChildren} reason=unavailable-expansion`);
  if (target && context?.omittedInlineChildren) lines.push(`  omitted children=${context.omittedInlineChildren} reason=inline-expansion-limit`);
  lines.push(`  completeness=${context?.completeness ?? "unavailable"} reason=${context?.reasons.join(",") || (context ? "none" : "unavailable-extraction")}`);
  return lines.join("\n");
}

function selectContext(graph: ContextGraph, unit: ReviewUnit, side: SnapshotSide) {
  const seeds = hunkDefinitions(graph, unit, side);
  if (seeds.length === 0) return { selected: [], omissions: [] };
  const lines = changedLines(unit, side);
  const seedSet = new Set(seeds);
  const selected = new Map<Edge, SelectedEdge>();
  // Outgoing descendants and incoming callers have separate visited sets. Walking
  // upstream must not expand unrelated sibling calls in the caller's body.
  for (const direction of ["outgoing", "incoming"] as const) {
    const seen = new Set(seeds);
    const queue = seeds.map(definition => ({ definition, distance: 0 }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { definition, distance } = queue[cursor];
      if (distance >= CALL_FLOW_MAX_DEPTH) continue;
      for (const edge of definition[direction]) {
        const next = direction === "outgoing" ? edge.target : edge.owner;
        const repeated = direction === "outgoing" && next !== undefined && seen.has(next) && next.outgoing.length > 0;
        const previous = selected.get(edge);
        if (!previous || previous.distance > distance + 1) {
          const atHunk = edge.node.file === unit.file && edge.node.line !== undefined &&
            lines.some(line => line >= edge.node.line! && line <= (edge.node.endLine ?? edge.node.line!));
          const priority = atHunk ? 0 : edge.target && seedSet.has(edge.target) ? 1 : distance + 2;
          selected.set(edge, { edge, side, distance: distance + 1, priority, repeated });
        } else if (repeated) previous.repeated = true;
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push({ definition: next, distance: distance + 1 });
        }
      }
    }
  }
  if (selected.size === 0) return { selected: [], omissions: [] };
  // Count omitted components separately from connected but distant/sibling edges.
  const connected = new Set(seeds);
  const queue = [...seeds];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const definition = queue[cursor];
    for (const edge of [...definition.outgoing, ...definition.incoming]) {
      const next = edge.owner === definition ? edge.target : edge.owner;
      if (next && !connected.has(next)) {
        connected.add(next);
        queue.push(next);
      }
    }
  }
  let unrelated = 0, distant = 0;
  for (const edge of graph.edges) {
    if (selected.has(edge)) continue;
    if (!connected.has(edge.owner)) unrelated++;
    else distant++;
  }
  const omissions: string[] = [];
  if (unrelated) omissions.push(`omitted call sites=${unrelated} snapshot=${side} reason=unrelated-to-hunk`);
  if (distant) omissions.push(`omitted call sites=${distant} snapshot=${side} reason=distant-descendants-or-siblings depth-limit=${CALL_FLOW_MAX_DEPTH}`);
  return { selected: [...selected.values()], omissions };
}

/** Standalone edges, adjacent to the hunk first, with snapshot-local bindings. */
export function buildCallContext(
  units: readonly ReviewUnit[],
  before: FunctionIndex,
  after: FunctionIndex,
): Map<string, string[]> {
  const beforeGraph = contextGraph(before), afterGraph = contextGraph(after);
  const result = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.special || !unit.header.startsWith("@@")) continue;
    const prior = selectContext(beforeGraph, unit, "before");
    const current = selectContext(afterGraph, unit, "after");
    // Keep both sides of an adjacent edge before any farther descendant.
    const selected = [...current.selected, ...prior.selected].sort((left, right) => left.priority - right.priority);
    const blocks = selected.map(renderEdge);
    const omissions = [...prior.omissions, ...current.omissions];
    if (omissions.length) blocks.push(omissions.join("\n"));
    if (blocks.length) result.set(unit.id, blocks);
  }
  return result;
}
