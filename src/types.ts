export type CallNodeKind = "call" | "branch";

/** Longest argument expression kept verbatim; longer text is cut and flagged. */
export const MAX_ARGUMENT_CHARS = 120;
/** Most arguments read from one call; the rest are flagged, not guessed. */
export const MAX_CALL_ARGUMENTS = 8;

/**
 * `lexical` — an unambiguous same-file declaration with matching AST provenance;
 * `candidate` — a name/member heuristic that may reach a definition, so argument
 * binding is never assumed; `unresolved` — dynamic or not found in the index.
 */
export type CallTargetKind = "lexical" | "candidate" | "unresolved";

/**
 * How call arguments line up with the callee's declared parameters:
 * `positional` — arguments bind to parameter slots in order; `named` — the call
 * supplies at least one keyword argument, bound by name; `partial` — some
 * argument could not be bound reliably (spread, destructuring, rest, extras);
 * `unknown` — no reliable association (unindexed or dynamic target).
 */
export type CallArgumentMapping = "positional" | "named" | "partial" | "unknown";

/**
 * Honesty of an extracted call context. This describes what the extractor
 * knows, not whether the call is valid:
 * `complete` — arguments were read and every one binds to a declared parameter;
 * `partial` — arguments were read, but a binding, parameter list, or the
 * argument list itself is incomplete; `unavailable` — the call site has no
 * readable argument list at all (`arguments` is then absent).
 */
export type CallContextCompleteness = "complete" | "partial" | "unavailable";

/** One argument as written at the call site, with its binding when reliable. */
export interface CallArgument {
  /** 1-based order in the call's argument list. */
  position: number;
  /**
   * Argument source text, byte-for-byte as written (whitespace, quotes and
   * escapes preserved), at most {@link MAX_ARGUMENT_CHARS} characters. Keyword
   * arguments keep their `param=` spelling.
   */
  expression: string;
  /** Declared parameter this argument binds to, when the binding is reliable. */
  parameter?: string;
  /** `expression` was cut to {@link MAX_ARGUMENT_CHARS}; see `originalLength`. */
  truncated?: boolean;
  /** Length of the full expression before truncation. */
  originalLength?: number;
}

/** Everything extracted about one call site, alongside its definition. */
export interface CallContext {
  /**
   * Source text of the target expression. Cut at {@link MAX_ARGUMENT_CHARS}
   * when longer, which `expression-truncated` reports.
   */
  callee: string;
  /** How `callee` was associated with a definition. */
  target: CallTargetKind;
  /** Verbatim declared parameter list of the callee, when one is known. */
  parameters?: string;
  /** How `arguments` line up with `parameters`. */
  mapping: CallArgumentMapping;
  /**
   * Arguments in call order. Absent when the call site has no readable argument
   * list; `[]` means the call was written with an empty one.
   */
  arguments?: CallArgument[];
  /** Written argument entries omitted by the eight-argument extraction limit. */
  omittedArguments?: number;
  completeness: CallContextCompleteness;
  /** Factual, stable identifiers for every limit; see {@link CALL_REASONS}. */
  reasons: string[];
  /** Callee-body steps not expanded below this node (depth cut, recursion). */
  omittedChildren?: number;
  /** Calls dropped inside this call's own arguments at the depth cut. */
  omittedInlineChildren?: number;
}

/**
 * Stable identifiers for `CallContext.reasons`. They are facts about the
 * extraction (`spread-argument`), never judgments about the change.
 */
export const CALL_REASONS = {
  /** Target is not a plain name or member chain (`arg[0]()`, `callee()()`). */
  dynamicCallee: "dynamic-callee",
  /** A parameter of the enclosing function shadows the target name. */
  parameterShadow: "parameter-shadow",
  /** A local variable of an enclosing scope shadows the target name. */
  localShadow: "local-shadow",
  /** Nothing in the index defines the target name. */
  targetNotIndexed: "target-not-indexed",
  /** Several definitions share the target name, none local to the call. */
  targetAmbiguous: "target-ambiguous",
  /** The call site has no argument list, or it could not be read. */
  argumentsUnavailable: "arguments-unavailable",
  /** More than {@link MAX_CALL_ARGUMENTS} arguments; the rest were not read. */
  argumentsTruncated: "arguments-truncated",
  /** An argument or target expression was cut to {@link MAX_ARGUMENT_CHARS}. */
  expressionTruncated: "expression-truncated",
  /** A spread/star argument makes positions after it unreliable. */
  spreadArgument: "spread-argument",
  /** A destructuring pattern argument or parameter cannot be named. */
  destructuredBinding: "destructured-binding",
  /** A keyword argument binds to a declared parameter. */
  keywordBinding: "keyword-binding",
  /** An argument binds through a rest (`...param`, `*param`, `**param`). */
  restBinding: "rest-binding",
  /** More arguments than declared parameters; the extras bind to nothing. */
  extraArguments: "extra-arguments",
  /** More than one argument tries to bind the same declared slot. */
  duplicateBinding: "duplicate-argument-binding",
  /** Argument-to-parameter binding was not derived for this call. */
  bindingUnavailable: "binding-unavailable",
} as const;

/** One declared parameter slot, in source order. */
export type ParamSlot =
  | {
      /** Positional or keyword-only parameter with a bindable name. */
      form: "positional" | "keyword";
      name: string;
      hasDefault: boolean;
      /** Python parameters before `/` cannot be bound by keyword. */
      positionalOnly?: boolean;
    }
  /** Rest parameters take an unbounded run of arguments. */
  | { form: "rest" | "keyword-rest"; name: string | null }
  /** Destructuring pattern with no single bindable name. */
  | { form: "pattern"; hasDefault: boolean };

/** Declared parameter list of one definition, read from its AST node. */
export interface DeclaredParams {
  /** Verbatim declared list including parentheses, e.g. `(param1, param2 = 1)`. */
  text: string;
  /**
   * Bindable slots in source order, when the extractor read them from the AST.
   * `[]` is a parameter list that really declares nothing. Absent means only
   * `text` was read, which leaves argument binding `unknown` rather than
   * guessed.
   */
  slots?: ParamSlot[];
  /** Parameter AST offsets; disambiguate the declaration without parsing labels. */
  start?: number;
  end?: number;
}

/** How one written argument participates in binding. */
export type ArgumentRole = "positional" | "keyword" | "star" | "star-star";

/** One argument captured from the AST, before a definition is known. */
export interface CallArgumentSyntax {
  position: number;
  role: ArgumentRole;
  /** Keyword name for `param=arg` arguments. */
  keyword?: string;
  expression: string;
  truncated?: boolean;
  originalLength?: number;
}

/**
 * AST-side material for one call site: the target expression, its lexical
 * association, and the arguments as written. The public contract is
 * {@link CallContext}, which `calltree.ts` derives from this once the callee's
 * definition is known.
 */
export interface CallSyntax {
  /** Verbatim target expression text. */
  callee: string;
  target: CallTargetKind;
  /** Declared parameters of a lexically bound target. */
  params?: DeclaredParams;
  /** Absent when the call site has no readable argument list. */
  arguments?: CallArgumentSyntax[];
  /** Written argument entries omitted by the extraction limit. */
  omittedArguments?: number;
  /** Extraction-side reasons; see {@link CALL_REASONS}. */
  reasons: string[];
}

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
  /** Target expression, declared parameters, and arguments as written. */
  context?: CallContext;
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
      /** AST-side call material; `calltree.ts` turns it into `CallContext`. */
      syntax?: CallSyntax;
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
  /** Review-only syntax evidence; declarations here are never callable targets. */
  review?: {
    kind?: "interface" | "type" | "enum";
    references?: { name: string; module?: string; imported?: string }[];
    dispatches?: {
      kind: "event" | "queue";
      direction: "emit" | "handle";
      key: string;
      channel?: string;
      line: number;
      evidence: string;
    }[];
  };
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
  /**
   * Declared parameter list read from the definition's AST node. Present when
   * the extractor could read one; `slots` drives argument binding, `text` is
   * shown verbatim.
   */
  params?: DeclaredParams;
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
    context?: CallContext;
  },
>(
  target: T,
  source: {
    kind?: CallNodeKind;
    file?: string;
    line?: number;
    endLine?: number;
    definition?: SourceLoc;
    context?: CallContext;
  },
): T {
  if (source.kind) target.kind = source.kind;
  if (source.file) target.file = source.file;
  if (source.line != null) target.line = source.line;
  if (source.endLine != null) target.endLine = source.endLine;
  // Copied, not aliased: a serialized tree must not share mutable state with
  // the engine tree it came from.
  if (source.definition) target.definition = { ...source.definition };
  if (source.context) target.context = copyCallContext(source.context);
  return target;
}

/** Deep enough copy that a serialized node never aliases engine state. */
export function copyCallContext(context: CallContext): CallContext {
  const copy: CallContext = {
    callee: context.callee,
    target: context.target,
    mapping: context.mapping,
    completeness: context.completeness,
    reasons: [...context.reasons],
  };
  if (context.parameters !== undefined) copy.parameters = context.parameters;
  if (context.arguments !== undefined) {
    copy.arguments = context.arguments.map((argument) => ({ ...argument }));
  }
  if (context.omittedArguments !== undefined) {
    copy.omittedArguments = context.omittedArguments;
  }
  if (context.omittedChildren !== undefined) {
    copy.omittedChildren = context.omittedChildren;
  }
  if (context.omittedInlineChildren !== undefined) {
    copy.omittedInlineChildren = context.omittedInlineChildren;
  }
  return copy;
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
