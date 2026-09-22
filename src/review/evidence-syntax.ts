/**
 * Tree-sitter views of one definition's own source, used by the automatic
 * evidence checks.
 *
 * The checks read definitions from snapshot indexes rather than whole files, so
 * every parse starts from a single definition's text. A member definition is
 * not a valid module on its own, so a container and a binding wrapper are
 * retried before a fragment is reported unsupported: a fragment no attempt
 * parses contributes no body, no return type, and no shape, and the caller says
 * which definitions were left out instead of guessing.
 *
 * Every helper here is syntax-only. Nothing resolves a name to a value: a
 * return type, a declared field, or a parameter binding is what the grammar
 * wrote, and call/argument answers stay with the extractor indexes the checks
 * already read.
 */
import Parser from "tree-sitter";
import {
  loadGrammarPackage,
  resolveLanguage,
  type GrammarLanguage,
} from "../languages/grammars.js";
import { detectLanguage } from "../languages/registry.js";
import { collapseWs, type SyntaxNode, type Tree } from "../languages/types.js";

const parser = new Parser();

/** One grammar handle, or a confirmed failure that must not be retried. */
const grammars = new Map<string, GrammarLanguage | null>();

function languageFor(file: string): GrammarLanguage | null {
  const extractor = detectLanguage(file);
  if (!extractor) return null;
  const key = extractor.grammarExport
    ? `${extractor.grammarPackage}:${extractor.grammarExport}`
    : extractor.grammarPackage;
  const cached = grammars.get(key);
  if (cached !== undefined) return cached;
  let language: GrammarLanguage | null = null;
  try {
    language = resolveLanguage(
      loadGrammarPackage(extractor.grammarPackage),
      extractor.grammarExport,
    );
  } catch {
    // A grammar that cannot be installed or loaded leaves its definitions
    // unchecked; the checks report them as unsupported rather than failing.
    language = null;
  }
  grammars.set(key, language);
  return language;
}

/**
 * Literal text that only parses inside a container, so a class member or a
 * bare function value can be parsed at all. The wrapper names cannot collide
 * with an extracted definition: no definition span contains them.
 */
const CONTAINER_WRAPPER = (source: string) =>
  `class __diffninjaEvidenceContainer {\n${source}\n}`;
const BINDING_WRAPPER = (source: string) =>
  `const __diffninjaEvidenceBinding = ${source};`;

/** A fragment parsed without syntax errors, and the row shift a wrapper added. */
export interface FragmentParse {
  tree: Tree;
  /**
   * Rows of the parse above the fragment's first line: 1 after the container
   * wrapper, 0 for the text as written. Callers convert a node row to a source
   * line by subtracting this from the row and adding the definition's line.
   */
  lineOffset: number;
}

/**
 * Parse one definition fragment, trying the text as written first and then the
 * two wrappers above. The first attempt whose whole tree is error-free wins, so
 * the same fragment always yields the same tree.
 */
export function parseFragment(file: string, text: string): FragmentParse | null {
  const language = languageFor(file);
  if (language === null) return null;
  const source = text.trim();
  if (source === "") return null;
  const attempts = [
    { source, lineOffset: 0 },
    { source: CONTAINER_WRAPPER(source), lineOffset: 1 },
    { source: BINDING_WRAPPER(source), lineOffset: 0 },
  ];
  for (const attempt of attempts) {
    let tree: Tree | null = null;
    try {
      // @ts-expect-error tree-sitter Language under-specifies grammar module exports
      parser.setLanguage(language);
      tree = parser.parse(attempt.source);
    } catch {
      // A grammar that rejects this fragment leaves nothing to read here.
      tree = null;
    }
    if (tree === null || tree.rootNode.hasError) continue;
    return { tree, lineOffset: attempt.lineOffset };
  }
  return null;
}

/** Imports in a module prefix; an unfinished following class does not invalidate preceding imports. */
export function moduleImports(file: string, prefix: string): Map<string, string> | null {
  const language = languageFor(file);
  if (language === null) return null;
  let tree: Tree;
  try {
    // @ts-expect-error tree-sitter Language under-specifies grammar module exports
    parser.setLanguage(language);
    tree = parser.parse(prefix);
  } catch {
    return null;
  }
  const imports = new Map<string, string>();
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== "import_statement" || node.hasError) continue;
    const clause = node.namedChildren.find(child => child.type === "import_clause");
    const literal = node.childForFieldName("source");
    const module = literal?.namedChildren.find(child => child.type === "string_fragment")?.text;
    if (!clause || module === undefined) continue;
    for (const child of clause.namedChildren) {
      if (child.type === "identifier") imports.set(child.text, module);
      if (child.type === "namespace_import") {
        const local = child.namedChildren.find(entry => entry.type === "identifier");
        if (local) imports.set(local.text, module);
      }
      if (child.type !== "named_imports") continue;
      for (const specifier of child.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        const local = specifier.childForFieldName("alias") ?? specifier.childForFieldName("name");
        if (local) imports.set(local.text, module);
      }
    }
  }
  return imports;
}

/* ------------------------------------------------------------------ bodies */

/**
 * Bodies that belong to a container rather than to a definition. `block` is
 * deliberately absent: it is a function body in grammars that have no
 * `statement_block`, and a nested control-flow block is always smaller.
 */
const CONTAINER_BODIES = {
  class_body: true,
  interface_body: true,
  enum_body: true,
  declaration_list: true,
  field_declaration_list: true,
  struct_body: true,
  trait_body: true,
  impl_body: true,
  namespace_body: true,
  module_body: true,
  object_type: true,
  program: true,
  translation_unit: true,
  source_file: true,
  compilation_unit: true,
  script: true,
} satisfies Record<string, true>;

/** A function-like node and the body its grammar gives it. */
export interface DefinitionSyntax {
  definition: SyntaxNode;
  body: SyntaxNode;
}

/**
 * The definition's own body. The fragment holds either the definition itself or
 * one wrapper (a class the member was written in, or a binding the function
 * value was assigned to), so the outermost node with a callable body is the
 * definition being read. Breadth-first order picks the shallowest one, which
 * keeps a large nested callback inside a default parameter from being taken for
 * the definition's body, and ties are broken by position, so the choice is
 * stable.
 */
export function definitionSyntax(fragment: FragmentParse): DefinitionSyntax | null {
  let level: SyntaxNode[] = [fragment.tree.rootNode];
  while (level.length > 0) {
    const next: SyntaxNode[] = [];
    for (const node of level) {
      const body = node.childForFieldName("body");
      if (body && !Object.hasOwn(CONTAINER_BODIES, body.type)) return { definition: node, body };
      next.push(...node.children);
    }
    level = next;
  }
  return null;
}

/**
 * Comment-free token stream of a body: leaf text in source order, one space
 * between tokens. Formatting and comments are gone; every literal and operator
 * is kept exactly as written, so two bodies match only when their tokens do.
 */
export function bodyTokenSignature(body: SyntaxNode): string {
  const tokens: string[] = [];
  const walk = (node: SyntaxNode): void => {
    if (node.childCount === 0) {
      const type = node.type;
      if (type !== "comment" && !type.endsWith("_comment")) tokens.push(node.text);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(body);
  return tokens.join(" ");
}

/* ------------------------------------------------------------- annotations */

/** Declared response type name of a definition's return annotation, if any. */
export function returnedResponseType(definition: SyntaxNode): string | null {
  return declaredResponseType(definition.childForFieldName("return_type"), true);
}

/** One field declared in an interface or type-alias object. */
export interface ContractField {
  name: string;
  type: string;
}

/** Declared fields written in one object literal type; empty when there are none. */
function objectFields(objectNode: SyntaxNode): ContractField[] {
  const fields: ContractField[] = [];
  for (const member of objectNode.namedChildren) {
    if (member.type !== "property_signature") continue;
    const name = member.childForFieldName("name");
    const annotation = member.childForFieldName("type");
    if (!name || !annotation) continue;
    // A property signature's `type` field is the annotation node, which still
    // carries its colon; the declared type is the node inside it.
    const type = annotation.type === "type_annotation"
      ? annotation.namedChildren[0] ?? annotation
      : annotation;
    fields.push({ name: name.text, type: collapseWs(type.text) });
  }
  return fields;
}

/** Wrapper type names whose single type argument is the declared response. */
const RESPONSE_WRAPPERS = { Promise: true, Awaited: true, Readonly: true } satisfies Record<string, true>;

/**
 * The declared response type name of a type annotation, or null when the
 * annotation declares something else. Only a plain name (`CreateResult`) or a
 * known async/readonly wrapper of one (`Promise<CreateResult>`) is a response:
 * an array of them (`CreateResult[]`), an arbitrary generic
 * (`Wrapper<CreateResult>`), a union, or a function type is a different thing,
 * and this check must not treat it as holding one response.
 */
export function declaredResponseType(
  annotation: SyntaxNode | null | undefined,
  awaited = false,
): string | null {
  if (!annotation) return null;
  const inner = annotation.type === "type_annotation" ? annotation.namedChildren[0] : annotation;
  if (!inner) return null;
  if (inner.type === "type_identifier" || inner.type === "identifier") return inner.text;
  // `Promise<CreateResult>` is the response only where the code awaits it: an
  // async definition's declared return, and a call whose result is awaited.
  // A parameter or local declared as a Promise holds the pending value itself.
  if (inner.type === "generic_type") {
    if (!awaited) return null;
    const name = inner.childForFieldName("name");
    const args = inner.childForFieldName("type_arguments");
    if (!name || !args || !Object.hasOwn(RESPONSE_WRAPPERS, name.text)) return null;
    const parameters = args.namedChildren;
    if (parameters.length !== 1) return null;
    return declaredResponseType(parameters[0], true);
  }
  if (inner.type === "type_annotation") return declaredResponseType(inner.namedChildren[0], awaited);
  return null;
}

/** Name a declaration node declares, or null when it names none. */
function declarationName(node: SyntaxNode): string | null {
  return (
    node.childForFieldName("name")?.text ??
    node.namedChildren.find(child => child.type === "type_identifier")?.text ??
    null
  );
}

/**
 * Declared fields of the named interface or type alias in a fragment, or null
 * when that declaration is not the one the fragment holds. The name is required
 * because one line can carry several declarations: a fragment read for `B` that
 * holds both `A` and `B` must never report `A`'s fields as `B`'s. `extends` and
 * intersections are not followed, so this is only ever the fields written in the
 * declaration itself; an empty array means it writes no field, which is a
 * different answer from a declaration nobody could read.
 */
export function contractFields(fragment: FragmentParse, name: string): ContractField[] | null {
  const declarations: SyntaxNode[] = [];
  walkSyntax(fragment.tree.rootNode, node => {
    if (node.type === "interface_declaration" || node.type === "type_alias_declaration") {
      declarations.push(node);
    }
  });
  const matches = declarations.filter(declaration => declarationName(declaration) === name);
  if (matches.length !== 1) return null;
  const declaration = matches[0];
  if (declaration.type === "interface_declaration") {
    const body = declaration.childForFieldName("body");
    return body ? objectFields(body) : null;
  }
  const value = declaration.childForFieldName("value");
  return value && value.type === "object_type" ? objectFields(value) : null;
}

/* --------------------------------------------------------------- bindings */

/** A name a response value is bound to, and where the binding was written. */
export interface TypedBinding {
  name: string;
  /** 0-based row inside the parsed fragment. */
  row: number;
}

/** Nodes that declare a named value with an explicit type annotation. */
const TYPED_BINDING_NODES = {
  required_parameter: true,
  optional_parameter: true,
  parameter: true,
  typed_parameter: true,
  variable_declarator: true,
  public_field_definition: true,
  property_declaration: true,
} satisfies Record<string, true>;

/**
 * Names declared with a type annotation that names `typeName`: a parameter, a
 * local, or a class field. Only a plainly named binding is returned; a
 * destructuring pattern is left out, because its fields are read positions
 * rather than one value the checks can follow.
 */
export function typedBindings(
  definition: SyntaxNode,
  typeName: string,
): TypedBinding[] {
  const bindings: TypedBinding[] = [];
  const walk = (node: SyntaxNode): void => {
    if (Object.hasOwn(TYPED_BINDING_NODES, node.type)) {
      const annotation = node.childForFieldName("type");
      if (declaredResponseType(annotation) === typeName) {
        const pattern =
          node.childForFieldName("pattern") ??
          node.childForFieldName("name") ??
          node.childForFieldName("left");
        if (pattern?.type === "identifier") {
          bindings.push({ name: pattern.text, row: pattern.startPosition.row });
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(definition);
  return bindings;
}

/** Every node in the fragment, in pre-order. */
export function walkSyntax(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(root);
  for (const child of root.children) walkSyntax(child, visit);
}

/** Properties whose read reports how many items a value holds. */
const COUNT_PROPERTIES = { length: true, size: true, count: true } satisfies Record<string, true>;

/**
 * The value one expression counts, when the expression is a count-named read.
 * `users.length` counts the binding `users`; `result.users.length` counts the
 * field `users` read off the binding `result`. Both shapes report a number, and
 * nothing else does: a plain `.length` on a call or an element access is not
 * attributed to a binding, because the checks only follow named values.
 */
export interface CountRead {
  /** Expression that reports the count, e.g. `result.users.length`. */
  read: SyntaxNode;
  /** Name of the value counted, e.g. `users`. */
  value: string;
  /** Whether the value is a field read off another name rather than a binding. */
  ofField: boolean;
}

export function countReadOf(node: SyntaxNode): CountRead | null {
  if (node.type !== "member_expression") return null;
  const property = node.childForFieldName("property");
  if (property?.type !== "property_identifier" || !Object.hasOwn(COUNT_PROPERTIES, property.text)) return null;
  const object = node.childForFieldName("object");
  if (!object) return null;
  if (object.type === "identifier") return { read: node, value: object.text, ofField: false };
  if (object.type !== "member_expression") return null;
  const owner = object.childForFieldName("object");
  const field = object.childForFieldName("property");
  if (owner?.type !== "identifier" || field?.type !== "property_identifier") return null;
  return { read: node, value: field.text, ofField: true };
}

/**
 * First count-named read inside a `return`, which is the number a receiver hands
 * back to its own caller. That is the count a partial-failure question is about,
 * more than any diagnostic log written after it.
 */
export function returnedCountRead(definition: SyntaxNode): CountRead | null {
  let found: CountRead | null = null;
  walkSyntax(definition, node => {
    if (found || node.type !== "return_statement") return;
    walkSyntax(node, inner => {
      if (found) return;
      const count = countReadOf(inner);
      if (count) found = count;
    });
  });
  return found;
}

/** Whole camel-case words that name a lifecycle or state value, never a part. */
const STATE_WORDS = { status: true, state: true, stage: true, phase: true, lifecycle: true, mode: true } satisfies Record<string, true>;

/** Whether one identifier or property name says the value is state. */
function namesState(text: string): boolean {
  // `model` must not match `mode`, so words are compared whole at camel
  // boundaries: `leaseStatus` and `status` name state; `model` does not.
  const words = text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [text];
  return words.some(word => Object.hasOwn(STATE_WORDS, word.toLowerCase()));
}

/**
 * State/status properties in a call payload. A queue routing constant or a
 * state-looking word inside a string is not by itself a state assignment.
 */
export function stateWritesAt(call: SyntaxNode): string[] {
  const values = new Set<string>();
  const record = (key: SyntaxNode, value: SyntaxNode | null): void => {
    if (!namesState(key.text)) return;
    values.add(value ? `${key.text}: ${collapseWs(value.text)}` : key.text);
  };
  walkSyntax(call, node => {
    if (node.type !== "pair") return;
    record(node.childForFieldName("key") ?? node.namedChildren[0] ?? node, node.childForFieldName("value"));
  });
  return [...values];
}

/** Call expressions written in one definition, in source order. */
export function callsIn(definition: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  walkSyntax(definition, node => {
    if (node.type === "call_expression") calls.push(node);
  });
  return calls;
}

/**
 * Count-named reads in a body, in source order: the numbers a receiver reports,
 * which are what a partial-failure question compares with the failures it never
 * read.
 */
export function countReads(definition: SyntaxNode): CountRead[] {
  const reads: CountRead[] = [];
  walkSyntax(definition, node => {
    const count = countReadOf(node);
    if (count) reads.push(count);
  });
  return reads;
}

/**
 * Whether two node handles denote the same syntax node. Tree-sitter hands back
 * a fresh wrapper per field access, so `===` on handles is not a stable test:
 * two handles for one node can differ between calls. Node ids are stable within
 * one tree, which is what every structural question here compares.
 */
export function sameNode(left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left.id === right.id;
}

/** Node types that declare a name local to one definition's body. */
const VALUE_DECLARATIONS = {
  variable_declarator: true,
  required_parameter: true,
  optional_parameter: true,
  parameter: true,
  typed_parameter: true,
  rest_pattern: true,
  function_declaration: true,
  class_declaration: true,
  import_specifier: true,
} satisfies Record<string, true>;

/**
 * Names one definition declares for itself: its parameters, its locals, and any
 * nested declaration. A call written under one of these names reaches the local
 * value, not whatever definition elsewhere carries the same bare key, so a
 * caller-side check must not resolve through the shadow.
 */
export function declaredValueNames(definition: SyntaxNode): Set<string> {
  const names = new Set<string>();
  walkSyntax(definition, node => {
    if (!Object.hasOwn(VALUE_DECLARATIONS, node.type)) return;
    const declared =
      node.childForFieldName("name") ??
      node.childForFieldName("pattern") ??
      node.childForFieldName("left") ??
      node.childForFieldName("declarator");
    if (declared?.type === "identifier") names.add(declared.text);
    if (node.type === "rest_pattern") {
      const inner = node.namedChildren.find(child => child.type === "identifier");
      if (inner) names.add(inner.text);
    }
  });
  return names;
}

/** Value of a string literal node, or the raw text of any other node. */
export function staticStringValue(node: SyntaxNode): string {
  if (node.type === "string") {
    const fragment = node.namedChildren.find((c) => c.type === "string_fragment");
    return fragment ? fragment.text : "";
  }
  return node.text;
}
