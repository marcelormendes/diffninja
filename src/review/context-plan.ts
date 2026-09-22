/**
 * Adaptive context plan for one hunk's Jev state.
 *
 * A state is built in two steps. First, descriptors for at most
 * {@link MAX_CONTEXT_NODES} nodes are admitted, highest retention priority
 * first: a descriptor is the node's identity — key, label, file, line — and
 * costs no detail. Then whole details are expanded, in that same priority
 * order, while the serialized state still fits {@link INITIAL_STATE_CHARS}. A
 * node whose detail does not fit stays visible as a collapsed descriptor, so a
 * later round can request exactly that detail by key rather than the whole
 * report, and the note states every omission explicitly instead of leaving it
 * implied.
 *
 * Expansion is append-only evidence and always bounded. Only keys the state
 * currently lists as collapsed can be expanded, each expansion costs its
 * serialized UTF-8 bytes against {@link MAX_ADDED_CONTEXT_BYTES} and must keep
 * the whole state under {@link MAX_STATE_CHARS}, and a request that cannot be
 * satisfied returns no keys — so a caller's expansion loop always terminates.
 * Details are carried whole or not at all: this plan never truncates, and the
 * initial round never spends the added-byte budget.
 *
 * The base state's own note is replaced only when nodes were supplied, and the
 * replacement keeps every caveat the no-flow note made: these nodes are
 * syntactic and snapshot-bound, they are not complete caller contracts, and a
 * missing node establishes neither safety nor a defect.
 */

import { MAX_STATE_CHARS } from "./context-limits.js";
import type { JevState } from "./jev.js";
import type { ReviewContextNode } from "./types.js";

/** Serialized-state target for the first round of a hunk. */
export const INITIAL_STATE_CHARS = 12_000;
/** Most nodes one state can address; a node without a descriptor cannot be expanded. */
export const MAX_CONTEXT_NODES = 8;
/**
 * Bytes one plan may add across every expansion, charged conservatively: each
 * accepted expansion costs the UTF-8 length of its serialized detail field
 * including that field's wrapper, which is never less than the state grew.
 */
export const MAX_ADDED_CONTEXT_BYTES = 24_000;

/** Descriptor the plan keeps for one node; `detail` is present only when expanded. */
export interface ContextPlanNode {
  key: string;
  label: string;
  file: string;
  line: number;
  /** True while the state lists this node's identity without its detail. */
  collapsed: boolean;
  detail?: string;
}

/** One admitted node: descriptor identity plus the whole detail expansion adds. */
interface RetainedNode {
  key: string;
  label: string;
  file: string;
  line: number;
  detail: string;
}

/** Shared empty set: no node is expanded while admission only measures descriptors. */
const NO_EXPANSION: ReadonlySet<string> = new Set<string>();

/**
 * Standing caveats for a state that carries nodes. It replaces the no-flow note
 * and states the same limits that note did — syntactic extraction, snapshot
 * provenance, incompleteness, and that absence is not safety — plus what a
 * collapsed descriptor does and does not reveal.
 */
const STRUCTURED_CONTEXT_CAVEAT =
  "contextNodes contains selected static, syntactic context for this file: changed, caller, callee, " +
  "event/queue-related definitions and type/interface/enum contracts read from one snapshot. " +
  "Argument expressions, parameter declarations, and definition sources are source text, not runtime " +
  "values; mappings describe supported argument-binding syntax only, not data-flow analysis or proof " +
  "of the runtime target. Event/queue edges are candidate static key matches, not proof of delivery; " +
  "type references describe declarations, not runtime calls. Unknown mappings must not be inferred. Every node " +
  "identifies its snapshot: after describes resulting code, before describes prior or removed " +
  "code, and evidence must not be combined across snapshots as one execution. Context is " +
  "depth- and size-limited: unavailable extraction, omitted arguments, truncated expressions, and " +
  "depth cuts are marked, and every node or call-flow entry not listed in this state is omitted. " +
  "A node marked collapsed shows its key, label, file, and line only; its source body and call " +
  "evidence are absent from this state until requested. Dynamic calls, higher-order invocation, " +
  "overload resolution, implicit arguments, unsupported syntax or languages, and parse failures " +
  "may leave relevant context absent. Nodes are not complete caller contracts. Missing context " +
  "establishes neither safety nor a defect; needs_human concerns missing information necessary " +
  "to assess this change.";

/** Note for retained nodes, plus the counts of every descriptor the state omits. */
function structuredContextNote(omittedByCount: number, omittedBySize: number): string {
  const facts: string[] = [];
  if (omittedByCount > 0) {
    facts.push(`${omittedByCount} beyond the ${MAX_CONTEXT_NODES}-node key limit`);
  }
  if (omittedBySize > 0) {
    facts.push(
      `${omittedBySize} whose descriptor did not fit the ${MAX_STATE_CHARS}-character state limit`,
    );
  }
  if (facts.length === 0) return STRUCTURED_CONTEXT_CAVEAT;
  return (
    `${STRUCTURED_CONTEXT_CAVEAT} Context nodes omitted: ${facts.join("; ")}. ` +
    "They are not listed here and cannot be expanded."
  );
}

/** Node identity is the key, so a repeated key must not become a second descriptor. */
function distinctNodes(nodes: readonly ReviewContextNode[]): ReviewContextNode[] {
  const seen = new Set<string>();
  const distinct: ReviewContextNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.key)) continue;
    seen.add(node.key);
    distinct.push(node);
  }
  return distinct;
}

/** The base state's essentials plus this plan's note and descriptors. */
function renderState(
  base: JevState,
  entries: readonly RetainedNode[],
  expanded: ReadonlySet<string>,
  note: string,
): JevState {
  if (entries.length === 0) return { ...base, contextNote: note };
  const contextNodes: ContextPlanNode[] = entries.map((entry) =>
    expanded.has(entry.key)
      ? { key: entry.key, label: entry.label, file: entry.file, line: entry.line, collapsed: false, detail: entry.detail }
      : { key: entry.key, label: entry.label, file: entry.file, line: entry.line, collapsed: true },
  );
  return { ...base, contextNote: note, contextNodes };
}

/**
 * One hunk's context plan: the state to send now, plus the keys that can still
 * be expanded into it by name.
 */
export class ContextPlan {
  readonly #base: JevState;
  readonly #entries: readonly RetainedNode[];
  readonly #byKey: ReadonlyMap<string, RetainedNode>;
  readonly #note: string;
  readonly #expanded: Set<string>;
  #addedBytes = 0;
  #state: JevState;

  constructor(base: JevState, nodes: readonly ReviewContextNode[]) {
    this.#base = base;
    this.#expanded = new Set<string>();
    const supplied = distinctNodes(nodes);
    // No node supplied: the state is the base state, note included, untouched.
    if (supplied.length === 0) {
      this.#entries = [];
      this.#byKey = new Map();
      this.#note = base.contextNote;
      this.#state = base;
      return;
    }

    const capped = supplied.slice(0, MAX_CONTEXT_NODES);
    const omittedByCount = supplied.length - capped.length;
    // Descriptor admission is measured against the note variant that still
    // mentions a size omission, so a descriptor is never admitted on the
    // strength of a note that a later drop would lengthen.
    const admitted: RetainedNode[] = [];
    let omittedBySize = 0;
    for (const node of capped) {
      const entry: RetainedNode = {
        key: node.key, label: node.label, file: node.file, line: node.line, detail: node.detail,
      };
      const measured = JSON.stringify(
        renderState(base, [...admitted, entry], NO_EXPANSION, structuredContextNote(omittedByCount, omittedBySize + 1)),
      ).length;
      if (measured <= MAX_STATE_CHARS) admitted.push(entry);
      else omittedBySize += 1;
    }
    // A note's own counts change its length, so the admitted set is verified
    // once against the note it will actually ship with.
    let note = structuredContextNote(omittedByCount, omittedBySize);
    while (admitted.length > 0) {
      const measured = JSON.stringify(renderState(base, admitted, NO_EXPANSION, note)).length;
      if (measured <= MAX_STATE_CHARS) break;
      admitted.pop();
      omittedBySize += 1;
      note = structuredContextNote(omittedByCount, omittedBySize);
    }
    // No descriptor fits: the state stays the base state, because a node nobody
    // can address is not context, and a note promising nodes it cannot list
    // would be worse than the state the caller already had. This also keeps the
    // rule that a state carrying nodes is within the cap.
    if (admitted.length === 0) {
      this.#entries = [];
      this.#byKey = new Map();
      this.#note = base.contextNote;
      this.#state = base;
      return;
    }
    this.#entries = admitted;
    this.#note = note;
    this.#byKey = new Map(admitted.map((entry) => [entry.key, entry]));

    // The initial round spends only the initial target, in priority order: a
    // node whose detail does not fit stays collapsed and is still addressable.
    for (const entry of this.#entries) {
      const candidate = new Set(this.#expanded);
      candidate.add(entry.key);
      const measured = JSON.stringify(renderState(base, this.#entries, candidate, this.#note)).length;
      if (measured > INITIAL_STATE_CHARS) continue;
      this.#expanded.add(entry.key);
    }
    this.#state = renderState(base, this.#entries, this.#expanded, this.#note);
  }

  /** Current state: essentials, the context note, and the node descriptors. */
  get state(): JevState {
    return this.#state;
  }

  /** Keys still listed collapsed, in priority order; these are the expandable ones. */
  get collapsedKeys(): readonly string[] {
    return this.#entries.filter((entry) => !this.#expanded.has(entry.key)).map((entry) => entry.key);
  }

  /** Serialized UTF-8 bytes every accepted expansion has added so far. */
  get addedBytes(): number {
    return this.#addedBytes;
  }

  /**
   * Expand the requested nodes whose detail fits both budgets, in request order.
   * Returns the keys actually expanded: a key that is not currently visible, is
   * already expanded, or cannot fit is ignored, so an unsatisfiable request
   * reports no progress rather than pretending some was made.
   */
  expand(keys: readonly string[]): string[] {
    const expandedNow: string[] = [];
    for (const key of keys) {
      const entry = this.#byKey.get(key);
      if (entry === undefined || this.#expanded.has(key)) continue;
      const charge = Buffer.byteLength(JSON.stringify({ detail: entry.detail }), "utf8");
      if (this.#addedBytes + charge > MAX_ADDED_CONTEXT_BYTES) continue;
      const candidate = new Set(this.#expanded);
      candidate.add(key);
      const state = renderState(this.#base, this.#entries, candidate, this.#note);
      if (JSON.stringify(state).length > MAX_STATE_CHARS) continue;
      this.#expanded.add(key);
      this.#addedBytes += charge;
      this.#state = state;
      expandedNow.push(key);
    }
    return expandedNow;
  }
}
