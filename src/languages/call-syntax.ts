/**
 * AST-side call metadata shared by every extractor: declared parameter lists,
 * the arguments as written, lexical scopes for target classification, and the
 * binder that pairs arguments with parameter slots.
 *
 * Nothing here invents a binding. A parameter slot is only named when the AST
 * says so, and every lossy step records a reason from {@link CALL_REASONS}
 * (spread, destructuring, unknown parameter list) instead of guessing.
 */
import {
  CALL_REASONS,
  MAX_ARGUMENT_CHARS,
  MAX_CALL_ARGUMENTS,
  type CallArgument,
  type CallArgumentMapping,
  type CallArgumentSyntax,
  type CallContext,
  type CallSyntax,
  type CallTargetKind,
  type DeclaredParams,
  type ParamSlot,
} from "../types.js";
import { childByType, namedChildren, type SyntaxNode } from "./types.js";

/* ------------------------------------------------------------------- text */

/**
 * Source text as written, cut to {@link MAX_ARGUMENT_CHARS}. The kept bytes are
 * untouched: no collapsing, trimming, or re-quoting, so a truncated expression
 * is still a byte-exact prefix of the source.
 */
export function cappedText(raw: string): Pick<CallArgument, "expression" | "truncated" | "originalLength"> {
  if (raw.length <= MAX_ARGUMENT_CHARS) return { expression: raw };
  return {
    expression: raw.slice(0, MAX_ARGUMENT_CHARS),
    truncated: true,
    originalLength: raw.length,
  };
}

/** Verbatim parameter list, parenthesised when the grammar omits the parens. */
export function parameterText(params: SyntaxNode | null): string {
  const raw = params?.text.trim() ?? "";
  if (raw === "") return "()";
  return raw.startsWith("(") ? raw : `(${raw})`;
}

/** Parameters known by text only: no slots, so binding stays unknown. */
export function textOnlyParams(text: string): DeclaredParams {
  return { text };
}

/* --------------------------------------------------- declared parameters */

/** Declared parameters of a JS/TS function, arrow, or method node. */
export function jsParameterList(params: SyntaxNode | null): DeclaredParams | undefined {
  if (!params) return undefined;
  const declaration: DeclaredParams = {
    text: parameterText(params), start: params.startIndex, end: params.endIndex,
  };
  if (params.hasError) return declaration;
  if (params.type === "identifier") {
    declaration.slots = [{ form: "positional", name: params.text, hasDefault: false }];
    return declaration;
  }
  if (params.type !== "formal_parameters") return declaration;
  const slots: ParamSlot[] = [];
  for (const parameter of namedChildren(params)) {
    if (parameter.type === "comment") continue;
    let part = parameter.childForFieldName("pattern") ?? parameter;
    const hasDefault = parameter.childForFieldName("value") !== null || part.type === "assignment_pattern";
    if (part.type === "assignment_pattern") part = part.childForFieldName("left") ?? part;
    // A written TypeScript `this` parameter is not a runtime argument slot.
    if (part.type === "this" || part.text === "this") continue;
    switch (part.type) {
      case "identifier":
      case "type_identifier":
        slots.push({ form: "positional", name: part.text, hasDefault });
        break;
      case "rest_pattern":
        slots.push({ form: "rest", name: childByType(part, "identifier")?.text ?? null });
        break;
      default:
        slots.push({ form: "pattern", hasDefault });
        break;
    }
  }
  declaration.slots = slots;
  return declaration;
}

/** Declared parameters of a Python function or lambda node. */
export function pythonParameterList(
  params: SyntaxNode | null,
): DeclaredParams | undefined {
  if (!params) return undefined;
  const text = parameterText(params);
  const provenance = { start: params.startIndex, end: params.endIndex };
  if (params.hasError) return { text, ...provenance };
  const slots: ParamSlot[] = [];
  let keywordOnly = false;

  for (const parameter of namedChildren(params)) {
    switch (parameter.type) {
      case "comment":
        continue;
      case "positional_separator":
        for (const slot of slots) {
          if (slot.form === "positional") slot.positionalOnly = true;
        }
        continue;
      case "keyword_separator":
        keywordOnly = true;
        continue;
      case "list_splat_pattern": {
        const name = childByType(parameter, "identifier");
        slots.push({ form: "rest", name: name?.text ?? null });
        keywordOnly = true;
        continue;
      }
      case "dictionary_splat_pattern": {
        const name = childByType(parameter, "identifier");
        slots.push({ form: "keyword-rest", name: name?.text ?? null });
        continue;
      }
      case "identifier":
        slots.push({
          form: keywordOnly ? "keyword" : "positional",
          name: parameter.text,
          hasDefault: false,
        });
        continue;
      case "default_parameter": {
        const name = parameter.childForFieldName("name");
        if (name) {
          slots.push({
            form: keywordOnly ? "keyword" : "positional",
            name: name.text,
            hasDefault: true,
          });
        }
        continue;
      }
      case "typed_parameter":
      case "typed_default_parameter": {
        const name =
          parameter.childForFieldName("name") ??
          namedChildren(parameter).find(
            (child) =>
              child.type === "identifier" ||
              child.type === "list_splat_pattern" ||
              child.type === "dictionary_splat_pattern",
          ) ??
          null;
        const hasDefault =
          parameter.childForFieldName("value") !== null ||
          parameter.type === "typed_default_parameter";
        if (name?.type === "list_splat_pattern") {
          slots.push({
            form: "rest",
            name: childByType(name, "identifier")?.text ?? null,
          });
          keywordOnly = true;
        } else if (name?.type === "dictionary_splat_pattern") {
          slots.push({
            form: "keyword-rest",
            name: childByType(name, "identifier")?.text ?? null,
          });
        } else if (name) {
          slots.push({
            form: keywordOnly ? "keyword" : "positional",
            name: name.text,
            hasDefault,
          });
        } else {
          slots.push({ form: "pattern", hasDefault });
        }
        continue;
      }
      default:
        // Nested Python parameter patterns have no single bindable name.
        slots.push({ form: "pattern", hasDefault: false });
        continue;
    }
  }

  return { text, slots, ...provenance };
}

/* -------------------------------------------------------------- arguments */

export interface ArgumentReadResult {
  args: CallArgumentSyntax[];
  /** Number of written arguments omitted by the extraction limit. */
  omitted: number;
}

function argument(
  position: number,
  role: CallArgumentSyntax["role"],
  raw: string,
  keyword?: string,
): CallArgumentSyntax {
  const text = cappedText(raw);
  const entry: CallArgumentSyntax = {
    position,
    role,
    expression: text.expression,
  };
  if (keyword !== undefined) entry.keyword = keyword;
  if (text.truncated) {
    entry.truncated = true;
    entry.originalLength = text.originalLength;
  }
  return entry;
}

function readWithinLimit(
  nodes: readonly SyntaxNode[],
  build: (node: SyntaxNode, position: number) => CallArgumentSyntax,
): ArgumentReadResult {
  const argumentsOnly = nodes.filter(node => node.type !== "comment");
  const args: CallArgumentSyntax[] = [];
  for (let index = 0; index < Math.min(argumentsOnly.length, MAX_CALL_ARGUMENTS); index++) {
    args.push(build(argumentsOnly[index], index + 1));
  }
  return { args, omitted: Math.max(0, argumentsOnly.length - MAX_CALL_ARGUMENTS) };
}

/** Arguments of a JS/TS call: positional expressions and spread elements. */
function readJsArguments(args: SyntaxNode | null): ArgumentReadResult | undefined {
  if (!args || args.hasError) return undefined;
  return readWithinLimit(namedChildren(args), (node, position) =>
    argument(
      position,
      node.type === "spread_element" ? "star" : "positional",
      node.text,
    ),
  );
}

/** Arguments of a Python call: positional, keyword, `*arg`, and `**arg`. */
function readPythonArguments(
  args: SyntaxNode | null,
): ArgumentReadResult | undefined {
  if (!args || args.hasError) return undefined;
  return readWithinLimit(namedChildren(args), (node, position) => {
    if (node.type === "keyword_argument") {
      const keyword = node.childForFieldName("name");
      return argument(
        position,
        "keyword",
        node.text,
        keyword?.text ?? undefined,
      );
    }
    if (node.type === "list_splat") return argument(position, "star", node.text);
    if (node.type === "dictionary_splat") {
      return argument(position, "star-star", node.text);
    }
    return argument(position, "positional", node.text);
  });
}

/**
 * Arguments of a call in a grammar where every named child of the argument
 * container is one written argument. Roles are positional: those grammars do
 * not declare keyword arguments, so nothing is read as named.
 */
function readPositionalArguments(
  args: SyntaxNode | null,
): ArgumentReadResult | undefined {
  if (!args || args.hasError) return undefined;
  return readWithinLimit(namedChildren(args), (node, position) =>
    argument(position, node.type === "spread_element" ? "star" : "positional", node.text),
  );
}

/** Argument-list containers of the grammars that declare one. */
const ARGUMENT_CONTAINERS = {
  arguments: true,
  argument_list: true,
  value_arguments: true,
  call_arguments: true,
  arguments_list: true,
} satisfies Record<string, true>;

const ARGUMENT_CONTAINER_TYPES = Object.keys(ARGUMENT_CONTAINERS);

/**
 * Syntax for a call in a grammar without scope analysis: the target is the
 * qualified name the extractor recognised, so its association with a definition
 * stays a heuristic (`candidate`) and arguments are never matched to parameters.
 * The arguments themselves are still read as written, because they come from
 * the call node and are not inferred.
 */
export function heuristicCallSyntax(
  callNode: SyntaxNode,
  callee: string,
): CallSyntax {
  const args = readPositionalArguments(
    argumentContainer(callNode, ARGUMENT_CONTAINER_TYPES),
  );
  return callee === "" ? dynamicSyntax(callee, args) : candidateSyntax(callee, args);
}

/** Nodes that only wrap a call's suffix, e.g. Kotlin's `callee(arg)` suffix. */
const CALL_SUFFIXES = {
  call_suffix: true,
  arguments_suffix: true,
} satisfies Record<string, true>;

/**
 * First named child whose type is one of `types` (a call's argument list).
 * A grammar that wraps the list in a call suffix is unwrapped only there, never
 * through another call node — `callee()()` must not pick up the inner list.
 */
function argumentContainer(
  node: SyntaxNode,
  types: readonly string[],
): SyntaxNode | null {
  const children = namedChildren(node);
  const direct = children.find((child) => types.includes(child.type));
  if (direct) return direct;
  const suffix = children.find((child) => Object.hasOwn(CALL_SUFFIXES, child.type));
  if (!suffix) return null;
  return namedChildren(suffix).find((child) => types.includes(child.type)) ?? null;
}

/* ---------------------------------------------------------------- binding */

export interface BoundArguments {
  mapping: CallArgumentMapping;
  /** Parameter name per argument, aligned with the argument list. */
  bound: (string | null)[];
  reasons: string[];
  /** At least one argument has no reliable parameter. */
  partial: boolean;
}

/**
 * Pair written arguments with declared slots. A slot is filled at most once and
 * only by a name the AST actually declares; anything else leaves the argument
 * unbound and marks the result partial with the reason why.
 */
export function bindArguments(
  params: DeclaredParams,
  args: readonly CallArgumentSyntax[],
): BoundArguments {
  const slots = params.slots ?? [];
  const bound: (string | null)[] = args.map(() => null);
  const filled = new Set<number>();
  const reasons: string[] = [];
  let partial = false;
  let cursor = 0;
  let spreadSeen = false;
  const named = args.some(
    (arg) => arg.role === "keyword" || arg.role === "star-star",
  );

  const bindPositional = (index: number): void => {
    if (spreadSeen) {
      // A spread of unknown length makes every later position unreliable.
      partial = true;
      reasons.push(CALL_REASONS.spreadArgument);
      return;
    }
    while (cursor < slots.length) {
      const slot = slots[cursor]!;
      if (slot.form === "keyword" || slot.form === "keyword-rest") {
        // Positional arguments cannot reach a keyword-only parameter.
        cursor = slots.length;
        break;
      }
      cursor++;
      if (slot.form === "positional") {
        bound[index] = slot.name;
        filled.add(cursor - 1);
        return;
      }
      if (slot.form === "rest") {
        cursor--;
        filled.add(cursor);
        if (slot.name) bound[index] = slot.name;
        reasons.push(CALL_REASONS.restBinding);
        return;
      }
      // Destructuring or unnamed slot: it takes the argument, names nothing.
      filled.add(cursor - 1);
      partial = true;
      reasons.push(CALL_REASONS.destructuredBinding);
      return;
    }
    partial = true;
    reasons.push(CALL_REASONS.extraArguments);
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.role === "keyword") {
      const match = slots.findIndex(
        (slot) =>
          (slot.form === "keyword" || (slot.form === "positional" && !slot.positionalOnly)) &&
          slot.name === arg.keyword,
      );
      if (match >= 0) {
        const slot = slots[match]!;
        if (slot.form === "positional" || slot.form === "keyword") {
          bound[index] = slot.name;
          if (filled.has(match)) {
            partial = true;
            reasons.push(CALL_REASONS.duplicateBinding);
          }
          filled.add(match);
          reasons.push(CALL_REASONS.keywordBinding);
          continue;
        }
      }
      const rest = slots.findIndex((slot) => slot.form === "keyword-rest");
      if (rest >= 0) {
        const slot = slots[rest]!;
        if (slot.form === "keyword-rest") {
          if (slot.name) bound[index] = slot.name;
          filled.add(rest);
          partial = true;
          reasons.push(CALL_REASONS.restBinding);
          continue;
        }
      }
      partial = true;
      reasons.push(CALL_REASONS.extraArguments);
      continue;
    }
    if (arg.role === "star") {
      spreadSeen = true;
      partial = true;
      reasons.push(CALL_REASONS.spreadArgument);
      continue;
    }
    if (arg.role === "star-star") {
      // Unknown keys may bind declared parameters or the keyword-rest slot.
      // Do not claim the whole dictionary maps to one of them.
      partial = true;
      reasons.push(CALL_REASONS.spreadArgument);
      continue;
    }
    bindPositional(index);
  }

  const result: BoundArguments = {
    mapping: partial ? "partial" : named ? "named" : "positional",
    bound,
    reasons: [...new Set(reasons)],
    partial,
  };
  return result;
}

/* --------------------------------------------------------------- context */

/** What the call tree learned about the callee's definition, if anything. */
export interface CallResolution {
  /** A definition was resolved for this call. */
  resolved: boolean;
  /** The resolved definition matches the lexical parameter AST in this file. */
  lexical: boolean;
}

/**
 * The public contract for one call site: the target expression as written, the
 * callee's declared list, and the arguments with their bindings.
 *
 * A candidate target keeps `mapping: "unknown"`: the association is a name
 * heuristic, so its bindings are never assumed.
 */
export function callContextFromSyntax(
  syntax: CallSyntax,
  params: DeclaredParams | undefined,
  resolution: CallResolution,
): CallContext {
  const reasons = new Set(syntax.reasons);
  let target: CallTargetKind = syntax.target;
  if (target === "lexical" && !resolution.lexical) {
    target = "candidate";
    reasons.add(CALL_REASONS.targetAmbiguous);
  }
  if (target === "candidate" && !resolution.resolved) {
    target = "unresolved";
    reasons.add(CALL_REASONS.targetNotIndexed);
  }

  const declared = params ?? syntax.params;
  const context: CallContext = {
    callee: syntax.callee,
    target,
    mapping: "unknown",
    completeness: "unavailable",
    reasons: [...reasons],
  };
  if (declared) context.parameters = declared.text;
  if (syntax.omittedArguments) context.omittedArguments = syntax.omittedArguments;

  const args = syntax.arguments;
  if (args === undefined) {
    reasons.add(CALL_REASONS.argumentsUnavailable);
    context.reasons = [...reasons];
    return context;
  }

  context.arguments = args.map((arg) => {
    const entry: CallArgument = {
      position: arg.position,
      expression: arg.expression,
    };
    if (arg.truncated) {
      entry.truncated = true;
      entry.originalLength = arg.originalLength;
    }
    return entry;
  });

  if (args.some((arg) => arg.truncated)) {
    reasons.add(CALL_REASONS.expressionTruncated);
  }

  if (target === "lexical" && declared?.slots) {
    const bound = bindArguments(declared, args);
    context.mapping = bound.mapping;
    for (const reason of bound.reasons) reasons.add(reason);
    for (let index = 0; index < bound.bound.length; index++) {
      const name = bound.bound[index];
      if (name) context.arguments[index]!.parameter = name;
    }
  } else {
    reasons.add(CALL_REASONS.bindingUnavailable);
  }

  const incomplete =
    context.mapping === "unknown" ||
    (args.some((arg) => arg.truncated) ?? false) ||
    reasons.has(CALL_REASONS.argumentsTruncated) ||
    reasons.has(CALL_REASONS.spreadArgument) ||
    reasons.has(CALL_REASONS.destructuredBinding) ||
    reasons.has(CALL_REASONS.extraArguments) ||
    reasons.has(CALL_REASONS.duplicateBinding) ||
    reasons.has(CALL_REASONS.bindingUnavailable);
  context.reasons = [...reasons];
  context.completeness = incomplete ? "partial" : "complete";
  return context;
}

/** Syntax for a target the extractor cannot associate with any declaration. */
export function dynamicSyntax(
  callee: string,
  args: ArgumentReadResult | undefined,
  reasons: readonly string[] = [CALL_REASONS.dynamicCallee],
): CallSyntax {
  return syntaxFromParts(callee, "unresolved", args, reasons);
}

/** Syntax for a target whose binding is a name/member heuristic. */
export function candidateSyntax(
  callee: string,
  args: ArgumentReadResult | undefined,
  reasons: readonly string[] = [],
): CallSyntax {
  return syntaxFromParts(callee, "candidate", args, reasons);
}

/** Syntax for a target a declaration in this file actually binds. */
export function lexicalSyntax(
  callee: string,
  params: DeclaredParams | undefined,
  args: ArgumentReadResult | undefined,
  reasons: readonly string[] = [],
): CallSyntax {
  const syntax = syntaxFromParts(callee, "lexical", args, reasons);
  if (params) syntax.params = params;
  return syntax;
}

function syntaxFromParts(
  callee: string,
  target: CallTargetKind,
  args: ArgumentReadResult | undefined,
  reasons: readonly string[],
): CallSyntax {
  const text = cappedText(callee);
  const syntax: CallSyntax = {
    callee: text.expression,
    target,
    reasons: [...new Set(reasons)],
  };
  if (text.truncated) syntax.reasons.push(CALL_REASONS.expressionTruncated);
  if (args !== undefined) {
    syntax.arguments = args.args;
    if (args.omitted) {
      syntax.omittedArguments = args.omitted;
      syntax.reasons.push(CALL_REASONS.argumentsTruncated);
    }
  }
  return syntax;
}

/* ---------------------------------------------------------------- scopes */

/** One binding a lexical analysis found in the source. */
export interface LocalBinding {
  callable: boolean;
  params?: DeclaredParams;
  kind: "function" | "param" | "local" | "import" | "class";
}

/** A lexical scope; lookups walk outward through `parent`. */
export interface Scope {
  bindings: Map<string, LocalBinding>;
  parent: Scope | null;
  /** File-local syntactic writes, not inferred execution order or values. */
  writes: Set<string>;
}

export function newScope(parent: Scope | null = null): Scope {
  return { bindings: new Map(), parent, writes: parent?.writes ?? new Set() };
}

export function scopeLookup(
  scope: Scope | null,
  name: string,
): LocalBinding | undefined {
  for (let current = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function declare(scope: Scope, name: string, binding: LocalBinding): void {
  // Repeated declarations or assignments make this association ambiguous.
  scope.bindings.set(name, scope.bindings.has(name) ? { callable: false, kind: "local" } : binding);
}

/** A possibly reassigned name cannot prove one callable signature. */
function collectWrites(root: SyntaxNode, writes: Set<string>): void {
  const record = (node: SyntaxNode | null): void => {
    if (!node) return;
    if (node.type === "identifier" || node.type === "shorthand_property_identifier_pattern") {
      writes.add(node.text);
      return;
    }
    for (const child of namedChildren(node)) record(child);
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "assignment_expression":
      case "augmented_assignment_expression":
      case "assignment":
      case "augmented_assignment":
      case "named_expression":
        record(node.childForFieldName("left") ?? node.childForFieldName("name"));
        break;
      case "update_expression":
        record(node.childForFieldName("argument"));
        break;
    }
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (child) visit(child);
    }
  };
  visit(root);
}

/** Binding patterns shadow names even when no single parameter name exists. */
function shadowPattern(node: SyntaxNode | null, scope: Scope, kind: "param" | "local"): void {
  if (!node) return;
  if (node.type === "identifier" || node.type === "shorthand_property_identifier_pattern") {
    declare(scope, node.text, { callable: false, kind });
    return;
  }
  for (const child of namedChildren(node)) shadowPattern(child, scope, kind);
}

/* ------------------------------------------------------ JavaScript scopes */

const JS_FUNCTION_NODES = {
  function_declaration: true,
  generator_function_declaration: true,
  function_expression: true,
  generator_function: true,
  arrow_function: true,
  method_definition: true,
} satisfies Record<string, true>;

function declaredName(node: SyntaxNode): string | null {
  const name =
    node.childForFieldName("name") ??
    childByType(node, "identifier") ??
    childByType(node, "type_identifier") ??
    childByType(node, "property_identifier");
  return name?.text ?? null;
}

function jsFunctionValueParams(value: SyntaxNode | null): DeclaredParams | undefined {
  if (!value || !Object.hasOwn(JS_FUNCTION_NODES, value.type)) return undefined;
  if (value.type === "method_definition") {
    return jsParameterList(childByType(value, "formal_parameters"));
  }
  return jsParameterList(childByType(value, "formal_parameters") ?? value.childForFieldName("parameter"));
}

/** Body declarations of one JS function/arrow: `const`, `function`, `class`. */
function jsBodyBindings(body: SyntaxNode | null, scope: Scope): void {
  if (!body) return;
  const walk = (node: SyntaxNode): void => {
    for (const child of namedChildren(node)) {
      if (Object.hasOwn(JS_FUNCTION_NODES, child.type)) {
        const name = declaredName(child);
        if (
          name &&
          (child.type === "function_declaration" ||
            child.type === "generator_function_declaration")
        ) {
          declare(scope, name, {
            callable: node === body,
            params: jsFunctionValueParams(child),
            kind: "function",
          });
        }
        continue; // never attribute a nested body's locals to this scope
      }
      if (child.type === "assignment_expression" || child.type === "augmented_assignment_expression") {
        shadowPattern(child.childForFieldName("left"), scope, "local");
        continue;
      }
      if (child.type === "catch_clause" || child.type === "for_in_statement") {
        shadowPattern(child.childForFieldName("parameter") ?? child.childForFieldName("left"), scope, "local");
      }
      if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (const declarator of namedChildren(child)) {
          if (declarator.type !== "variable_declarator") continue;
          if (node === body) declareDeclarator(declarator, scope);
          else shadowPattern(declarator.childForFieldName("name"), scope, "local");
        }
        continue;
      }
      if (child.type === "class_declaration" || child.type === "class") {
        const name = declaredName(child);
        if (name) declare(scope, name, { callable: true, kind: "class" });
        continue;
      }
      walk(child);
    }
  };
  walk(body);
}

/** Params and body declarations of one JS function/arrow/method node. */
export function jsFunctionScope(
  node: SyntaxNode,
  parent: Scope | null,
): Scope {
  const scope = newScope(parent);
  const paramsNode = childByType(node, "formal_parameters") ?? node.childForFieldName("parameter");
  shadowPattern(paramsNode, scope, "param");
  jsBodyBindings(childByType(node, "statement_block"), scope);
  return scope;
}

function importBindings(clause: SyntaxNode | null, scope: Scope): void {
  if (!clause) return;
  const add = (name: string | null): void => {
    if (name) declare(scope, name, { callable: true, kind: "import" });
  };
  for (const child of namedChildren(clause)) {
    if (child.type === "identifier") {
      add(child.text);
      continue;
    }
    if (child.type === "namespace_import") {
      add(childByType(child, "identifier")?.text ?? null);
      continue;
    }
    if (child.type === "named_imports") {
      for (const specifier of namedChildren(child)) {
        if (specifier.type !== "import_specifier") continue;
        const alias = specifier.childForFieldName("alias");
        const name = specifier.childForFieldName("name");
        add(alias?.text ?? name?.text ?? null);
      }
    }
  }
}

/**
 * What one variable declaration binds: a callable when its value is a
 * function/arrow, a class name, otherwise a plain local that shadows the name.
 */
function declareDeclarator(declarator: SyntaxNode, scope: Scope): void {
  const pattern = declarator.childForFieldName("name");
  if (pattern?.type !== "identifier") {
    shadowPattern(pattern, scope, "local");
    return;
  }
  const name = pattern.text;
  const value =
    declarator.childForFieldName("value") ??
    namedChildren(declarator).at(-1) ??
    null;
  if (value && Object.hasOwn(JS_FUNCTION_NODES, value.type)) {
    declare(scope, name, {
      callable: true,
      params: jsFunctionValueParams(value),
      kind: "function",
    });
  } else if (value?.type === "class") {
    declare(scope, name, { callable: true, kind: "class" });
  } else {
    declare(scope, name, { callable: false, kind: "local" });
  }
}

/**
 * Module bindings of a JS/TS file: declarations and imports. Each statement is
 * classified on its own, and an `export` is classified as what it declares.
 */
export function jsModuleScope(root: SyntaxNode): Scope {
  const scope = newScope();
  collectWrites(root, scope.writes);

  const declareStatement = (node: SyntaxNode): void => {
    switch (node.type) {
      case "import_statement":
        importBindings(childByType(node, "import_clause"), scope);
        return;
      case "export_statement": {
        const declaration = node.childForFieldName("declaration");
        if (declaration) declareStatement(declaration);
        return;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name = declaredName(node);
        if (name) {
          declare(scope, name, {
            callable: true,
            params: jsFunctionValueParams(node),
            kind: "function",
          });
        }
        return;
      }
      case "class_declaration":
      case "class": {
        const name = declaredName(node);
        if (name) declare(scope, name, { callable: true, kind: "class" });
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        for (const declarator of namedChildren(node)) {
          if (declarator.type !== "variable_declarator") continue;
          declareDeclarator(declarator, scope);
        }
        return;
      }
      case "expression_statement": {
        const assignment = node.namedChild(0);
        if (assignment?.type === "assignment_expression" || assignment?.type === "augmented_assignment_expression") {
          shadowPattern(assignment.childForFieldName("left"), scope, "local");
        }
        return;
      }
      default:
        return;
    }
  };

  for (const child of namedChildren(root)) declareStatement(child);
  return scope;
}


/* ---------------------------------------------------------- JS/TS callees */

export interface CalleeTarget {
  callee: string;
  target: CallTargetKind;
  params?: DeclaredParams;
  reasons: string[];
}

/** Everything a JS/TS extraction knows at one call site. */
export interface JsEnv {
  scope: Scope;
  className: string | null;
}

function shadowReasons(binding: LocalBinding | undefined): string[] {
  if (!binding || binding.callable) return [];
  return [
    binding.kind === "param"
      ? CALL_REASONS.parameterShadow
      : CALL_REASONS.localShadow,
  ];
}

function stripJsParens(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === "parenthesized_expression") {
    const inner = current.namedChild(0);
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/**
 * Classify plain, unambiguous declarations lexically. Imports and member
 * dispatch remain candidates because this extractor does not resolve them.
 */
export function classifyJsCallee(node: SyntaxNode, env: JsEnv): CalleeTarget {
  const callee = node.text;
  const targetNode = stripJsParens(node);
  if (targetNode.type === "identifier") {
    const binding = scopeLookup(env.scope, targetNode.text);
    if (env.scope.writes.has(targetNode.text)) return { callee, target: "candidate", reasons: [CALL_REASONS.localShadow] };
    if (binding?.callable && binding.kind === "function" && binding.params) {
      return { callee, target: "lexical", params: binding.params, reasons: [] };
    }
    return { callee, target: "candidate", reasons: shadowReasons(binding) };
  }
  if (targetNode.type === "member_expression") {
    return { callee, target: "candidate", reasons: [] };
  }
  return { callee, target: "unresolved", reasons: [CALL_REASONS.dynamicCallee] };
}

/* ------------------------------------------------------ JavaScript syntax */

/** Classified target plus arguments of one JS/TS call site. */
export function jsCallSyntax(
  calleeNode: SyntaxNode | null,
  argsNode: SyntaxNode | null,
  env: JsEnv,
): CallSyntax | undefined {
  if (!calleeNode) return undefined;
  const target = classifyJsCallee(calleeNode, env);
  const args = readJsArguments(argsNode);
  return target.target === "lexical"
    ? lexicalSyntax(target.callee, target.params, args, target.reasons)
    : target.target === "candidate"
      ? candidateSyntax(target.callee, args, target.reasons)
      : dynamicSyntax(target.callee, args, target.reasons);
}

/* ---------------------------------------------------------- Python scopes */

function pythonParamsOf(node: SyntaxNode): DeclaredParams | undefined {
  const params =
    node.childForFieldName("parameters") ??
    childByType(node, "parameters") ??
    childByType(node, "lambda_parameters");
  return pythonParameterList(params);
}

function pythonImportNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of namedChildren(node)) {
    if (child.type === "aliased_import") {
      const alias = child.childForFieldName("alias");
      if (alias) names.push(alias.text);
      continue;
    }
    if (child.type === "dotted_name") {
      if (node.type === "import_from_statement" && child === node.childForFieldName("module_name")) {
        continue;
      }
      names.push(namedChildren(child)[0]?.text ?? child.text);
      continue;
    }
  }
  return names;
}

/** Names a Python body assigns, plus defs and lambdas it declares. */
function pythonBodyBindings(body: SyntaxNode | null, scope: Scope): void {
  if (!body) return;
  const assign = (target: SyntaxNode | null): void => {
    if (!target) return;
    if (target.type === "identifier") {
      declare(scope, target.text, { callable: false, kind: "local" });
      return;
    }
    for (const child of namedChildren(target)) assign(child);
  };

  const walk = (node: SyntaxNode): void => {
    for (const child of namedChildren(node)) {
      switch (child.type) {
        case "decorated_definition": {
          const declaration = childByType(child, "function_definition");
          const name = declaration?.childForFieldName("name");
          if (name) declare(scope, name.text, { callable: false, kind: "local" });
          continue;
        }
        case "function_definition":
        case "lambda": {
          const name = childByType(child, "identifier")?.text;
          if (name && child.type === "function_definition") {
            declare(scope, name, {
              callable: true,
              params: pythonParamsOf(child),
              kind: "function",
            });
          }
          continue; // nested bodies have their own scope
        }
        case "class_definition": {
          const name = childByType(child, "identifier")?.text;
          if (name) declare(scope, name, { callable: true, kind: "class" });
          continue;
        }
        case "assignment":
          assign(child.childForFieldName("left"));
          continue;
        case "augmented_assignment":
        case "named_expression":
          assign(child.childForFieldName("left"));
          continue;
        case "for_statement":
          assign(child.childForFieldName("left"));
          break;
        case "with_item":
        case "except_clause": {
          const value = child.childForFieldName("value");
          if (value?.type === "as_pattern") {
            assign(value.childForFieldName("alias"));
          }
          break;
        }
        default:
          break;
      }
      walk(child);
    }
  };
  walk(body);
}

/** Params and body assignments of one Python function or lambda node. */
export function pythonFunctionScope(
  node: SyntaxNode,
  parent: Scope | null,
): Scope {
  const scope = newScope(parent);
  for (const slot of pythonParamsOf(node)?.slots ?? []) {
    if (slot.form === "positional" || slot.form === "keyword") {
      declare(scope, slot.name, { callable: false, kind: "param" });
    }
  }
  pythonBodyBindings(childByType(node, "block"), scope);
  return scope;
}

/** Module bindings of a Python file: defs, classes, imports, assignments. */
export function pythonModuleScope(root: SyntaxNode): Scope {
  const scope = newScope();
  collectWrites(root, scope.writes);
  for (const child of namedChildren(root)) {
    visitPythonModuleChild(child, scope);
  }
  return scope;
}

function visitPythonModuleChild(node: SyntaxNode, scope: Scope): void {
  switch (node.type) {
    case "decorated_definition": {
      const inner =
        childByType(node, "function_definition") ??
        childByType(node, "class_definition");
      const name = inner?.childForFieldName("name");
      if (name) declare(scope, name.text, { callable: false, kind: "local" });
      return;
    }
    case "function_definition": {
      const name = childByType(node, "identifier")?.text;
      if (name) {
        declare(scope, name, {
          callable: true,
          params: pythonParamsOf(node),
          kind: "function",
        });
      }
      return;
    }
    case "class_definition": {
      const name = childByType(node, "identifier")?.text;
      if (name) declare(scope, name, { callable: true, kind: "class" });
      return;
    }
    case "import_statement":
    case "import_from_statement": {
      for (const name of pythonImportNames(node)) {
        declare(scope, name, { callable: true, kind: "import" });
      }
      return;
    }
    case "expression_statement": {
      const assignment = childByType(node, "assignment");
      if (!assignment) return;
      const name = childByType(assignment, "identifier")?.text;
      if (!name) return;
      const value = assignment.childForFieldName("right");
      if (value?.type === "lambda") {
        declare(scope, name, {
          callable: true,
          params: pythonParamsOf(value),
          kind: "function",
        });
      } else {
        declare(scope, name, { callable: false, kind: "local" });
      }
      return;
    }
    default:
      return;
  }
}


/* -------------------------------------------------------- Python callees */

export interface PythonEnv {
  scope: Scope;
  className: string | null;
}

/** Python imports, decorators, and member dispatch do not establish a target. */
export function classifyPythonCallee(node: SyntaxNode, env: PythonEnv): CalleeTarget {
  const callee = node.text;
  const targetNode = stripJsParens(node);
  if (targetNode.type === "identifier") {
    const binding = scopeLookup(env.scope, targetNode.text);
    if (env.scope.writes.has(targetNode.text)) return { callee, target: "candidate", reasons: [CALL_REASONS.localShadow] };
    if (binding?.callable && binding.kind === "function" && binding.params) {
      return { callee, target: "lexical", params: binding.params, reasons: [] };
    }
    return { callee, target: "candidate", reasons: shadowReasons(binding) };
  }
  if (targetNode.type === "attribute") return { callee, target: "candidate", reasons: [] };
  return { callee, target: "unresolved", reasons: [CALL_REASONS.dynamicCallee] };
}

/** Classified target plus arguments of one Python call site. */
export function pythonCallSyntax(
  calleeNode: SyntaxNode | null,
  argsNode: SyntaxNode | null,
  env: PythonEnv,
): CallSyntax | undefined {
  if (!calleeNode) return undefined;
  const target = classifyPythonCallee(calleeNode, env);
  const args = readPythonArguments(argsNode);
  return target.target === "lexical"
    ? lexicalSyntax(target.callee, target.params, args, target.reasons)
    : target.target === "candidate"
      ? candidateSyntax(target.callee, args, target.reasons)
      : dynamicSyntax(target.callee, args, target.reasons);
}
