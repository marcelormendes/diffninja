import type { PullRequestIntent, ReviewEvidence } from "./evidence-types.js";
import type { ChangeFacts } from "./change-facts.js";
import type { ReviewQuestion } from "./questions.js";
import type { HunkHistory, ProjectContext } from "./history.js";

export type ReviewStatus = "attention" | "uncertain" | "low" | "passed";
/**
 * Structural status for a call-flow node. The engine only knows `same`,
 * `added`, and `removed`; the report derives `changed` for a `same` node whose
 * descendants changed, which is what makes a same-signature caller visible.
 */
export type CallFlowStatus = "same" | "added" | "removed" | "changed";
/**
 * Actual resolved definition of a node, read from the snapshot it lived in.
 * `text` is the definition's own source, never the call site's.
 */
export interface CallFlowSource {
  file: string;
  line: number;
  endLine: number;
  /**
   * Opaque, printable provenance for the snapshot the text came from: the short
   * commit of the `to` side, or of the `from` side for a removed node.
   */
  ref: string;
  /**
   * Definition source lines `line`..`endLine`, verbatim and complete. Nothing
   * is trimmed: the report has to be readable without the repository, so a
   * function is carried whole or not at all.
   */
  text: string;
}
/** One call in a report call-flow tree: root = definition, children = call sites. */
export interface CallFlowNode {
  key: string;
  label: string;
  status: CallFlowStatus;
  /** File containing the call site (the root's own definition file at depth 0). */
  file?: string;
  line?: number;
  /** End line of a call site spanning several lines. */
  endLine?: number;
  /**
   * Verbatim first prose line of the definition's attached leading comment, or
   * of its Python docstring. Absent when the definition has neither, or when its
   * source could not be read. Never generated.
   */
  description?: string;
  /** Absent when the call has no indexed definition, or its source is unreadable. */
  source?: CallFlowSource;
  children: CallFlowNode[];
}
/** Bounded call-flow trees that touch one changed file. */
export interface CallFlowFile {
  file: string;
  /** Root definitions whose call paths reach this file, in engine order. */
  trees: CallFlowNode[];
  /** True when serialization dropped roots, children, depth, or nodes to fit the bounds. */
  truncated: boolean;
}
/**
 * Why structured call flows are present or absent. `available` means at least
 * one changed file has trees; `no-changes` means there was nothing structural to
 * attach (no changed file with text hunks, or no tree reaching one) and is not a
 * safety claim; `needs-git-range` means the input was a patch; `failed` means
 * the analysis threw.
 */
export type CallFlowAvailability = "available" | "needs-git-range" | "no-changes" | "failed";
/**
 * One keyed piece of structured review context for a hunk: a changed, caller, or
 * callee definition with its snapshot-bound source and the call/binding evidence
 * extracted for it. Nodes are selected deterministically and feed the evidence
 * agenda and the reviewer's context.
 */
export interface ReviewContextNode {
  /** Addressable identity inside one hunk, unique across snapshots, e.g. `after:checkout`. */
  key: string;
  /** Extractor label of the definition, e.g. `checkout(order, user)`. */
  label: string;
  file: string;
  /** 1-based definition line, the location half of the node's identity. */
  line: number;
  /**
   * Whole node text: the definition source as the snapshot has it, plus the
   * selected call sites and bindings already extracted for it. Never a preview
   * and never truncated.
   */
  detail: string;
}

/** One parsed piece of the input: a text hunk, or a file's metadata-only change. */
export interface ReviewUnit {
  id: string;
  file: string;
  header: string;
  diff: string;
  added: number;
  removed: number;
  oldStart: number;
  newStart: number;
  /**
   * Why this unit cannot be judged from the diff alone (binary, rename, mode,
   * symbolic link, submodule). A unit that carries one goes to manual review.
   */
  special?: string;
  /**
   * Report blocks for this hunk, in the order the report shows them: both
   * snapshots, the call on a changed line first. They stay the readable report
   * text; {@link ReviewUnit.contextNodes} carries the structured form.
   */
  callFlow?: string[];
  /**
   * Structured context for this hunk, highest retention priority first.
   * An empty array is never set in place of "no context".
   */
  contextNodes?: ReviewContextNode[];
  /** Commits that last changed the lines this hunk removes; git-range reviews only. */
  history?: HunkHistory;
}
export interface ReviewItem extends ReviewUnit {
  status: ReviewStatus;
  priority: number; // 0..100
  /** Fixed templates over the local facts; a cited line is quoted from the diff itself. */
  reasons: string[];
  /** Local change facts; absent for manual units and fact-free passes. */
  facts?: ChangeFacts;
}
export interface AgentOrder {
  /** Every item id of the report exactly once, most important first; the report's items follow it. */
  itemIds: string[];
  orderedBy: string;
  orderedAt: string;
  /** diffninja's own order of the same items, kept so the page can still offer it. */
  diffninjaIds: string[];
}
/** One line comment the reviewing agent suggests; the human adds it to their review or not. */
export interface SuggestedComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}
export interface AgentComments {
  comments: SuggestedComment[];
  suggestedBy: string;
  suggestedAt: string;
}
export interface ReviewReport {
  title: string;
  source: string;
  createdAt: string;
  pr?: PullRequestIntent;
  evidence?: ReviewEvidence;
  items: ReviewItem[];
  callFlow: string[];
  /**
   * One entry per changed file with actual text hunks that a call-flow tree
   * reaches, in report rank order. Metadata-only files and files no tree
   * reaches are omitted rather than reported as empty trees.
   */
  callFlows: CallFlowFile[];
  callFlowAvailability: CallFlowAvailability;
  warnings: string[];
  /** Questions for the reviewing agent's model, bound to hunks; answers never reorder the report. */
  questions: ReviewQuestion[];
  /** The reading order the reviewing agent recorded; once present, `items` follow it. */
  agentOrder?: AgentOrder;
  /** Line comments the reviewing agent suggested; nothing is posted until the human submits them. */
  agentComments?: AgentComments;
  /**
   * Local repository context for a git-range review: prior reverts, contributor
   * guidelines, and sibling-file conventions. Absent for a patch.
   */
  project?: ProjectContext;
}
export interface ReviewOptions {
  /** Exact PR metadata, treated as untrusted evidence rather than instructions. */
  pr?: PullRequestIntent;
  /** Opt in to the locally installed project TypeScript checker; never a PR script. */
  referenceProject?: string;
}
