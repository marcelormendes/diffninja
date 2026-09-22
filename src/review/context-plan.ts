/**
 * Deterministic context selection for one hunk's Jev state.
 *
 * The whole state is gathered before the single request: the diff essentials plus
 * the context nodes the extractor supplied, in its retention-priority order, each
 * carried whole. Nothing is fetched afterwards and nothing is requested again, so
 * a node is either in the state with its complete source or it is not in the state
 * at all: a descriptor without its body would tell the model nothing the changed
 * lines do not already show, and a shortened definition would misrepresent the
 * snapshot it came from.
 *
 * Selection is bounded twice. At most {@link MAX_CONTEXT_NODES} distinct nodes are
 * considered, and one is admitted only while the serialized state still fits
 * {@link MAX_STATE_CHARS}, measured with `JSON.stringify` so escaping counts. A
 * node that does not fit is dropped whole rather than trimmed, and the note states
 * every omission explicitly instead of leaving it implied. When nothing fits, the
 * base state is returned unchanged, so optional context can never crowd out the
 * essentials the model has to see.
 *
 * The base state's own note is replaced only when nodes were admitted, and the
 * replacement keeps every caveat the no-context note made: these nodes are
 * syntactic and snapshot-bound, they are not complete caller contracts, and a
 * missing node establishes neither safety nor a defect.
 */

import { MAX_STATE_CHARS } from "./context-limits.js";
import type { JevState } from "./jev.js";
import type { ContextPresence, ContextPresenceCounts, ReviewContextNode } from "./types.js";

/** Most nodes one state considers; the extractor already ordered them by retention priority. */
export const MAX_CONTEXT_NODES = 8;

/**
 * Standing caveats for a state that carries nodes. It replaces the no-context
 * note and states the same limits that note did — syntactic extraction, snapshot
 * provenance, incompleteness, and that absence is not safety — plus what a missing
 * node means for the questions above.
 */
const STRUCTURED_CONTEXT_CAVEAT =
  "contextNodes contains selected static, syntactic context for this file: changed, caller, callee, " +
  "event/queue-related definitions and type/interface/enum contracts read from one snapshot. " +
  "Argument expressions, parameter declarations, and definition sources are source text, not runtime " +
  "values; mappings describe supported argument-binding syntax only, not data-flow analysis or proof " +
  "of the runtime target. Event/queue edges are candidate static key matches, not proof of delivery; " +
  "type references describe declarations, not runtime calls. Unknown mappings must not be inferred. " +
  "Every node identifies its snapshot: after describes resulting code, before describes prior or " +
  "removed code, and evidence must not be combined across snapshots as one execution. Context is " +
  "depth- and size-limited: unavailable extraction, omitted arguments, truncated expressions, and " +
  "depth cuts are marked inside each node, and every node or call-flow entry not listed in this " +
  "state is omitted. A node is carried whole or not at all: this state never carries a shortened " +
  "definition. Dynamic calls, higher-order invocation, overload resolution, implicit arguments, " +
  "unsupported syntax or languages, and parse failures may leave relevant context absent. Nodes are " +
  "not complete caller contracts. contextPresence counts only readable admitted definitions by " +
  "extractor provenance, not runtime reachability or sufficiency. Missing context establishes " +
  "neither safety nor a defect. Answer each property independently; another property also applying " +
  "is not a reason for unknown. When these nodes leave the consumer-visible effect of the change " +
  "unclear, answer the outcome question unknown rather than unchanged or changed.";

/** Note for the admitted nodes, plus the counts of every node the state omits. */
function contextNote(omittedByCount: number, omittedBySize: number): string {
  const facts: string[] = [];
  if (omittedByCount > 0) {
    facts.push(`${omittedByCount} beyond the ${MAX_CONTEXT_NODES}-node limit`);
  }
  if (omittedBySize > 0) {
    facts.push(`${omittedBySize} that did not fit the ${MAX_STATE_CHARS}-character state limit`);
  }
  if (facts.length === 0) return STRUCTURED_CONTEXT_CAVEAT;
  return (
    `${STRUCTURED_CONTEXT_CAVEAT} Context nodes omitted: ${facts.join("; ")}. Their definitions are ` +
    "absent from this state and were not replaced by shorter ones."
  );
}

/** Node identity is the key, so a repeated key must not become a second node. */
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

/** Count only admitted source whose role and snapshot the extractor established. */
export function contextPresenceOf(nodes: readonly ReviewContextNode[]): ContextPresence {
  const empty = (): ContextPresenceCounts => ({
    changedDefinitions: 0, callerDefinitions: 0, calleeDefinitions: 0, contracts: 0,
  });
  const presence: ContextPresence = { before: empty(), after: empty(), unclassifiedNodes: 0 };
  for (const node of nodes) {
    const provenance = node.provenance;
    if (!provenance) {
      presence.unclassifiedNodes++;
      continue;
    }
    if (!provenance.sourcePresent) continue;
    const counts = presence[provenance.snapshot];
    if (provenance.role === "changed-definition") counts.changedDefinitions++;
    else if (provenance.role === "caller") counts.callerDefinitions++;
    else counts.calleeDefinitions++;
    if (provenance.contract) counts.contracts++;
  }
  return presence;
}

/** The base state's essentials plus this selection's note and whole nodes. */
function renderedState(
  base: JevState,
  nodes: readonly ReviewContextNode[],
  note: string,
): JevState {
  return {
    file: base.file, hunk: base.hunk, diff: base.diff, contextNodes: nodes,
    contextNote: note, contextPresence: contextPresenceOf(nodes),
  };
}

/**
 * The state for one hunk: the base state with as many of `nodes` as fit, whole and
 * in the order supplied. Returns `base` itself when nothing fits, so the caller's
 * essentials and note survive untouched.
 *
 * A note that records a size omission is longer than one that does not, and how
 * many nodes are omitted — and therefore how long that note is — is only known
 * once a selection has been made. So the selection is a fixed point: admit nodes
 * in priority order against the shortest possible note, then, if the honest note
 * no longer fits beside that selection, drop the lowest-priority node it carries
 * and re-run the admission over the rest. Re-running is what lets a smaller node
 * that was skipped for space take the room the dropped node frees; without it, a
 * single large node early in the list could cost the state every later node even
 * though one of them fits alone. Each pass permanently excludes one node and can
 * never re-admit it, so the loop terminates within the considered node count.
 */
export function buildContextState(base: JevState, nodes: readonly ReviewContextNode[]): JevState {
  const supplied = distinctNodes(nodes);
  if (supplied.length === 0) return base;

  const considered = supplied.slice(0, MAX_CONTEXT_NODES);
  const omittedByCount = supplied.length - considered.length;
  // Measuring against the note without a size clause is the most generous
  // admission: a node rejected here could not fit beside any note.
  const optimistic = contextNote(omittedByCount, 0);
  const excluded = new Set<string>();

  const admit = (): ReviewContextNode[] => {
    const admitted: ReviewContextNode[] = [];
    for (const node of considered) {
      if (excluded.has(node.key)) continue;
      if (JSON.stringify(renderedState(base, [...admitted, node], optimistic)).length <= MAX_STATE_CHARS) {
        admitted.push(node);
      }
    }
    return admitted;
  };

  let admitted = admit();
  while (admitted.length > 0) {
    const note = contextNote(omittedByCount, considered.length - admitted.length);
    if (JSON.stringify(renderedState(base, admitted, note)).length <= MAX_STATE_CHARS) {
      return renderedState(base, admitted, note);
    }
    excluded.add(admitted[admitted.length - 1].key);
    admitted = admit();
  }

  // No node fits: the state stays the base state, because a node the state cannot
  // carry whole is not context, and a note promising definitions it cannot list
  // would be worse than the state the caller already had.
  return base;
}
