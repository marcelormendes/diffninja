import { buildCallSitesFromInfo } from "../calltree.js";
import { allContextDefinitions, type FunctionIndex } from "../extract.js";
import { resolveDispatchContext } from "../languages/typescript-dispatch.js";
import { resolveTypeContracts } from "../languages/typescript-contracts.js";
import { formatSourceLoc } from "../loc.js";
import type { CallNode, FunctionInfo, SourceLoc } from "../types.js";
import { CALL_FLOW_MAX_DEPTH } from "./call-flow.js";
import type { ReviewContextNode, ReviewUnit } from "./types.js";

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
  relation?: { kind: "event" | "queue" | "contract"; evidence: string };
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
  /**
   * Hunk definition the walk that selected this edge started from. Every walk
   * root is a hunk definition, so this is always a node, which is what keeps a
   * deep descendant or caller attached to the context it belongs to.
   */
  anchor: Definition;
  direction: "outgoing" | "incoming";
}

interface Selection {
  selected: SelectedEdge[];
  omissions: string[];
  /** Hunk definitions the selection started from, in the order they were found. */
  seeds: Definition[];
}

/**
 * Whole definition text for one snapshot, or `null` when the snapshot cannot
 * confirm a definition at that span. Supplied by the caller because reading a
 * snapshot belongs to the service, not to a pure selection function.
 */
export type ContextSourceReader = (definition: SourceLoc) => string | null;

/** Per-snapshot readers for the node source text; absent means none is read. */
export interface ContextSources {
  readonly before?: ContextSourceReader;
  readonly after?: ContextSourceReader;
}

/** Report blocks and addressable nodes for one hunk. */
export interface UnitContext {
  /** Report text in report order: both snapshots, the hunk-adjacent call first. */
  entries: string[];
  /** Structured context, highest retention priority first. */
  nodes: ReviewContextNode[];
}

/** One planned node and every selected edge that belongs to it. */
interface ContextNodePlan {
  definition: Definition;
  key: string;
  side: SnapshotSide;
  role: "changed-definition" | "caller" | "callee";
  /** Call sites written in this definition. */
  calls: SelectedEdge[];
  /** Call sites resolved to this definition, which are its callers. */
  reachedBy: SelectedEdge[];
  /** Selected call sites below this definition whose owner has no node of its own. */
  calleeReach: SelectedEdge[];
  /** Selected call sites above this definition whose owner has no node of its own. */
  callerReach: SelectedEdge[];
}

function locationKey(loc: SourceLoc): string {
  return `${loc.file}\0${loc.line}\0${loc.endLine ?? loc.line}`;
}

/** Expand each body once, rather than building the same descendant tree per caller. */
function contextGraph(index: FunctionIndex): ContextGraph {
  const infos = allContextDefinitions(index);
  const definitions = infos.map<Definition>(info => ({ info, outgoing: [], incoming: [] }));
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
    if (owner.info.review?.kind) continue;
    for (const node of buildCallSitesFromInfo(owner.info, index)) {
      const target = node.definition ? locations.get(locationKey(node.definition)) ?? undefined : undefined;
      const edge = { node, owner, target };
      owner.outgoing.push(edge);
      target?.incoming.push(edge);
      edges.push(edge);
    }
  }
  const byInfo = new Map(definitions.map(definition => [definition.info, definition]));
  for (const relation of [...resolveDispatchContext(infos), ...resolveTypeContracts(infos)]) {
    const owner = byInfo.get(relation.owner), target = byInfo.get(relation.target);
    if (!owner || !target || target.info.line === undefined) continue;
    const edge: Edge = {
      owner, target,
      relation: { kind: relation.kind, evidence: relation.evidence },
      node: {
        key: target.info.key, label: target.info.label, children: [],
        file: owner.info.file, line: relation.line,
        definition: { file: target.info.file, line: target.info.line, endLine: target.info.endLine },
      },
    };
    owner.outgoing.push(edge);
    target.incoming.push(edge);
    edges.push(edge);
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
  if (edge.relation) return [
    `${edge.relation.kind} relation ${edge.owner.info.key} -> ${target?.info.key} @ ${location(node)}`,
    `  snapshot=${side} target=candidate mapping=unknown`,
    `  evidence=${edge.relation.evidence}`,
    `  definition=${location(node.definition ?? {})}`,
    "  static syntax relation; not a runtime call or proof of delivery",
  ].join("\n");
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

function selectContext(graph: ContextGraph, unit: ReviewUnit, side: SnapshotSide): Selection {
  const seeds = hunkDefinitions(graph, unit, side);
  if (seeds.length === 0) return { selected: [], omissions: [], seeds };
  const lines = changedLines(unit, side);
  const seedSet = new Set(seeds);
  const selected = new Map<Edge, SelectedEdge>();
  // Outgoing descendants and incoming callers have separate visited sets. Walking
  // upstream must not expand unrelated sibling calls in the caller's body.
  for (const direction of ["outgoing", "incoming"] as const) {
    const seen = new Set(seeds);
    const queue = seeds.map(definition => ({ definition, distance: 0, anchor: definition }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { definition, distance, anchor } = queue[cursor];
      if (distance >= CALL_FLOW_MAX_DEPTH) continue;
      for (const edge of definition[direction]) {
        const next = direction === "outgoing" ? edge.target : edge.owner;
        const repeated = direction === "outgoing" && next !== undefined && seen.has(next) && next.outgoing.length > 0;
        const previous = selected.get(edge);
        if (!previous || previous.distance > distance + 1) {
          const atHunk = edge.node.file === unit.file && edge.node.line !== undefined &&
            lines.some(line => line >= edge.node.line! && line <= (edge.node.endLine ?? edge.node.line!));
          const priority = atHunk ? 0 : edge.target && seedSet.has(edge.target) ? 1 : distance + 2;
          selected.set(edge, { edge, side, distance: distance + 1, priority, repeated, anchor, direction });
        } else if (repeated) previous.repeated = true;
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push({ definition: next, distance: distance + 1, anchor });
        }
      }
    }
  }
  if (selected.size === 0) return { selected: [], omissions: [], seeds };
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
  if (unrelated) omissions.push(`omitted context edges=${unrelated} snapshot=${side} reason=unrelated-to-hunk`);
  if (distant) omissions.push(`omitted context edges=${distant} snapshot=${side} reason=distant-descendants-or-siblings depth-limit=${CALL_FLOW_MAX_DEPTH}`);
  return { selected: [...selected.values()], omissions, seeds };
}

/** Distinct, readable key for one node; a repeated symbol key keeps its own location. */
function nodeKey(info: FunctionInfo, side: SnapshotSide, taken: Set<string>): string {
  const symbol = `${side}:${info.key}`;
  if (!taken.has(symbol)) {
    taken.add(symbol);
    return symbol;
  }
  const located = `${symbol}@${info.line ?? "?"}`;
  let key = located;
  for (let nth = 2; taken.has(key); nth += 1) key = `${located}#${nth}`;
  taken.add(key);
  return key;
}

/**
 * The nodes one hunk's selection describes: the changed definition in each
 * snapshot, the definitions that call it, then the definitions its calls
 * resolve to, each carrying the call sites and bindings the selection already
 * extracted. A selected edge is attached to its owner's node and, when the edge
 * resolved into a node as well, to that node's caller evidence, so no existing
 * evidence is dropped on the way here.
 */
function nodePlans(
  sides: readonly { side: SnapshotSide; selection: Selection }[],
): ContextNodePlan[] {
  const plans: ContextNodePlan[] = [];
  const byDefinition = new Map<Definition, ContextNodePlan>();
  const keys = new Set<string>();
  const add = (definition: Definition, side: SnapshotSide, role: ContextNodePlan["role"]): ContextNodePlan | undefined => {
    const existing = byDefinition.get(definition);
    if (existing) return existing;
    // A definition without a line has no location to address, so it never becomes a node.
    if (definition.info.line === undefined) return undefined;
    const plan: ContextNodePlan = {
      definition, key: nodeKey(definition.info, side, keys), side, role,
      calls: [], reachedBy: [], calleeReach: [], callerReach: [],
    };
    byDefinition.set(definition, plan);
    plans.push(plan);
    return plan;
  };

  // Hunk definitions of both snapshots lead — the resulting snapshot first,
  // because it is the code under review — then the definitions that call them,
  // which are the caller contracts a hunk alone cannot show, then the
  // definitions their selected calls resolve to, nearest first, which are the
  // callee bodies a call signature alone cannot show.
  const distances = new Map<Definition, number>();
  const boundaries = new Set<Definition>();
  for (const { selection } of sides) {
    for (const seed of selection.seeds) distances.set(seed, 0);
    for (const entry of selection.selected) {
      const near = entry.direction === "incoming" ? entry.edge.target : entry.edge.owner;
      const far = entry.direction === "incoming" ? entry.edge.owner : entry.edge.target;
      if (near) distances.set(near, Math.min(distances.get(near) ?? Infinity, entry.distance - 1));
      if (far) distances.set(far, Math.min(distances.get(far) ?? Infinity, entry.distance));
      if (entry.edge.relation) {
        boundaries.add(entry.edge.owner);
        if (entry.edge.target) boundaries.add(entry.edge.target);
      }
    }
  }
  for (const { side, selection } of sides) for (const seed of selection.seeds) add(seed, side, "changed-definition");
  for (const { side, selection } of sides) {
    for (const entry of selection.selected) {
      if (entry.direction !== "incoming") continue;
      add(entry.edge.owner, side, "caller");
    }
  }
  for (const { side, selection } of sides) {
    // The walk already holds one entry per selected edge at the shortest
    // distance it was reached, so a stable sort by distance orders a callee
    // before the definitions that callee in turn reaches.
    const callees = selection.selected
      .filter(entry => entry.direction === "outgoing" && entry.edge.target !== undefined)
      .sort((left, right) => left.distance - right.distance);
    for (const entry of callees) add(entry.edge.target!, side, "callee");
  }

  for (const { selection } of sides) {
    for (const entry of selection.selected) {
      const owner = byDefinition.get(entry.edge.owner);
      const target = entry.edge.target === undefined ? undefined : byDefinition.get(entry.edge.target);
      // A selected edge is the owner's own call site and, when it resolved into
      // a node, that node's caller evidence too: a definition whose body does
      // not contain the call would otherwise carry no binding at all.
      if (owner) owner.calls.push(entry);
      if (target && target !== owner) target.reachedBy.push(entry);
      if (owner || target) continue;
      // A definition the snapshot gave no line never became a node, so its
      // edges stay with the hunk definition whose walk found them.
      const anchor = byDefinition.get(entry.anchor);
      if (!anchor) continue;
      if (entry.direction === "incoming") anchor.callerReach.push(entry);
      else anchor.calleeReach.push(entry);
    }
  }

  // Unseen boundary evidence must not lose every descriptor to a long caller
  // chain. Within each tier, nearest definitions lead; the after snapshot wins
  // ties. Whole bodies already shown in the hunk are still demoted below.
  const tier = (plan: ContextNodePlan) => plan.role === "changed-definition" ? 0
    : boundaries.has(plan.definition) ? 1 : 2;
  return plans.sort((a, b) => tier(a) - tier(b)
    || (distances.get(a.definition) ?? Infinity) - (distances.get(b.definition) ?? Infinity)
    || Number(a.side === "before") - Number(b.side === "before"));
}

/** Section headers of a node detail, in the order the evidence is shown. */
const EVIDENCE_SECTIONS = [
  { label: "call-sites-in-this-definition", of: "calls", depth: false },
  { label: "call-sites-reaching-this-definition", of: "reachedBy", depth: false },
  { label: "callee-reach-from-this-definition", of: "calleeReach", depth: true },
  { label: "caller-reach-from-this-definition", of: "callerReach", depth: true },
] as const;

/**
 * Whole node text: identity, the snapshot's own definition source between
 * explicit markers, and the selected call/binding evidence for this node. The
 * source is never re-indented or excerpted, so the text between the markers is
 * exactly what the snapshot holds.
 */
function nodeDetail(plan: ContextNodePlan, unit: ReviewUnit, source: string | null): string {
  const info = plan.definition.info;
  const loc = formatSourceLoc({ file: info.file, line: info.line!, endLine: info.endLine });
  const lines = [
    `context node ${plan.key}`,
    `  label=${info.label}`,
    `  location=${loc} snapshot=${plan.side} role=${plan.role} hunk=${unit.id} file=${unit.file}`,
    info.review?.kind ? `  declaration-kind=${info.review.kind} (non-callable)` : `  declared-parameters=${info.params?.text ?? "unavailable"}`,
  ];
  if (source === null) lines.push(`  source=${loc} snapshot=${plan.side} unavailable reason=whole-definition-not-readable`);
  else lines.push(`  source=${loc} snapshot=${plan.side} begin`, source, "  source-end");
  let evidence = 0;
  for (const section of EVIDENCE_SECTIONS) {
    const edges = plan[section.of];
    if (edges.length === 0) continue;
    evidence += edges.length;
    lines.push(`  evidence=${section.label} count=${edges.length}`);
    for (const entry of edges) {
      if (section.depth) lines.push(`  depth=${entry.distance}`);
      lines.push(renderEdge(entry));
    }
  }
  if (evidence === 0) lines.push("  evidence=none-selected reason=no-selected-call-site-touches-this-definition");
  return lines.join("\n");
}

function contextNodeOf(plan: ContextNodePlan, unit: ReviewUnit, source: string | null): ReviewContextNode {
  const info = plan.definition.info;
  const roles = new Set<string>();
  for (const { edge } of plan.calls) {
    if (edge.relation?.kind === "event") roles.add("event publisher");
    if (edge.relation?.kind === "queue") roles.add("queue producer");
  }
  for (const { edge } of plan.reachedBy) {
    if (edge.relation?.kind === "event") roles.add("event listener");
    if (edge.relation?.kind === "queue") roles.add("queue consumer");
  }
  return {
    key: plan.key,
    label: roles.size ? `${info.label} [${[...roles].join(", ")}]` : info.label,
    file: info.file,
    // Every node was admitted with a location, so this is the same line the
    // descriptor and the detail report.
    line: info.line!,
    detail: nodeDetail(plan, unit, source),
  };
}

/** Exact source lines already visible on each side of the untruncated hunk. */
function hunkSources(unit: ReviewUnit) {
  const before: string[] = [], after: string[] = [];
  for (const line of unit.diff.split("\n").slice(1)) {
    if (line[0] === " " || line[0] === "-") before.push(line.slice(1));
    if (line[0] === " " || line[0] === "+") after.push(line.slice(1));
  }
  return {
    before: { text: before.join("\n"), start: unit.oldStart, end: unit.oldStart + before.length - 1 },
    after: { text: after.join("\n"), start: unit.newStart, end: unit.newStart + after.length - 1 },
  };
}

/**
 * Per-hunk context: the standalone report blocks, adjacent to the hunk first
 * with snapshot-local bindings, and the structured nodes those blocks were
 * derived from. A hunk with neither gets no entry rather than an empty one.
 */
export function buildCallContext(
  units: readonly ReviewUnit[],
  before: FunctionIndex,
  after: FunctionIndex,
  sources: ContextSources = {},
): Map<string, UnitContext> {
  const beforeGraph = contextGraph(before), afterGraph = contextGraph(after);
  const result = new Map<string, UnitContext>();
  for (const unit of units) {
    if (unit.special || !unit.header.startsWith("@@")) continue;
    const prior = selectContext(beforeGraph, unit, "before");
    const current = selectContext(afterGraph, unit, "after");
    // Keep both sides of an adjacent edge before any farther descendant.
    const selected = [...current.selected, ...prior.selected].sort((left, right) => left.priority - right.priority);
    const blocks = selected.map(renderEdge);
    const omissions = [...prior.omissions, ...current.omissions];
    if (omissions.length) blocks.push(omissions.join("\n"));
    const shown = hunkSources(unit);
    const nodes: ReviewContextNode[] = [], redundant: ReviewContextNode[] = [];
    for (const plan of nodePlans([{ side: "after", selection: current }, { side: "before", selection: prior }])) {
      const info = plan.definition.info;
      const source = sources[plan.side]?.({ file: info.file, line: info.line!, endLine: info.endLine }) ?? null;
      const node = contextNodeOf(plan, unit, source);
      const snapshot = shown[plan.side];
      // Do not let whole definitions already present in the diff consume the
      // addressable-node cap before external contracts. Keep them, with all
      // their call evidence, after definitions whose bodies the hunk cannot show.
      const fullyShown = info.file === unit.file && info.line! >= snapshot.start &&
        (info.endLine ?? info.line!) <= snapshot.end && source !== null && source.length > 0 &&
        snapshot.text.includes(source);
      (fullyShown ? redundant : nodes).push(node);
    }
    nodes.push(...redundant);
    if (blocks.length === 0 && nodes.length === 0) continue;
    result.set(unit.id, { entries: blocks, nodes });
  }
  return result;
}
