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
   * symbolic link, submodule). A unit that carries one never reaches the model.
   */
  special?: string;
  callFlow?: string[];
}
export interface Judgment {
  risk: number; // 0..3, probability-weighted rubric index
  bug: number; // 0..1, validated end to end
  needsHuman: number; // 0..1, validated end to end
  /** One of `REVIEW_CATEGORIES`; the closed set is checked before the answer is believed. */
  category: string;
  /** Lower of the risk and category answer confidences, 0..1. */
  confidence: number;
}
export interface ReviewItem extends ReviewUnit {
  status: ReviewStatus;
  priority: number; // 0..100
  /** Fixed templates over returned values and this adapter's own rubric text; no model-authored text is quoted. */
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
  /** Counts attempted HTTP requests, retries and failures included; always zero in mock mode. */
  modelCalls: number;
}
export interface ReviewOptions {
  /** Deterministic local fixtures, not an assessment of the code; no request is made. */
  mock?: boolean;
  /** Takes precedence over the `TYPESAFE_API_KEY` environment variable. */
  apiKey?: string;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}
