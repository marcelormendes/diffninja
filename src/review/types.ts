export type ReviewStatus = "attention" | "uncertain" | "low" | "passed";
/**
 * Structural status for a call-flow node. The engine only knows `same`,
 * `added`, and `removed`; the report derives `changed` for a `same` node whose
 * descendants changed, which is what makes a same-signature caller visible.
 */
export type CallFlowStatus = "same" | "added" | "removed" | "changed";
/** One call in a report call-flow tree: root = definition, children = call sites. */
export interface CallFlowNode {
  key: string;
  label: string;
  status: CallFlowStatus;
  file?: string;
  line?: number;
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
export interface ReviewUnit {
  id: string;
  file: string;
  header: string;
  diff: string;
  added: number;
  removed: number;
  oldStart: number;
  newStart: number;
  special?: string;
  callFlow?: string[];
}
export interface Judgment {
  risk: number; // 0..3, probability-weighted rubric index
  bug: number;
  needsHuman: number;
  category: string;
  confidence: number;
}
export interface ReviewItem extends ReviewUnit {
  status: ReviewStatus;
  priority: number; // 0..100
  reasons: string[];
  judgment?: Judgment;
}
export interface ReviewReport {
  title: string;
  source: string;
  mode: "live" | "mock";
  createdAt: string;
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
  modelCalls: number;
}
export interface ReviewOptions {
  mock?: boolean;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}
