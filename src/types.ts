export type CallNodeKind = "call" | "branch";

/** Source location as shown in editors: `file:line` or `file:line-line`. */
export interface SourceLoc {
  file: string;
  /** 1-based start line */
  line: number;
  /** 1-based end line when the span covers multiple lines */
  endLine?: number;
}

export interface CallNode {
  /** Stable identity used for matching across versions, e.g. "PiService.createAgentSession" */
  key: string;
  /** Display label, e.g. "PiService.createAgentSession" or "if (!options.sessionId)" */
  label: string;
  /** Branches omit the continuing │ rail so arms read as alternate paths */
  kind?: CallNodeKind;
  /**
   * Root: definition location. Children: call-site (or branch keyword) in the parent.
   * Matching/diff keys ignore these fields.
   */
  file?: string;
  line?: number;
  endLine?: number;
  /**
   * Definition this call resolved to, which for a child is a different place
   * than the call site in `file`/`line`. Absent when the callee has no indexed
   * definition (dynamic calls, libraries, unsupported files).
   */
  definition?: SourceLoc;
  children: CallNode[];
}

/** One step in a function body: a call, or a conditional branch with nested steps. */
export type CallStep =
  | {
      type: "call";
      key: string;
      /** Call-expression span in the caller file. */
      file?: string;
      line?: number;
      endLine?: number;
      /** Inline children (e.g. JSX component children at the call site). */
      children?: CallStep[];
    }
  | {
      type: "branch";
      key: string;
      label: string;
      /** Branch keyword / condition span. */
      file?: string;
      line?: number;
      endLine?: number;
      children: CallStep[];
    };

export type DiffStatus = "same" | "added" | "removed";

export interface DiffNode {
  key: string;
  label: string;
  status: DiffStatus;
  kind?: CallNodeKind;
  file?: string;
  line?: number;
  endLine?: number;
  /**
   * Definition the call resolved to, taken from the `after` snapshot, or from
   * `before` for a `removed` node. Call sites keep `file`/`line`.
   */
  definition?: SourceLoc;
  children: DiffNode[];
}

export interface FunctionInfo {
  /** Stable key: "foo" or "ClassName.method" or "ClassName.constructor" */
  key: string;
  label: string;
  file: string;
  /** Ordered body steps (calls + if/else branches) */
  steps: CallStep[];
  exported: boolean;
  /**
   * Declared inside another function body (a helper or closure) rather than at
   * file top level. Locals only answer calls made from their own file, so a
   * helper never shadows a top-level definition elsewhere in the repo.
   */
  local?: boolean;
  /** Source span for change detection */
  start: number;
  end: number;
  /** 1-based definition line (derived from start/end + source) */
  line?: number;
  endLine?: number;
}

export interface Snapshot {
  kind: "commit" | "worktree";
  /** Commit-ish, or "WORKTREE" */
  ref: string;
}

export interface SnapshotPair {
  from: Snapshot;
  to: Snapshot;
}

export interface SnapshotPairWithPaths extends SnapshotPair {
  paths: string[];
}

export interface SnapshotWithPaths {
  snapshot: Snapshot;
  paths: string[];
}

/** Copy optional location / kind fields onto a tree node without empty spreads. */
export function assignOptionalTreeFields<
  T extends {
    kind?: CallNodeKind;
    file?: string;
    line?: number;
    endLine?: number;
    definition?: SourceLoc;
  },
>(
  target: T,
  source: {
    kind?: CallNodeKind;
    file?: string;
    line?: number;
    endLine?: number;
    definition?: SourceLoc;
  },
): T {
  if (source.kind) target.kind = source.kind;
  if (source.file) target.file = source.file;
  if (source.line != null) target.line = source.line;
  if (source.endLine != null) target.endLine = source.endLine;
  // Copied, not aliased: a serialized tree must not share mutable state with
  // the engine tree it came from.
  if (source.definition) target.definition = { ...source.definition };
  return target;
}

export type CliMode = "diff" | "tree" | "reach";

export interface DiffTreeResult {
  entry: string;
  /** Colorless ASCII rendering of this entry's diff tree. */
  ascii: string;
  tree: DiffNode;
}

export interface DiffResult {
  mode: "diff";
  from: string;
  to: string;
  message?: string;
  trees: DiffTreeResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}

export interface TreeEntryResult {
  entry: string;
  /** Colorless ASCII rendering of this entry's call tree. */
  ascii: string;
  tree: CallNode;
}

export interface TreeResult {
  mode: "tree";
  ref: string;
  trees: TreeEntryResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}

export interface ReachPathResult {
  /** Colorless ASCII rendering of this path. */
  ascii: string;
  tree: CallNode;
}

export interface ReachResult {
  mode: "reach";
  ref: string;
  from: string;
  to: string;
  message?: string;
  paths: ReachPathResult[];
  /** Full human-oriented ASCII output (may include ANSI colors). */
  ascii: string;
}
