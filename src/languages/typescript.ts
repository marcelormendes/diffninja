/**
 * TypeScript / TSX callable extraction (tree-sitter-typescript).
 */
import type {
  CallStep,
  CallSyntax,
  FunctionInfo,
} from "../types.js";
import {
  childByType,
  collapseWs,
  locFromNode,
  namedChildren,
  type LanguageExtractor,
  type SyntaxNode,
  type Tree,
} from "./types.js";
import {
  jsCallSyntax,
  jsFunctionScope,
  jsModuleScope,
  jsParameterList,
  type JsEnv,
} from "./call-syntax.js";

/** Module-level scope of the file being extracted, plus an empty class. */
function moduleEnv(root: SyntaxNode): JsEnv {
  return { scope: jsModuleScope(root), className: null };
}

function isFnLike(type: string): boolean {
  return (
    type === "function_declaration" ||
    type === "function_expression" ||
    type === "arrow_function" ||
    type === "generator_function" ||
    type === "generator_function_declaration" ||
    type === "method_definition"
  );
}

/** Nested function/arrow, not a method — skip as a sibling, maybe nest under a call. */
function isCallback(type: string): boolean {
  return isFnLike(type) && type !== "method_definition";
}

function getParamsLabel(params: SyntaxNode | null): string {
  if (!params || params.type !== "formal_parameters") return "()";
  const parts: string[] = [];
  for (const p of namedChildren(params)) {
    if (p.type === "required_parameter" || p.type === "optional_parameter") {
      const rest = childByType(p, "rest_pattern");
      if (rest) {
        const id = childByType(rest, "identifier");
        parts.push(id ? `...${id.text}` : "...");
        continue;
      }
      const id = childByType(p, "identifier");
      if (id) {
        parts.push(id.text);
        continue;
      }
      if (childByType(p, "object_pattern")) {
        parts.push("{}");
        continue;
      }
      if (childByType(p, "array_pattern")) {
        parts.push("[]");
        continue;
      }
      parts.push("_");
      continue;
    }
    if (p.type === "rest_parameter" || p.type === "rest_pattern") {
      const id = childByType(p, "identifier");
      parts.push(id ? `...${id.text}` : "...");
      continue;
    }
    parts.push("_");
  }
  return parts.length === 0 ? "()" : `(${parts.join(", ")})`;
}

function condText(test: SyntaxNode): string {
  if (test.type === "parenthesized_expression") {
    const inner = test.namedChild(0);
    if (inner) return collapseWs(inner.text);
  }
  return collapseWs(test.text);
}

function branchKey(kind: "if" | "else-if" | "else", cond: string): string {
  if (kind === "else") return "else";
  return `${kind}:${cond}`;
}

function calleeKey(node: SyntaxNode, className: string | null): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "this") return className;

  if (node.type === "member_expression") {
    const object = node.namedChild(0);
    const property =
      namedChildren(node).find(
        (c) =>
          c.type === "property_identifier" ||
          c.type === "private_property_identifier",
      ) ?? null;
    if (!object || !property) return null;

    const propName = property.text;
    if (object.type === "this" && className) {
      return `${className}.${propName}`;
    }
    if (object.type === "identifier") {
      return `${object.text}.${propName}`;
    }
    if (className) return `${className}.${propName}`;
    return propName;
  }

  return null;
}

/**
 * Treat JSX tags as component "calls". PascalCase identifiers and any
 * member expression (`Foo.Bar`, `motion.div`) count; lowercase tags are HTML.
 */
function jsxCalleeKey(node: SyntaxNode): string | null {
  for (const child of namedChildren(node)) {
    if (child.type === "identifier") {
      const name = child.text;
      return /^[A-Z]/.test(name) ? name : null;
    }
    if (child.type === "member_expression") {
      return calleeKey(child, null);
    }
    if (
      child.type === "jsx_attribute" ||
      child.type === "jsx_expression" ||
      child.type === "type_arguments"
    ) {
      break;
    }
  }
  return null;
}

function statementsOf(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "statement_block") return namedChildren(node);
  return [node];
}

/**
 * Steps of one statement list. `env` carries the lexical scope in effect
 * (module, function, or method), which is what classifies call targets.
 */
function collectStatements(
  file: string,
  statements: SyntaxNode[],
  env: JsEnv,
): CallStep[] {
  const steps: CallStep[] = [];
  const seenCalls = new Set<string>();

  const addCall = (key: string, node: SyntaxNode, syntax?: CallSyntax) => {
    const mark = `${key}:${node.startIndex}`;
    if (seenCalls.has(mark)) return;
    seenCalls.add(mark);
    const step: CallStep = { type: "call", key, ...locFromNode(file, node) };
    if (syntax) step.syntax = syntax;
    steps.push(step);
  };

  const emitCall = (
    key: string | null,
    node: SyntaxNode,
    nested: CallStep[],
    syntax?: CallSyntax,
  ) => {
    if (key && nested.length > 0) {
      const step: CallStep = {
        type: "call",
        key,
        ...locFromNode(file, node),
        children: nested,
      };
      if (syntax) step.syntax = syntax;
      steps.push(step);
    } else if (key) {
      addCall(key, node, syntax);
    } else {
      steps.push(...nested);
    }
  };

  const walkExpr = (node: SyntaxNode): void => {
    const type = node.type;

    if (isCallback(type)) {
      return;
    }

    if (type === "if_statement") {
      const test =
        childByType(node, "parenthesized_expression") ??
        namedChildren(node).find((c) => c.type !== "else_clause") ??
        null;
      const kids = namedChildren(node);
      const consequent =
        kids.find(
          (c) =>
            c.type !== "parenthesized_expression" && c.type !== "else_clause",
        ) ?? null;
      const elseClause = childByType(node, "else_clause");
      const cond = test ? condText(test) : "";

      steps.push({
        type: "branch",
        key: branchKey("if", cond),
        label: test ? `if (${condText(test)})` : "if",
        ...locFromNode(file, test ?? node),
        children: consequent
          ? collectStatements(file, statementsOf(consequent), env)
          : [],
      });

      let current = elseClause;
      while (current) {
        const inner = current.namedChild(0);
        if (!inner) break;

        if (inner.type === "if_statement") {
          const elseTest =
            childByType(inner, "parenthesized_expression") ?? null;
          const elseKids = namedChildren(inner);
          const elseConsequent =
            elseKids.find(
              (c) =>
                c.type !== "parenthesized_expression" &&
                c.type !== "else_clause",
            ) ?? null;
          const elseCond = elseTest ? condText(elseTest) : "";
          steps.push({
            type: "branch",
            key: branchKey("else-if", elseCond),
            label: elseTest ? `else if (${condText(elseTest)})` : "else if",
            ...locFromNode(file, elseTest ?? current),
            children: elseConsequent
              ? collectStatements(file, statementsOf(elseConsequent), env)
              : [],
          });
          current = childByType(inner, "else_clause");
          continue;
        }

        steps.push({
          type: "branch",
          key: branchKey("else", ""),
          label: "else",
          ...locFromNode(file, current),
          children: collectStatements(file, statementsOf(inner), env),
        });
        break;
      }
      return;
    }

    if (type === "call_expression" || type === "new_expression") {
      const isNew = type === "new_expression";
      const callee = node.namedChild(0);
      const bare = callee ? calleeKey(callee, isNew ? null : env.className) : null;
      const args = childByType(node, "arguments");
      const syntax = callee ? jsCallSyntax(callee, args, env) : undefined;
      // A dynamic target has no key from `calleeKey`; the call is still a call,
      // so the target expression itself becomes its identity.
      const base = bare ?? (syntax ? syntax.callee : null);
      const key =
        base && isNew && !base.startsWith("new ") ? `new ${base}` : base;
      emitCall(
        key,
        node,
        args ? stepsFromArguments(file, args, env) : [],
        syntax,
      );
      // `foo(x).bar()` keeps `foo` — the receiver is not an argument.
      if (callee) walkExpr(callee);
      return;
    }

    if (type === "jsx_element") {
      const opening = childByType(node, "jsx_opening_element");
      const childNodes = namedChildren(node).filter(
        (c) =>
          c.type !== "jsx_opening_element" && c.type !== "jsx_closing_element",
      );
      const fromAttrs: CallStep[] = [];
      if (opening) {
        for (const attr of namedChildren(opening)) {
          if (
            attr.type === "jsx_attribute" ||
            attr.type === "jsx_expression"
          ) {
            fromAttrs.push(...collectStatements(file, [attr], env));
          }
        }
      }
      const nested = [
        ...fromAttrs,
        ...collectStatements(file, childNodes, env),
      ];
      emitCall(opening ? jsxCalleeKey(opening) : null, opening ?? node, nested);
      return;
    }

    if (type === "jsx_self_closing_element") {
      const attrNodes = namedChildren(node).filter(
        (c) => c.type === "jsx_attribute" || c.type === "jsx_expression",
      );
      emitCall(
        jsxCalleeKey(node),
        node,
        collectStatements(file, attrNodes, env),
      );
      return;
    }

    for (const child of namedChildren(node)) {
      walkExpr(child);
    }
  };

  for (const stmt of statements) {
    walkExpr(stmt);
  }

  return steps;
}

/** Named children of a function node that are never its runtime body. */
const NON_BODY = new Set([
  "comment",
  "formal_parameters",
  "type_parameters",
  "type_annotation",
  "identifier",
  "accessibility_modifier",
  "async",
  "readonly",
]);

function bodyOf(node: SyntaxNode): SyntaxNode | null {
  return (
    childByType(node, "statement_block") ??
    namedChildren(node).find((c) => !NON_BODY.has(c.type)) ??
    null
  );
}

/** Peel `(a) => (b) => body` to `body`. A returned factory (`return () => tick()`) stays out. */
function unwrapCurriedBody(body: SyntaxNode | null): SyntaxNode | null {
  let current = body ? stripTypeWrappers(body) : null;
  while (
    current &&
    (current.type === "arrow_function" ||
      current.type === "function_expression" ||
      current.type === "generator_function")
  ) {
    const inner = bodyOf(current);
    if (!inner) return current;
    current = stripTypeWrappers(inner);
  }
  return current;
}

/**
 * Calls and callback bodies inside `(...)`, as children of the receiving call.
 * Skip a callback already registered as its own definition (`const x = wrap(fn)`).
 */
function stepsFromArguments(
  file: string,
  args: SyntaxNode,
  env: JsEnv,
): CallStep[] {
  const skipCallbacks = args.parent ? hoistsCallback(args.parent) : false;
  const steps: CallStep[] = [];
  for (const rawArg of namedChildren(args)) {
    const arg = stripTypeWrappers(rawArg);
    if (isCallback(arg.type)) {
      if (skipCallbacks) continue;
      steps.push(...collectStepsFromBody(file, unwrapCurriedBody(bodyOf(arg)), env));
      continue;
    }
    steps.push(...collectStatements(file, [arg], env));
  }
  return steps;
}

/** True when this call's callback is extracted as a named definition. */
function hoistsCallback(call: SyntaxNode): boolean {
  let current: SyntaxNode | null = call.parent;
  while (current && TRANSPARENT_EXPRESSIONS.has(current.type)) {
    current = current.parent;
  }
  if (!current) return false;
  if (
    current.type === "variable_declarator" ||
    current.type === "export_statement"
  ) {
    return true;
  }
  if (current.type === "arguments") {
    const outer = current.parent;
    return outer?.type === "call_expression" ? hoistsCallback(outer) : false;
  }
  return false;
}

function collectStepsFromBody(
  file: string,
  body: SyntaxNode | null,
  env: JsEnv,
): CallStep[] {
  if (!body) return [];
  if (body.type === "statement_block") {
    return collectStatements(file, namedChildren(body), env);
  }
  return collectStatements(file, [body], env);
}

function functionFromParts(
  file: string,
  key: string,
  label: string,
  params: SyntaxNode | null,
  body: SyntaxNode | null,
  exported: boolean,
  start: number,
  end: number,
  env: JsEnv,
): FunctionInfo {
  const declared = jsParameterList(params);
  const info: FunctionInfo = {
    key,
    label: `${label}${getParamsLabel(params)}`,
    file,
    steps: collectStepsFromBody(file, body, env),
    exported,
    start,
    end,
  };
  if (declared) info.params = declared;
  return info;
}

const TRANSPARENT_EXPRESSIONS = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
  "type_assertion",
]);

/**
 * Peel the wrappers TypeScript allows around a value — `(fn)`, `fn as Handler`,
 * `fn satisfies Handler`, `<Handler>fn`, `fn!` — so the node underneath can be
 * matched on its own terms. In every one of these the value is the first named
 * child, except `<T>fn`, where the leading `type_arguments` comes first.
 */
function stripTypeWrappers(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (TRANSPARENT_EXPRESSIONS.has(current.type)) {
    const inner = namedChildren(current).find(
      (c) => c.type !== "type_arguments",
    );
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/**
 * `export default defineEventHandler(async (event) => {...})` — the module's
 * payload is a function argument to a wrapper call, not a declaration. Extract
 * it, keyed by its own name where it has one and by `fallbackName` otherwise:
 * the declared variable for `const handler = wrapper(...)`, the file stem for a
 * default export, so routes in different files do not collide.
 *
 * Returns whether a function was found, so a nested call that holds none —
 * `createHandler(makeOptions(), async () => {...})` — does not stop the scan
 * before the sibling argument that does.
 */
function unwrapWrappedFunction(
  file: string,
  call: SyntaxNode,
  fallbackName: string | null,
  exported: boolean,
  functions: FunctionInfo[],
  outer: JsEnv,
  local = false,
): boolean {
  const args = namedChildren(call).find((c) => c.type === "arguments");
  if (!args) return false;
  for (const rawArg of namedChildren(args)) {
    const arg = stripTypeWrappers(rawArg);
    // Wrappers compose: `memo(forwardRef(function Input() {...}))`.
    if (arg.type === "call_expression") {
      if (
        unwrapWrappedFunction(
          file,
          arg,
          fallbackName,
          exported,
          functions,
          outer,
          local,
        )
      ) {
        return true;
      }
      continue;
    }
    // Generators count too: `Effect.gen(function* () {...})` is this shape.
    if (!isCallback(arg.type)) continue;
    const named = childByType(arg, "identifier");
    handleFunctionNode(
      file,
      arg,
      named?.text ?? fallbackName,
      exported,
      outer,
      functions,
      local,
    );
    return true;
  }
  return false;
}

/** File path minus extension — the key for an anonymous default export. */
function fileStem(file: string): string {
  return file.replace(/\.[^./]+$/, "");
}

/**
 * Extract a function from a variable declarator's initialiser: a direct
 * arrow/function expression, or a function argument to a wrapper call.
 */
function extractDeclaratorFunction(
  file: string,
  d: SyntaxNode,
  exported: boolean,
  functions: FunctionInfo[],
  outer: JsEnv,
  local = false,
): void {
  const id = childByType(d, "identifier");
  if (!id) return;
  // The initialiser is the declarator's value child — everything but the
  // name and any type annotation — with its type wrappers peeled off.
  const value = namedChildren(d).find(
    (c) => c !== id && c.type !== "type_annotation",
  );
  const init = value ? stripTypeWrappers(value) : null;
  if (!init) return;
  if (init.type === "arrow_function" || init.type === "function_expression") {
    handleFunctionNode(file, init, id.text, exported, outer, functions, local);
    return;
  }
  // `const handler = defineEventHandler(async (event) => {...})` — the
  // initialiser is the wrapper call, so the function is one level in.
  if (init.type === "call_expression") {
    unwrapWrappedFunction(file, init, id.text, exported, functions, outer, local);
  }
}

/**
 * Register definitions declared inside a function body.
 *
 * `visitStatement` only walks top-level statements, so a helper declared inside
 * a body was never indexed at all, and calls to it fell through to whatever
 * top-level function elsewhere in the repo happened to share the bare name.
 * See #19.
 *
 * Helper bodies are still not attributed to the outer caller (contract #5);
 * they become definitions in their own right, marked `local`.
 */
function collectLocalDefinitions(
  file: string,
  body: SyntaxNode | null,
  env: JsEnv,
  functions: FunctionInfo[],
) {
  if (!body) return;

  const walk = (node: SyntaxNode): void => {
    for (const child of namedChildren(node)) {
      if (
        child.type === "function_declaration" ||
        child.type === "generator_function_declaration"
      ) {
        const id = childByType(child, "identifier");
        handleFunctionNode(
          file,
          child,
          id?.text ?? null,
          false,
          env,
          functions,
          true,
        );
        continue;
      }

      if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (const d of namedChildren(child)) {
          if (d.type !== "variable_declarator") continue;
          extractDeclaratorFunction(file, d, false, functions, env, true);
        }
        // Fall through: `walk` skips the initializer bodies as fn-like below,
        // so a declaration list is never registered twice.
      }

      // Anonymous callbacks are not addressable by name; skip their bodies.
      if (isFnLike(child.type)) continue;

      walk(child);
    }
  };

  walk(body);
}

/**
 * Scope of one function body. The enclosing class identity is inherited, so a
 * local closure still has its method's `this` bindings.
 */
function functionEnv(node: SyntaxNode, outer: JsEnv): JsEnv {
  return {
    scope: jsFunctionScope(node, outer.scope),
    className: outer.className,
  };
}

function handleFunctionNode(
  file: string,
  node: SyntaxNode,
  name: string | null,
  exported: boolean,
  outer: JsEnv,
  functions: FunctionInfo[],
  /** Declared inside another body: key stays bare and resolution is file-scoped. */
  local = false,
) {
  if (!name) return;
  const key = outer.className && !local ? `${outer.className}.${name}` : name;
  const params = childByType(node, "formal_parameters");
  const body = unwrapCurriedBody(bodyOf(node));
  const env = functionEnv(node, outer);

  const info = functionFromParts(
    file,
    key,
    key,
    params,
    body,
    exported,
    node.startIndex,
    node.endIndex,
    env,
  );
  functions.push(local ? { ...info, local: true } : info);
  collectLocalDefinitions(file, body, env, functions);
}

function handleClass(
  file: string,
  node: SyntaxNode,
  exported: boolean,
  functions: FunctionInfo[],
  outer: JsEnv,
) {
  const nameNode =
    childByType(node, "type_identifier") ?? childByType(node, "identifier");
  const className = nameNode?.text ?? null;
  if (!className) return;

  const body = childByType(node, "class_body");
  if (!body) return;

  // Members resolve `this.name()`; the class body itself sees the outer scope.
  const classEnv: JsEnv = {
    scope: outer.scope,
    className,
  };

  for (const element of namedChildren(body)) {
    if (element.type === "method_definition") {
      const keyNode =
        childByType(element, "property_identifier") ??
        childByType(element, "private_property_identifier") ??
        childByType(element, "computed_property_name");
      const methodName = keyNode?.text ?? null;
      const isConstructor = methodName === "constructor";
      if (!methodName) continue;

      const accessibility = childByType(element, "accessibility_modifier");
      const methodExported = exported || accessibility?.text === "public";

      const params = childByType(element, "formal_parameters");
      const fnBody = childByType(element, "statement_block");
      const key = isConstructor
        ? `${className}.constructor`
        : `${className}.${methodName}`;
      const label = isConstructor ? `new ${className}()` : key;
      const env = functionEnv(element, classEnv);

      functions.push(
        functionFromParts(
          file,
          key,
          label,
          params,
          fnBody,
          methodExported,
          element.startIndex,
          element.endIndex,
          env,
        ),
      );
      collectLocalDefinitions(file, fnBody, env, functions);
    }

    if (element.type === "public_field_definition") {
      const keyNode = childByType(element, "property_identifier");
      const value =
        childByType(element, "arrow_function") ??
        childByType(element, "function_expression");
      if (keyNode && value) {
        handleFunctionNode(
          file,
          value,
          keyNode.text,
          exported,
          classEnv,
          functions,
        );
      }
    }
  }
}

function visitStatement(
  file: string,
  node: SyntaxNode,
  exported: boolean,
  functions: FunctionInfo[],
  env: JsEnv,
) {
  if (node.type === "export_statement") {
    // Decorators can precede the declaration inside an export statement.
    // Select grammar fields, not the first named child (which may be metadata).
    const found = node.childForFieldName("declaration") ??
      node.childForFieldName("value");
    if (!found) return;
    const decl = stripTypeWrappers(found);

    const isDefault = node.children.some((child) => child.type === "default");

    if (
      decl.type === "function_declaration" ||
      decl.type === "function_expression" ||
      decl.type === "generator_function_declaration" ||
      decl.type === "generator_function"
    ) {
      const id = childByType(decl, "identifier");
      const name = id?.text ?? (isDefault ? "default" : null);
      handleFunctionNode(file, decl, name, true, env, functions);
      return;
    }
    if (decl.type === "arrow_function") {
      handleFunctionNode(
        file,
        decl,
        isDefault ? "default" : null,
        true,
        env,
        functions,
      );
      return;
    }
    if (
      decl.type === "class_declaration" ||
      decl.type === "abstract_class_declaration" ||
      decl.type === "class"
    ) {
      handleClass(file, decl, true, functions, env);
      return;
    }
    if (decl.type === "call_expression") {
      unwrapWrappedFunction(
        file,
        decl,
        isDefault ? fileStem(file) : null,
        true,
        functions,
        env,
      );
      return;
    }
    if (
      decl.type === "lexical_declaration" ||
      decl.type === "variable_declaration"
    ) {
      visitStatement(file, decl, true, functions, env);
    }
    return;
  }

  if (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration"
  ) {
    const id = childByType(node, "identifier");
    handleFunctionNode(file, node, id?.text ?? null, exported, env, functions);
    return;
  }

  if (
    node.type === "class_declaration" ||
    node.type === "abstract_class_declaration"
  ) {
    handleClass(file, node, exported, functions, env);
    return;
  }

  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
    for (const d of namedChildren(node)) {
      if (d.type !== "variable_declarator") continue;
      extractDeclaratorFunction(file, d, exported, functions, env);
    }
  }
}

function extractFromTree(
  file: string,
  _source: string,
  tree: Tree,
): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const env = moduleEnv(tree.rootNode);
  for (const stmt of namedChildren(tree.rootNode)) {
    visitStatement(file, stmt, false, functions, env);
  }
  return functions;
}

export const typescriptExtractor: LanguageExtractor = {
  id: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  grammarPackage: "tree-sitter-typescript",
  grammarExport: "typescript",
  extract: extractFromTree,
};

/** TSX (.tsx) — separate tree-sitter-typescript grammar export from plain TS. */
export const typescriptreactExtractor: LanguageExtractor = {
  id: "typescriptreact",
  extensions: [".tsx"],
  grammarPackage: "tree-sitter-typescript",
  grammarExport: "tsx",
  extract: extractFromTree,
};
