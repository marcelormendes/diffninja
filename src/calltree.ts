import {
  allFunctions,
  definitionsInFile,
  fileScopedKey,
  type FunctionIndex,
} from "./extract.js";
import { callContextFromSyntax, type CallResolution } from "./languages/call-syntax.js";
import { pickLoc } from "./loc.js";
import type {
  CallContext,
  CallNode,
  CallStep,
  FunctionInfo,
  SourceLoc,
} from "./types.js";

/** Normalize user-facing paths for entry matching (`\` → `/`, strip `./`). */
export function normalizeEntryPath(entry: string): string {
  return entry.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Unique source paths present in an index. */
export function indexedFiles(index: FunctionIndex): string[] {
  return [...new Set(allFunctions(index).map((fn) => fn.file))].sort();
}

/**
 * Resolve which indexed source files match a `--file` argument.
 * Exact path wins; otherwise a unique suffix match (`routes.ts` → `src/routes.ts`).
 */
export function matchEntrypointFiles(
  entry: string,
  files: Iterable<string>,
): string[] {
  const normalized = normalizeEntryPath(entry);
  const unique = [...new Set(files)];
  const exact = unique.filter((file) => file === normalized);
  if (exact.length > 0) return exact.sort();
  return unique
    .filter(
      (file) =>
        file === normalized || file.endsWith(`/${normalized}`),
    )
    .sort();
}

/**
 * Resolve a `--file` argument to a single indexed source path.
 * Throws when missing or ambiguous.
 */
export function resolveEntrypointFile(
  entry: string,
  files: Iterable<string>,
): string {
  const matched = matchEntrypointFiles(entry, files);
  if (matched.length === 0) {
    throw new Error(`Entrypoint file not found: ${entry}`);
  }
  if (matched.length > 1) {
    throw new Error(
      `Ambiguous entrypoint file: ${entry} matches ${matched.join(", ")}. Use a more specific path.`,
    );
  }
  return matched[0]!;
}

/** Exported definitions in a concrete source path. */
export function exportsInFile(
  file: string,
  index: FunctionIndex,
): FunctionInfo[] {
  return sortDefinitions(
    allFunctions(index).filter((fn) => fn.file === file && fn.exported),
  );
}

/**
 * Exported definitions for a `--file` argument against one index.
 * Throws when the path is missing/ambiguous; returns [] when the file has no exports.
 */
export function resolveFileEntrypoints(
  entry: string,
  index: FunctionIndex,
): FunctionInfo[] {
  const file = resolveEntrypointFile(entry, indexedFiles(index));
  return exportsInFile(file, index);
}

/** Is `fn` declared inside `owner`'s source span? */
function declaredInside(fn: FunctionInfo, owner?: FunctionInfo): boolean {
  if (!owner || fn.line == null || owner.line == null) return false;
  return (
    fn.line >= owner.line &&
    (fn.endLine ?? fn.line) <= (owner.endLine ?? owner.line)
  );
}

/**
 * Resolve one call to a definition.
 *
 * A definition in the file the call was written in always wins: the bare-key
 * map is global and first-wins, so without this a call resolves to whichever
 * same-named function happened to be indexed first, grafting an unrelated body
 * into the tree. See #19.
 *
 * Falls back to the global map, which is what callers across file boundaries
 * (the common case) rely on.
 */
function resolveCall(
  key: string,
  index: FunctionIndex,
  callSite?: { file?: string; line?: number },
  owner?: FunctionInfo,
): FunctionInfo | undefined {
  const file = callSite?.file ?? owner?.file;
  if (file) {
    const candidates = definitionsInFile(index, file, key);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // One file declaring the name twice: a helper declared inside the calling
      // function shadows that file's top-level definition.
      const shadowing = candidates.find(
        (fn) => fn.local && declaredInside(fn, owner),
      );
      return shadowing ?? candidates[0];
    }
  }
  return index.get(key);
}

/** Never borrow a same-named definition's parameters for a lexical binding. */
function callResolution(info: FunctionInfo | undefined, step?: Extract<CallStep, { type: "call" }>): CallResolution {
  const declared = step?.syntax?.params;
  return {
    resolved: info !== undefined,
    lexical: info !== undefined && step?.file === info.file && declared?.start !== undefined &&
      declared.start === info.params?.start && declared.end === info.params?.end,
  };
}

/**
 * Context for one call node: the target expression and arguments as written,
 * paired with the callee's declared parameters, plus what this expansion left
 * unvisited.
 */
function callContextFor(
  step: CallStep | undefined,
  info: FunctionInfo | undefined,
  resolution: CallResolution,
  omittedChildren?: number,
  omittedInlineChildren?: number,
): CallContext | undefined {
  if (step?.type !== "call" || !step.syntax) return undefined;
  const context = callContextFromSyntax(step.syntax, info?.params, resolution);
  // Counts are written only when something was actually left unexpanded.
  if (omittedChildren) context.omittedChildren = omittedChildren;
  if (omittedInlineChildren) context.omittedInlineChildren = omittedInlineChildren;
  return context;
}

/** Attach an extracted context without an empty spread. */
function withContext(node: CallNode, context: CallContext | undefined): CallNode {
  if (context) node.context = context;
  return node;
}

function displayCallLabel(
  key: string,
  index: FunctionIndex,
  info?: FunctionInfo,
): string {
  if (info) return info.label;
  const fromIndex = index.get(key);
  if (fromIndex) return fromIndex.label;
  return key.includes("(") ? key : `${key}()`;
}

function expandSteps(
  steps: CallStep[],
  index: FunctionIndex,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  /** Definition these steps were read from, used to scope call resolution. */
  owner?: FunctionInfo,
): CallNode[] {
  return steps.map((step) => {
    if (step.type === "branch") {
      return {
        key: step.key,
        label: step.label,
        kind: "branch" as const,
        ...pickLoc(step),
        children: expandSteps(
          step.children,
          index,
          depth,
          maxDepth,
          visiting,
          owner,
        ),
      };
    }
    return expandCall(
      step.key,
      index,
      depth,
      maxDepth,
      visiting,
      step.children,
      step,
      undefined,
      owner,
    );
  });
}

/** A written call step: positional source text, plus the AST material for it. */
type CallSiteStep = Extract<CallStep, { type: "call" }>;

/** Definition location for a resolved call, or nothing when unresolved. */
function definitionLoc(info: FunctionInfo | undefined): SourceLoc | undefined {
  if (!info || info.line == null) return undefined;
  const loc: SourceLoc = { file: info.file, line: info.line };
  // Only a multi-line definition carries an end: a single line says so once.
  if (info.endLine != null && info.endLine !== info.line) loc.endLine = info.endLine;
  return loc;
}

/** Attach the resolved definition to a node without an empty spread. */
function withDefinition(node: CallNode, definition: SourceLoc | undefined): CallNode {
  if (definition) node.definition = definition;
  return node;
}

function expandCall(
  key: string,
  index: FunctionIndex,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  inlineChildren?: CallStep[],
  callSite?: CallSiteStep,
  /** When set, expand this body even if another definition owns the bare key. */
  infoOverride?: FunctionInfo,
  /** Definition this call was read from, used to scope call resolution. */
  owner?: FunctionInfo,
): CallNode {
  const info = infoOverride ?? resolveCall(key, index, callSite, owner);
  const label = displayCallLabel(key, index, info);
  const definition = definitionLoc(info);

  // Recursion is per definition, not per name: two same-named functions in
  // different files calling each other is not a cycle.
  const token = info ? fileScopedKey(info.file, info.key) : key;

  // Root uses the definition start line; every other node uses the call-site in the parent.
  const loc =
    depth === 0 && info?.line != null
      ? pickLoc({ file: info.file, line: info.line })
      : pickLoc(callSite);

  // Body steps a further expansion would have produced; the caller can tell a
  // depth cut from an unresolvable callee by their presence.
  const bodySteps = info?.steps.length;

  if (depth >= maxDepth) {
    return withContext(
      withDefinition({ key, label, kind: "call", ...loc, children: [] }, definition),
      callContextFor(
        callSite,
        info,
        callResolution(info, callSite),
        bodySteps,
        inlineChildren?.length,
      ),
    );
  }

  if (!info && !inlineChildren?.length) {
    return withContext(
      withDefinition({ key, label, kind: "call", ...loc, children: [] }, definition),
      callContextFor(
        callSite,
        info,
        callResolution(info, callSite),
      ),
    );
  }

  if (info && visiting.has(token)) {
    // Still expand call-site JSX children; they are not a re-entry into `key`'s body.
    const callSiteChildren = inlineChildren?.length
      ? expandSteps(inlineChildren, index, depth + 1, maxDepth, visiting, owner)
      : [];
    return withContext(
      withDefinition({
        key,
        label: `${label} ⇄`,
        kind: "call",
        ...loc,
        children: callSiteChildren,
      }, definition),
      callContextFor(
        callSite,
        info,
        callResolution(info, callSite),
        bodySteps,
        inlineChildren?.length,
      ),
    );
  }

  if (info) visiting.add(token);
  const bodyChildren = info
    ? expandSteps(info.steps, index, depth + 1, maxDepth, visiting, info)
    : [];
  const callSiteChildren = inlineChildren?.length
    ? expandSteps(inlineChildren, index, depth + 1, maxDepth, visiting, owner)
    : [];
  if (info) visiting.delete(token);

  return withContext(
    withDefinition({
      key,
      label,
      kind: "call",
      ...loc,
      children: [...bodyChildren, ...callSiteChildren],
    }, definition),
    callContextFor(
      callSite,
      info,
      callResolution(info, callSite),
    ),
  );
}

/**
 * Expand a function into a nested call tree by following known definitions.
 */
export function buildCallTree(
  entryKey: string,
  index: FunctionIndex,
  maxDepth: number,
): CallNode {
  const resolved = resolveEntry(entryKey, index) ?? entryKey;
  return expandCall(resolved, index, 0, maxDepth, new Set());
}

/**
 * Expand a specific definition. Used by `reach` when several functions share a
 * bare key and first-wins indexing would otherwise hide all but one body.
 */
export function buildCallTreeFromInfo(
  info: FunctionInfo,
  index: FunctionIndex,
  maxDepth: number,
): CallNode {
  return expandCall(
    info.key,
    index,
    0,
    maxDepth,
    new Set(),
    undefined,
    undefined,
    info,
  );
}

/**
 * Every call site written in `info`'s own body as a one-level node: the callee's
 * definition is attached, but nothing is expanded below it. Branch nesting and
 * inline calls (arguments, callbacks, JSX) are flattened into the same list, so
 * a consumer that walks definitions itself sees each site exactly once and can
 * order them by source position.
 */
export function buildCallSitesFromInfo(
  info: FunctionInfo,
  index: FunctionIndex,
): CallNode[] {
  const sites: CallNode[] = [];
  const visiting = new Set([fileScopedKey(info.file, info.key)]);

  const walk = (steps: CallStep[]): void => {
    for (const step of steps) {
      if (step.type === "branch") {
        walk(step.children);
        continue;
      }
      sites.push(
        expandCall(step.key, index, 1, 1, visiting, undefined, step, undefined, info),
      );
      // Inline calls belong to the same body; emit them as sites too.
      if (step.children?.length) walk(step.children);
    }
  };

  walk(info.steps);
  return sites;
}

export function resolveEntry(
  entry: string,
  index: FunctionIndex,
): string | null {
  if (index.has(entry)) return entry;
  const stripped = entry.replace(/\(\)$/, "");
  if (index.has(stripped)) return stripped;

  const matches = [...index.keys()].filter(
    (key) =>
      key === entry ||
      key.endsWith(`.${entry}`) ||
      key === `new ${entry}`,
  );

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const exported = matches.filter((key) => index.get(key)?.exported);
    if (exported.length === 1) return exported[0]!;
    return matches.sort()[0]!;
  }

  return null;
}

function entryNameMatches(key: string, entry: string): boolean {
  return (
    key === entry ||
    key.endsWith(`.${entry}`) ||
    key === `new ${entry}`
  );
}

function sortDefinitions(fns: FunctionInfo[]): FunctionInfo[] {
  return [...fns].sort((a, b) => {
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

/**
 * Every definition that matches `entry` (including those shadowed in the
 * bare-key map). Prefer exact bare-key hits; otherwise Class.method / `new X`.
 * Order is stable by label, then file — independent of extract order.
 */
export function resolveAllEntries(
  entry: string,
  index: FunctionIndex,
): FunctionInfo[] {
  const stripped = entry.replace(/\(\)$/, "");
  const all = allFunctions(index);

  const exact = all.filter(
    (fn) => fn.key === entry || fn.key === stripped,
  );
  if (exact.length > 0) return sortDefinitions(exact);

  const matches = all.filter(
    (fn) =>
      entryNameMatches(fn.key, entry) || entryNameMatches(fn.key, stripped),
  );
  return sortDefinitions(matches);
}
