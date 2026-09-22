/**
 * TypeScript dispatch review context.
 *
 * Two wiring styles move work across a module boundary without a call the
 * syntax can follow, so a diff hunk alone never shows the other end:
 *
 * - an event emitter (`x.emit(key, …)` / `x.emitAsync(key, …)`) and the handler
 *   registered for that key (`@OnEvent(...)`, `@OnTypedEvent(...)`);
 * - a queue producer (`this.<injected>.add(key, …)`) and the consumer handling
 *   that key (`@Processor(channel)`, then `switch (job.name) { case key }`,
 *   `if (job.name === key)`, or `@Process(key)`).
 *
 * Extraction records each site as `review.dispatches` on the owning
 * `FunctionInfo`; resolution pairs a producer with its consumer and returns one
 * candidate edge per pair. Nothing here claims runtime delivery. A key match is
 * a static syntax relation, only ever made between keys whose value resolved to
 * the same literal or between the same written member path, and every edge
 * states how it was matched.
 *
 * Unsupported, deliberately:
 * - imperative registrations (`emitter.on(key, handler)`, `queue.process(...)`)
 *   — the registration site and the handler are different owners and the
 *   review contract has no field for a handler reference;
 * - computed or template keys with substitutions, `obj["add"]`, and keys read
 *   from parameters or instance state (recorded as nothing rather than guessed);
 * - queues reached through a receiver other than an `@InjectQueue` field, so a
 *   `Set.add` / `classList.add` call can never be read as a job dispatch;
 * - constant values that are not plain string literals (escapes are not
 *   decoded, computed enum initialisers are not evaluated).
 */
import type Parser from "tree-sitter";
import type { FunctionInfo } from "../types.js";
import { childByType, collapseWs, namedChildren } from "./types.js";

type SyntaxNode = Parser.SyntaxNode;
type Tree = Parser.Tree;

/** One dispatch site, appended to the owning function's `review.dispatches`. */
export interface DispatchRecord {
  kind: "event" | "queue";
  direction: "emit" | "handle";
  /** Provenance-tagged static key; see the tag constants below. */
  key: string;
  /** Provenance-tagged queue channel. Absent when the channel is not static. */
  channel?: string;
  /** 1-based line of the emit call, registration decorator or switch case. */
  line: number;
  /** Source-derived description of the site, quoted in the resolved edge. */
  evidence: string;
}

/** One candidate context edge between a dispatch site and its counterpart. */
export interface DispatchEdge {
  owner: FunctionInfo;
  target: FunctionInfo;
  evidence: string;
  kind: "event" | "queue";
  line: number;
}

/**
 * Every static expression is stored under the provenance of how it was read,
 * so only expressions that mean the same thing can match:
 * `s:` a string literal value, `m:` a dotted member path whose value is not
 * known, `i:` a bare identifier whose value is not known. An identifier is
 * dynamic by nature, so it never matches.
 */
const LITERAL_TAG = "s:";
const MEMBER_TAG = "m:";
const IDENTIFIER_TAG = "i:";

/** A static key expression: canonical tag plus the text as written. */
interface StaticKey {
  tag: string;
  text: string;
}

/** Emitter methods that publish a keyed event. */
const EVENT_EMIT_METHODS = { emit: true, emitAsync: true };
/** Queue method that enqueues a keyed job. */
const QUEUE_ADD_METHOD = "add";
/** BullMQ job field the consumer branches on. */
const JOB_NAME_PROPERTY = "name";
/** Decorators registering a handler for an event key, e.g. `OnTypedEvent`. */
const EVENT_REGISTRATION_DECORATOR = /^On[A-Za-z]*Event$/u;
/** DI decorator naming the queue a field or constructor parameter is bound to. */
const INJECT_QUEUE_DECORATOR = "InjectQueue";
/** Class decorator naming the queue a consumer class processes. */
const PROCESSOR_DECORATOR = "Processor";
/** Method decorator naming one job key a consumer handles. */
const PROCESS_DECORATOR = "Process";

/** Nodes that declare a function body, whose first parameter is its own `job`. */
const FUNCTION_NODES = {
  function_declaration: true,
  function_expression: true,
  generator_function: true,
  generator_function_declaration: true,
  arrow_function: true,
  method_definition: true,
};

/** Nodes that declare a class body, the scope of `@InjectQueue` and `@Processor`. */
const CLASS_NODES = { class_declaration: true, class: true };

// ── Static key expressions ───────────────────────────────────────────────────

/** The unwrapped expression behind `(x)`, `x as T` and `x satisfies T`. */
function stripWrappers(node: SyntaxNode): SyntaxNode {
  let current = node;
  for (;;) {
    const inner =
      current.type === "parenthesized_expression"
        ? namedChildren(current)[0]
        : current.type === "as_expression" || current.type === "satisfies_expression"
          ? current.childForFieldName("expression") ?? namedChildren(current)[0]
          : undefined;
    if (!inner || inner.id === current.id) return current;
    current = inner;
  }
}

/**
 * Literal text of a plain string, or `null` when it carries an escape, a line
 * break, or a substitution. Escapes are never decoded, so an expression that
 * needs decoding stays dynamic instead of being guessed.
 */
function stringValue(node: SyntaxNode): string | null {
  const text = node.text;
  if (node.type === "template_string" && namedChildren(node).length > 0) return null;
  if (text.length < 2) return null;
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (text.at(-1) !== quote) return null;
  const body = text.slice(1, -1);
  if (body.includes("\\") || body.includes(quote) || body.includes("\n")) return null;
  return body;
}

/** Dotted path of a member expression, or `null` when a segment is computed. */
function memberPath(node: SyntaxNode): string | null {
  if (node.type === "identifier" || node.type === "property_identifier") return node.text;
  if (node.type !== "member_expression") return null;
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  if (!property || property.type !== "property_identifier") return null;
  const prefix = object ? memberPath(object) : null;
  return prefix === null ? null : `${prefix}.${property.text}`;
}

/** Read a key expression as written. `null` means dynamic: never recorded. */
function staticKeyOf(node: SyntaxNode): StaticKey | null {
  const expression = stripWrappers(node);
  if (expression.type === "string" || expression.type === "template_string") {
    const value = stringValue(expression);
    return value === null ? null : { tag: LITERAL_TAG + value, text: collapseWs(expression.text) };
  }
  if (expression.type === "identifier") {
    return { tag: IDENTIFIER_TAG + expression.text, text: expression.text };
  }
  if (expression.type === "member_expression") {
    const path = memberPath(expression);
    return path === null ? null : { tag: MEMBER_TAG + path, text: collapseWs(expression.text) };
  }
  return null;
}

/** Field name of a `this.<field>` receiver, or `null` for any other receiver. */
function thisFieldName(object: SyntaxNode | null): string | null {
  if (!object || object.type !== "member_expression") return null;
  if (object.childForFieldName("object")?.type !== "this") return null;
  const property = object.childForFieldName("property");
  return property?.type === "property_identifier" ? property.text : null;
}

// ── Constant tables ──────────────────────────────────────────────────────────

/** Literal values declared by one file, so a lookup can be scoped to a run. */
interface FileConstants {
  /** `Container.Member` → literal: enum members and `as const` object keys. */
  members: Map<string, Map<string, string>>;
  /** Bare identifier → literal: `export const QUEUE = '{queue}'`. */
  scalars: Map<string, string>;
}

/** Constant tables travel with immutable extraction metadata, never a file-global latest snapshot. */
const constantsByReview = new WeakMap<NonNullable<FunctionInfo["review"]>, FileConstants>();

function addMember(constants: FileConstants, container: string, member: string, value: string): void {
  const table = constants.members.get(container) ?? new Map<string, string>();
  table.set(member, value);
  constants.members.set(container, table);
}

/** The single value a table holds for a key, or `null` when absent/divergent. */
function oneValue(values: Iterable<string>): string | null {
  let found: string | null = null;
  for (const value of values) {
    if (found !== null && found !== value) return null;
    found = value;
  }
  return found;
}


function collectConstants(statement: SyntaxNode, constants: FileConstants): void {
  const declaration =
    statement.type === "export_statement" ? namedChildren(statement)[0] ?? statement : statement;
  if (declaration.type === "enum_declaration") return collectEnum(declaration, constants);
  if (declaration.type !== "lexical_declaration" && declaration.type !== "variable_declaration") {
    return;
  }
  for (const declarator of namedChildren(declaration)) {
    if (declarator.type !== "variable_declarator") continue;
    const name = declarator.childForFieldName("name") ?? childByType(declarator, "identifier");
    const value = declarator.childForFieldName("value");
    if (!name || name.type !== "identifier" || !value) continue;
    collectDeclarator(name.text, value, constants);
  }
}

/** Enum members with a plain string initialiser; a bare member has no value. */
function collectEnum(declaration: SyntaxNode, constants: FileConstants): void {
  const name = childByType(declaration, "identifier")?.text;
  const body = childByType(declaration, "enum_body");
  if (!name || !body) return;
  for (const member of namedChildren(body)) {
    if (member.type !== "enum_assignment") continue;
    const key = childByType(member, "property_identifier")?.text;
    const initialiser = childByType(member, "string");
    if (!key || !initialiser) continue;
    const value = stringValue(initialiser);
    if (value !== null) addMember(constants, name, key, value);
  }
}

/** One `const NAME = value`: a string constant, or an all-string key map. */
function collectDeclarator(name: string, value: SyntaxNode, constants: FileConstants): void {
  const expression = stripWrappers(value);
  if (expression.type !== "object") {
    const literal = stringValue(expression);
    if (literal !== null) constants.scalars.set(name, literal);
    return;
  }
  const entries: [string, string][] = [];
  for (const pair of namedChildren(expression)) {
    if (pair.type !== "pair") return;
    const key = pair.childForFieldName("key");
    const entryValue = pair.childForFieldName("value");
    if (!key || !entryValue) return;
    const member =
      key.type === "property_identifier"
        ? key.text
        : key.type === "string"
          ? stringValue(key)
          : null;
    const literal = entryValue.type === "string" ? stringValue(entryValue) : null;
    if (member === null || literal === null) return;
    entries.push([member, literal]);
  }
  for (const [member, literal] of entries) addMember(constants, name, member, literal);
}

/** Member literal from this file first, then from any file of the active set. */
function lookupMember(
  container: string,
  member: string,
  file: string,
  files: ReadonlyMap<string, FileConstants>,
): string | null {
  const local = files.get(file)?.members.get(container)?.get(member);
  if (local !== undefined) return local;
  const values: string[] = [];
  for (const constants of files.values()) {
    const value = constants.members.get(container)?.get(member);
    if (value !== undefined) values.push(value);
  }
  return oneValue(values);
}

/** Scalar literal from this file first, then from any file of the active set. */
function lookupScalar(name: string, file: string, files: ReadonlyMap<string, FileConstants>): string | null {
  const local = files.get(file)?.scalars.get(name);
  if (local !== undefined) return local;
  const values: string[] = [];
  for (const constants of files.values()) {
    const value = constants.scalars.get(name);
    if (value !== undefined) values.push(value);
  }
  return oneValue(values);
}

// ── Extraction walk ──────────────────────────────────────────────────────────

/** Queue channels in effect for a class body and the walk below it. */
interface DispatchScope {
  /** `this.<field>` receivers bound by `@InjectQueue`, `null` when not static. */
  injected: ReadonlyMap<string, StaticKey | null>;
  /** Channel of the enclosing class `@Processor(...)`, when static. */
  processorChannel: StaticKey | null;
  /** First parameter of the enclosing function, the object `job.name` reads. */
  jobParam: string | null;
}

interface ExtractContext {
  functions: readonly FunctionInfo[];
}

const ROOT_SCOPE: DispatchScope = {
  injected: new Map(),
  processorChannel: null,
  jobParam: null,
};

/**
 * Record this file's dispatch sites on their owning functions. Declarations are
 * never added; only `review.dispatches` is appended, next to whatever the
 * contract extractor already wrote there.
 */
export function extractDispatchContext(file: string, tree: Tree, functions: FunctionInfo[]): void {
  const constants: FileConstants = { members: new Map(), scalars: new Map() };
  for (const statement of namedChildren(tree.rootNode)) collectConstants(statement, constants);
  const context: ExtractContext = {
    functions: functions.filter((fn) => fn.file === file),
  };
  visitNode(tree.rootNode, context, ROOT_SCOPE);
  for (const fn of context.functions) {
    fn.review ??= {};
    constantsByReview.set(fn.review, constants);
  }
}

/** Smallest extracted function whose span contains the node, or `null`. */
function ownerFor(node: SyntaxNode, context: ExtractContext): FunctionInfo | null {
  let owner: FunctionInfo | null = null;
  for (const fn of context.functions) {
    if (fn.start > node.startIndex || fn.end < node.endIndex) continue;
    if (!owner || fn.end - fn.start < owner.end - owner.start) owner = fn;
  }
  return owner;
}

/**
 * Attach one record to the smallest function containing `node`. Repeating the
 * walk over the same tree, or a cached extraction replayed, must not duplicate.
 */
function pushDispatch(
  context: ExtractContext,
  node: SyntaxNode,
  record: Omit<DispatchRecord, "line">,
): void {
  const owner = ownerFor(node, context);
  if (!owner) return;
  const full: DispatchRecord = { ...record, line: node.startPosition.row + 1 };
  const existing = owner.review?.dispatches;
  const duplicate = existing?.some(
    (prior) =>
      prior.kind === full.kind &&
      prior.direction === full.direction &&
      prior.key === full.key &&
      prior.channel === full.channel &&
      prior.line === full.line,
  );
  if (duplicate) return;
  owner.review = { ...owner.review, dispatches: [...(existing ?? []), full] };
}

/** Callee name of a call or decorator: last identifier written. */
function calleeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    return property?.type === "property_identifier" ? property.text : null;
  }
  return null;
}

/** Call arguments as written, in source order. */
function callArguments(call: SyntaxNode): SyntaxNode[] {
  const args = call.childForFieldName("arguments");
  return args ? namedChildren(args) : [];
}

/** Decorator callee name plus its arguments, or `null` without a call. */
function decoratorCall(decorator: SyntaxNode): { name: string; args: SyntaxNode[] } | null {
  const expression = namedChildren(decorator)[0];
  if (!expression || expression.type !== "call_expression") return null;
  const name = calleeName(expression.childForFieldName("function"));
  if (name === null) return null;
  return { name, args: callArguments(expression) };
}

/** First parameter name of a function node, the object `job.name` reads. */
function firstParamName(node: SyntaxNode): string | null {
  const params = childByType(node, "formal_parameters");
  if (params) {
    const first = namedChildren(params)[0];
    if (!first) return null;
    if (first.type === "identifier") return first.text;
    return childByType(first, "identifier")?.text ?? null;
  }
  const sole = namedChildren(node)[0];
  return sole?.type === "identifier" ? sole.text : null;
}

/** A `@InjectQueue(...)` receiver: the bound name and its channel. */
function injectedBinding(
  node: SyntaxNode,
  decorators: readonly SyntaxNode[],
): { name: string; channel: StaticKey | null } | null {
  let channel: StaticKey | null = null;
  let found = false;
  for (const decorator of decorators) {
    const call = decoratorCall(decorator);
    if (!call || call.name !== INJECT_QUEUE_DECORATOR) continue;
    found = true;
    const argument = call.args[0];
    if (argument) channel = staticKeyOf(argument);
  }
  if (!found) return null;
  const name =
    childByType(node, "property_identifier")?.text ?? childByType(node, "identifier")?.text;
  return name === undefined ? null : { name, channel };
}

/** Class members paired with the decorator run written above each one. */
interface ClassMember {
  node: SyntaxNode;
  decorators: SyntaxNode[];
}

function classMembers(body: SyntaxNode): ClassMember[] {
  const members: ClassMember[] = [];
  let decorators: SyntaxNode[] = [];
  for (const element of namedChildren(body)) {
    if (element.type === "decorator") {
      decorators.push(element);
      continue;
    }
    if (element.type === "comment") continue;
    members.push({ node: element, decorators });
    decorators = [];
  }
  return members;
}

/** Channel of the class `@Processor(...)`, from the class or its export. */
function processorChannel(node: SyntaxNode): StaticKey | null {
  const parent = node.parent;
  const decorators = [
    ...namedChildren(node).filter((child) => child.type === "decorator"),
    ...(parent?.type === "export_statement"
      ? namedChildren(parent).filter((child) => child.type === "decorator")
      : []),
  ];
  let channel: StaticKey | null = null;
  for (const decorator of decorators) {
    const call = decoratorCall(decorator);
    if (!call || call.name !== PROCESSOR_DECORATOR) continue;
    const argument = call.args[0];
    if (argument) channel = staticKeyOf(argument);
  }
  return channel;
}

/** Where a consumer's channel comes from, appended to handler evidence. */
function processorNote(channel: StaticKey | null): string {
  return channel === null ? " (no static @Processor channel)" : ` (@Processor(${channel.text}))`;
}

/** A class body: channels in effect, then every member's decorators and body. */
function visitClass(node: SyntaxNode, context: ExtractContext, outer: DispatchScope): void {
  const body = childByType(node, "class_body");
  if (!body) return;
  const members = classMembers(body);
  const injected = new Map<string, StaticKey | null>();
  for (const member of members) {
    const field = injectedBinding(member.node, member.decorators);
    if (field) injected.set(field.name, field.channel);
    if (member.node.type !== "method_definition") continue;
    if (childByType(member.node, "property_identifier")?.text !== "constructor") continue;
    const params = childByType(member.node, "formal_parameters");
    if (!params) continue;
    for (const param of namedChildren(params)) {
      const binding = injectedBinding(
        param,
        namedChildren(param).filter((child) => child.type === "decorator"),
      );
      if (binding) injected.set(binding.name, binding.channel);
    }
  }
  const scope: DispatchScope = {
    injected,
    processorChannel: processorChannel(node),
    jobParam: outer.jobParam,
  };
  for (const member of members) {
    for (const decorator of member.decorators) {
      registerDecorator(decorator, member.node, context, scope);
    }
    visitNode(member.node, context, scope);
  }
}

/** `@On*Event(key)` and `@Process(key)` register a handler for a key. */
function registerDecorator(
  decorator: SyntaxNode,
  member: SyntaxNode,
  context: ExtractContext,
  scope: DispatchScope,
): void {
  const call = decoratorCall(decorator);
  if (!call) return;
  const isEvent = EVENT_REGISTRATION_DECORATOR.test(call.name);
  const isJob = call.name === PROCESS_DECORATOR;
  if (!isEvent && !isJob) return;
  const argument = call.args[0];
  const key = argument ? staticKeyOf(argument) : null;
  if (!key) return;
  const owner = ownerFor(member, context);
  const target = owner ? owner.key : collapseWs(member.text).slice(0, 60);
  if (isEvent) {
    pushDispatch(context, member, {
      kind: "event",
      direction: "handle",
      key: key.tag,
      evidence: `@${call.name}(${key.text}) on ${target}`,
    });
    return;
  }
  pushDispatch(context, member, {
    kind: "queue",
    direction: "handle",
    key: key.tag,
    channel: scope.processorChannel?.tag,
    evidence: `@${call.name}(${key.text}) on ${target}${processorNote(scope.processorChannel)}`,
  });
}

/** One function body: its own `job` parameter, its enclosing class channels. */
function visitFunction(node: SyntaxNode, context: ExtractContext, outer: DispatchScope): void {
  const scope: DispatchScope = {
    injected: outer.injected,
    processorChannel: outer.processorChannel,
    jobParam: firstParamName(node) ?? outer.jobParam,
  };
  for (const child of namedChildren(node)) {
    if (child.type === "formal_parameters") continue;
    visitNode(child, context, scope);
  }
}

/** `x.emit(key, …)` / `x.emitAsync(key, …)` publish an event key. */
function checkEventEmit(
  call: SyntaxNode,
  property: SyntaxNode,
  receiver: SyntaxNode | null,
  context: ExtractContext,
): boolean {
  if (!Object.hasOwn(EVENT_EMIT_METHODS, property.text)) return false;
  const argument = callArguments(call)[0];
  const key = argument ? staticKeyOf(argument) : null;
  // A bare identifier here may be a local, so only a literal or a member path
  // is a key; `emit(name)` stays dynamic rather than resolving to a same-named
  // module constant.
  if (!key || key.tag.startsWith(IDENTIFIER_TAG)) return true;
  const source = receiver ? collapseWs(receiver.text) : "?";
  pushDispatch(context, call, {
    kind: "event",
    direction: "emit",
    key: key.tag,
    evidence: `${property.text}(${key.text}) on ${source}`,
  });
  return true;
}

/** `this.<injected queue>.add(key, …)` enqueues one job key. */
function checkQueueAdd(
  call: SyntaxNode,
  receiver: SyntaxNode | null,
  context: ExtractContext,
  scope: DispatchScope,
): void {
  const field = thisFieldName(receiver);
  if (field === null) return;
  const injected = scope.injected.get(field);
  if (injected === undefined) return;
  const argument = callArguments(call)[0];
  const key = argument ? staticKeyOf(argument) : null;
  // `add(name)` may compare a local against a module constant, which the
  // constant table cannot separate; a queue name in a decorator cannot.
  if (!key || key.tag.startsWith(IDENTIFIER_TAG)) return;
  const binding =
    injected === null ? "@InjectQueue(...) with a non-static channel" : `@InjectQueue(${injected.text})`;
  pushDispatch(context, call, {
    kind: "queue",
    direction: "emit",
    key: key.tag,
    channel: injected?.tag,
    evidence: `queue.add(${key.text}) on this.${field} bound by ${binding}`,
  });
}

function checkCall(call: SyntaxNode, context: ExtractContext, scope: DispatchScope): void {
  const callee = call.childForFieldName("function");
  if (!callee || callee.type !== "member_expression") return;
  const property = callee.childForFieldName("property");
  if (!property || property.type !== "property_identifier") return;
  const receiver = callee.childForFieldName("object");
  if (checkEventEmit(call, property, receiver, context)) return;
  if (property.text === QUEUE_ADD_METHOD) checkQueueAdd(call, receiver, context, scope);
}

/** True for `<job>.name`, the BullMQ job name the consumer branches on. */
function isJobNameAccess(node: SyntaxNode | null, jobParam: string | null): boolean {
  if (!node || !jobParam || node.type !== "member_expression") return false;
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  return object?.type === "identifier" && object.text === jobParam && property?.text === JOB_NAME_PROPERTY;
}

/** `switch (job.name) { case key: }` handles one job key per static case. */
function checkSwitch(node: SyntaxNode, context: ExtractContext, scope: DispatchScope): void {
  const discriminant = childByType(node, "parenthesized_expression");
  const subject = discriminant ? namedChildren(discriminant)[0] ?? null : null;
  if (!subject || !isJobNameAccess(subject, scope.jobParam)) return;
  const body = childByType(node, "switch_body");
  if (!body) return;
  const owner = ownerFor(node, context);
  const target = owner ? owner.key : "?";
  for (const clause of namedChildren(body)) {
    if (clause.type !== "switch_case") continue;
    const written = namedChildren(clause)[0];
    const key = written ? staticKeyOf(written) : null;
    // A bare identifier may be a local, so only a literal or member path counts.
    if (!key || key.tag.startsWith(IDENTIFIER_TAG)) continue;
    pushDispatch(context, clause, {
      kind: "queue",
      direction: "handle",
      key: key.tag,
      channel: scope.processorChannel?.tag,
      evidence: `case ${key.text} of switch (${subject.text}) in ${target}${processorNote(scope.processorChannel)}`,
    });
  }
}

/** `if (job.name === key)` handles one job key without a switch. */
function checkIf(node: SyntaxNode, context: ExtractContext, scope: DispatchScope): void {
  const condition = node.childForFieldName("condition") ?? childByType(node, "parenthesized_expression");
  const comparison = condition ? stripWrappers(condition) : null;
  if (!comparison || comparison.type !== "binary_expression") return;
  const equality = comparison.children.some((child) => child.type === "===" || child.type === "==");
  if (!equality) return;
  const left = comparison.childForFieldName("left");
  const right = comparison.childForFieldName("right");
  const written = isJobNameAccess(left, scope.jobParam)
    ? right
    : isJobNameAccess(right, scope.jobParam)
      ? left
      : null;
  const key = written ? staticKeyOf(written) : null;
  // A bare identifier may be a local, so only a literal or member path counts.
  if (!key || key.tag.startsWith(IDENTIFIER_TAG)) return;
  const owner = ownerFor(node, context);
  const target = owner ? owner.key : "?";
  pushDispatch(context, node, {
    kind: "queue",
    direction: "handle",
    key: key.tag,
    channel: scope.processorChannel?.tag,
    evidence: `if (${scope.jobParam}.${JOB_NAME_PROPERTY} === ${key.text}) in ${target}${processorNote(scope.processorChannel)}`,
  });
}

function visitNode(node: SyntaxNode, context: ExtractContext, scope: DispatchScope): void {
  if (Object.hasOwn(CLASS_NODES, node.type)) return visitClass(node, context, scope);
  if (Object.hasOwn(FUNCTION_NODES, node.type)) return visitFunction(node, context, scope);
  if (node.type === "call_expression") checkCall(node, context, scope);
  else if (node.type === "switch_statement") checkSwitch(node, context, scope);
  else if (node.type === "if_statement") checkIf(node, context, scope);
  for (const child of namedChildren(node)) visitNode(child, context, scope);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** How a stored key was understood once the constant tables were consulted. */
interface EffectiveKey {
  kind: "value" | "member" | "identifier";
  /** The literal value, or the member path / identifier as written. */
  key: string;
  /** The key expression as written, which is the member path or identifier. */
  text: string;
}

interface Site {
  fn: FunctionInfo;
  record: DispatchRecord;
  key: EffectiveKey | null;
  channel: EffectiveKey | null;
}

/**
 * Read a stored key against the constant tables. A member path or identifier
 * becomes a literal when the indexed files agree on exactly one value; a
 * divergent or unknown value stays as written, which is why it can only match
 * the same written path.
 */
function effectiveKey(
  tag: string | undefined,
  file: string,
  files: ReadonlyMap<string, FileConstants>,
): EffectiveKey | null {
  if (tag === undefined) return null;
  if (tag.startsWith(LITERAL_TAG)) {
    const value = tag.slice(LITERAL_TAG.length);
    return { kind: "value", key: value, text: value };
  }
  if (tag.startsWith(MEMBER_TAG)) {
    const path = tag.slice(MEMBER_TAG.length);
    const written: EffectiveKey = { kind: "member", key: path, text: path };
    const dot = path.indexOf(".");
    if (dot <= 0 || dot === path.length - 1) return written;
    const value = lookupMember(path.slice(0, dot), path.slice(dot + 1), file, files);
    return value === null ? written : { kind: "value", key: value, text: path };
  }
  const name = tag.slice(IDENTIFIER_TAG.length);
  const value = lookupScalar(name, file, files);
  return value === null
    ? { kind: "identifier", key: name, text: name }
    : { kind: "value", key: value, text: name };
}

/** Two keys align only as the same literal value or the same written path. */
function keysAlign(a: EffectiveKey | null, b: EffectiveKey | null): boolean {
  if (!a || !b) return false;
  if (a.kind === "identifier" || b.kind === "identifier") return false;
  return a.kind === b.kind && a.key === b.key;
}

function display(key: EffectiveKey): string {
  if (key.kind === "value") return `'${key.key}'`;
  return `${key.key} (unresolved ${key.kind === "member" ? "member path" : "identifier"})`;
}

function edgeEvidence(emit: Site, handle: Site, key: EffectiveKey, channel: EffectiveKey | null): string {
  const written = [...new Set(
    [emit.key, handle.key]
      .filter((side): side is EffectiveKey => side !== null && side.text !== key.key)
      .map((side) => side.text),
  )];
  const keyPhrase = key.kind === "value"
    ? `key value ${display(key)}${written.length === 0 ? "" : ` resolved from ${written.join(" and ")}`}`
    : `identical static key path ${display(key)}`;
  const channelPhrase = channel === null
    ? "channel not required for events"
    : `channel ${display(channel)}`;
  return [
    `${emit.record.kind} relation: ${keyPhrase}; ${channelPhrase};`,
    `emit ${emit.fn.file}:${emit.record.line} ${emit.record.evidence} ->`,
    `handle ${handle.fn.file}:${handle.record.line} ${handle.record.evidence};`,
    "static syntax relation, not a runtime call or proof of delivery",
  ].join(" ");
}

/**
 * Pair every event/queue producer with the handlers registered for its key.
 * Queue edges additionally require both sides to name the same channel, so two
 * queues that reuse a job name never cross. One edge per (kind, owner, target,
 * key): repeated sites in one function collapse onto the earliest line.
 */
export function resolveDispatchContext(functions: readonly FunctionInfo[]): DispatchEdge[] {
  const files = new Map<string, FileConstants>();
  for (const fn of functions) {
    const constants = fn.review && constantsByReview.get(fn.review);
    if (constants) files.set(fn.file, constants);
  }
  const emits: Site[] = [];
  const handles: Site[] = [];
  for (const fn of functions) {
    for (const record of fn.review?.dispatches ?? []) {
      const site: Site = {
        fn,
        record,
        key: effectiveKey(record.key, fn.file, files),
        channel: effectiveKey(record.channel, fn.file, files),
      };
      if (site.key === null) continue;
      (record.direction === "emit" ? emits : handles).push(site);
    }
  }
  emits.sort((a, b) => a.record.line - b.record.line);
  handles.sort((a, b) => a.record.line - b.record.line);
  const edges: DispatchEdge[] = [];
  const seen = new Set<string>();
  for (const emit of emits) {
    for (const handle of handles) {
      if (emit.fn === handle.fn) continue;
      if (emit.record.kind !== handle.record.kind) continue;
      if (emit.key === null || handle.key === null) continue;
      if (!keysAlign(emit.key, handle.key)) continue;
      if (emit.record.kind === "queue" && !keysAlign(emit.channel, handle.channel)) continue;
      const identity = [
        emit.record.kind,
        emit.fn.file,
        emit.fn.key,
        handle.fn.file,
        handle.fn.key,
        emit.key.key,
      ].join("\u0000");
      if (seen.has(identity)) continue;
      seen.add(identity);
      edges.push({
        owner: emit.fn,
        target: handle.fn,
        kind: emit.record.kind,
        line: emit.record.line,
        evidence: edgeEvidence(emit, handle, emit.key, emit.record.kind === "queue" ? emit.channel : null),
      });
    }
  }
  return edges;
}
