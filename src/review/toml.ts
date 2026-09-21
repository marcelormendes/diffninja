/**
 * Byte-preserving TOML table edits for agent config files.
 *
 * The scanner walks the document statement by statement — skipping comments
 * and every string form — so a table is addressed by its parsed key path
 * rather than by matching text. Quoted keys, indented headers, and text that
 * only looks like a header (inside a comment or a multiline string) therefore
 * cannot misdirect an edit, and a table's whole subtree (nested tables and
 * arrays of tables) is replaced or removed with it. `smol-toml` parses the
 * document before and after the edit: malformed input is reported instead of
 * edited, and the result is only handed back when it parses and carries
 * exactly the table the caller asked for.
 */

import { parse, TomlError } from "smol-toml";
import { z } from "zod";

/** A rewritten document and whether it differs from the input. */
export interface TomlEdit {
  text: string;
  changed: boolean;
}

/** Values this module writes: a string or an array of strings. */
export type TomlValue = string | string[];

/** Key/value pairs of one table, in the order they should be written. */
export type TomlTable = Record<string, TomlValue>;

/** A decoded TOML document: the value shapes `parse` can produce. */
type TomlNode = string | number | boolean | Date | TomlNode[] | TomlTableNode;

/** A TOML table node, the only shape this module reads into. */
interface TomlTableNode {
  [key: string]: TomlNode;
}

const tomlNodeSchema: z.ZodType<TomlNode> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.date(),
    z.array(tomlNodeSchema),
    z.record(z.string(), tomlNodeSchema),
  ]),
);
const tomlTableSchema: z.ZodType<TomlTableNode> = z.record(z.string(), tomlNodeSchema);

/** One statement of the document, in source order. */
interface TomlStatement {
  /** Absolute dotted key path, including the enclosing table header. */
  path: string[];
  /** True for `[table]` and `[[table]]` headers. */
  header: boolean;
  /** Offset of the statement's first character. */
  start: number;
  /** Offset just past the statement's terminating newline. */
  end: number;
  /** Absolute spans of this statement's own key segments. */
  keySpans: Array<readonly [number, number]>;
}

/** A dotted key and the spans of its segments. */
interface TomlKey {
  path: string[];
  end: number;
  spans: Array<readonly [number, number]>;
}

/** The statements of one table and its subtree, which must be contiguous. */
interface TomlRun {
  statements: TomlStatement[];
  start: number;
  end: number;
}

/**
 * Insert, replace, or extend the table at `target`, keeping every other byte
 * of the document. A header-form table is replaced by a `[target]` block; a
 * table defined with dotted or inline keys is rewritten in place as an inline
 * table so the surrounding table body stays valid.
 */
export function upsertTomlTable(
  document: string,
  label: string,
  target: readonly string[],
  values: TomlTable,
): TomlEdit {
  const parsed = parseDocument(document, label, "use");
  const run = findRun(scanToml(document), target, label);
  if (run === undefined && tableAt(parsed, target) !== undefined) {
    throw new Error(
      `Cannot rewrite ${label}: ${pathText(target)} is defined inside another table. Remove it and re-run.`,
    );
  }
  const section = block(target, values);
  let text: string;
  if (run === undefined) {
    text = appendBlock(document, section);
  } else {
    const replacement = run.statements[0]!.header ? section : inlineAssignment(document, run, target, values, label);
    text = document.slice(0, run.start) + replacement + document.slice(run.end);
  }
  assertEdited(text, label, target, values);
  return { text, changed: text !== document };
}

/** Remove the table at `target` and everything nested under it. */
export function removeTomlTable(document: string, label: string, target: readonly string[]): TomlEdit {
  parseDocument(document, label, "use");
  const run = findRun(scanToml(document), target, label);
  if (run === undefined) return { text: document, changed: false };
  const start = swallowBlankLine(document, run.start);
  const remaining = document.slice(0, start) + document.slice(run.end);
  // Blank lines left at the top of the file are a gap, not content.
  const text = start === 0 ? remaining.replace(/^\n+/, "") : remaining;
  assertEdited(text, label, target, undefined);
  return { text, changed: true };
}

/**
 * Statements in source order. `document` must already parse: the scanner
 * locates spans, it does not validate syntax.
 */
function scanToml(document: string): TomlStatement[] {
  const statements: TomlStatement[] = [];
  let table: string[] = [];
  let at = 0;
  while (at < document.length) {
    const char = document[at]!;
    if (char === "\n" || char === "\r" || char === " " || char === "\t") {
      at++;
      continue;
    }
    if (char === "#") {
      at = skipComment(document, at);
      continue;
    }
    const start = at;
    if (char === "[") {
      const array = document[at + 1] === "[";
      const key = readKeyPath(document, at + (array ? 2 : 1));
      const close = skipSpaces(document, key.end);
      const delimiter = array ? "]]" : "]";
      if (!document.startsWith(delimiter, close)) throw malformed(document, close, `expected "${delimiter}"`);
      table = key.path;
      at = finishStatement(document, close + delimiter.length);
      statements.push({ path: key.path, header: true, start, end: at, keySpans: key.spans });
      continue;
    }
    const key = readKeyPath(document, at);
    const equals = skipSpaces(document, key.end);
    if (document[equals] !== "=") throw malformed(document, equals, 'expected "=" after the key');
    at = finishStatement(document, skipValue(document, skipSpaces(document, equals + 1)));
    statements.push({ path: [...table, ...key.path], header: false, start, end: at, keySpans: key.spans });
  }
  return statements;
}

/** Dotted key path of one key, with the spans of its segments. */
function readKeyPath(document: string, index: number): TomlKey {
  const path: string[] = [];
  const spans: Array<readonly [number, number]> = [];
  let at = skipSpaces(document, index);
  for (;;) {
    const start = at;
    const quote = document[at];
    if (quote === '"' || quote === "'") {
      const end = readString(document, at);
      path.push(quote === '"' ? decodeBasicString(document.slice(at + 1, end - 1)) : document.slice(at + 1, end - 1));
      at = end;
    } else {
      while (at < document.length && /[A-Za-z0-9_-]/.test(document[at]!)) at++;
      if (at === start) throw malformed(document, start, "expected a key");
      path.push(document.slice(start, at));
    }
    spans.push([start, at]);
    const dot = skipSpaces(document, at);
    if (document[dot] !== ".") return { path, end: at, spans };
    at = skipSpaces(document, dot + 1);
  }
}

/** Offset just past the value that starts at `index`. */
function skipValue(document: string, index: number): number {
  const char = document[index];
  if (char === '"' || char === "'") return readString(document, index);
  if (char === "[" || char === "{") return skipContainer(document, index);
  const ends = " \t\n\r#,]}";
  let at = index;
  while (at < document.length && !ends.includes(document[at]!)) at++;
  if (at === index) throw malformed(document, index, "expected a value");
  return at;
}

/** Offset just past the array or inline table that starts at `index`. */
function skipContainer(document: string, index: number): number {
  let depth = 0;
  let at = index;
  while (at < document.length) {
    const char = document[at]!;
    if (char === '"' || char === "'") {
      at = readString(document, at);
      continue;
    }
    if (char === "#") {
      at = skipComment(document, at);
      continue;
    }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") {
      depth--;
      at++;
      if (depth === 0) return at;
      continue;
    }
    at++;
  }
  throw malformed(document, index, "unterminated array or inline table");
}

/** Offset just past the string that starts at `index`, which holds a quote. */
function readString(document: string, index: number): number {
  const quote = document[index]!;
  if (document.startsWith(quote.repeat(3), index)) {
    let at = index + 3;
    while (at < document.length) {
      if (quote === '"' && document[at] === "\\") {
        at += 2;
        continue;
      }
      if (document[at] === quote) {
        let run = 0;
        while (document[at + run] === quote) run++;
        // A run of three or more quotes closes the string; at most two extra
        // quotes belong to its content.
        if (run >= 3) return at + run;
        at += run;
        continue;
      }
      at++;
    }
    throw malformed(document, index, "unterminated multiline string");
  }
  let at = index + 1;
  while (at < document.length && document[at] !== "\n") {
    if (quote === '"' && document[at] === "\\") {
      at += 2;
      continue;
    }
    if (document[at] === quote) return at + 1;
    at++;
  }
  throw malformed(document, index, "unterminated string");
}

/**
 * Offset just past the end of the line holding the statement, past a trailing
 * comment. Anything else on the line is a syntax error.
 */
function finishStatement(document: string, index: number): number {
  let at = skipSpaces(document, index);
  if (document[at] === "#") at = skipComment(document, at);
  if (at >= document.length) return at;
  if (document[at] === "\n") return at + 1;
  if (document[at] === "\r" && document[at + 1] === "\n") return at + 2;
  throw malformed(document, at, "unexpected text after the statement");
}

/** Offset of the newline that ends the comment starting at `index`. */
function skipComment(document: string, index: number): number {
  const newline = document.indexOf("\n", index);
  return newline === -1 ? document.length : newline;
}

function skipSpaces(document: string, index: number): number {
  let at = index;
  while (at < document.length && (document[at] === " " || document[at] === "\t")) at++;
  return at;
}

function decodeBasicString(raw: string): string {
  return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/gs, (_, escape: string) => {
    const kind = escape[0]!;
    if (kind === "u" || kind === "U") return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    switch (kind) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      default:
        return kind;
    }
  });
}

function malformed(document: string, offset: number, reason: string): Error {
  let line = 1;
  for (let at = 0; at < offset && at < document.length; at++) {
    if (document[at] === "\n") line++;
  }
  return new Error(`${reason} (line ${line})`);
}

/** Statements of `target` and its subtree, which must sit next to each other. */
function findRun(statements: TomlStatement[], target: readonly string[], label: string): TomlRun | undefined {
  const matching = statements.filter(
    (statement) => statement.path.length >= target.length && target.every((segment, index) => statement.path[index] === segment),
  );
  const first = matching[0];
  const last = matching[matching.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (statements.indexOf(last) - statements.indexOf(first) + 1 !== matching.length) {
    throw new Error(`Cannot rewrite ${label}: ${pathText(target)} is split across the file. Edit it by hand.`);
  }
  return { statements: matching, start: first.start, end: last.end };
}

/**
 * Rewrite a table that is defined by dotted keys as one inline-table
 * assignment, under the key text the document already uses for the target.
 */
function inlineAssignment(
  document: string,
  run: TomlRun,
  target: readonly string[],
  values: TomlTable,
  label: string,
): string {
  const head = run.statements[0]!;
  if (run.statements.some((statement) => statement.header)) {
    throw new Error(`Cannot rewrite ${label}: ${pathText(target)} mixes header and dotted keys. Edit it by hand.`);
  }
  // The statement's own key segments sit below its enclosing table headers;
  // the target's last segment ends the key text this rewrite must reuse.
  const key = head.keySpans[target.length - (head.path.length - head.keySpans.length) - 1];
  if (key === undefined) {
    throw new Error(`Cannot rewrite ${label}: ${pathText(target)} is not addressable as a key. Edit it by hand.`);
  }
  return `${document.slice(head.start, key[1])} = { ${assignments(values).join(", ")} }\n`;
}

/** `key = value` pairs, rendered in the order the table was built. */
function assignments(values: TomlTable): string[] {
  return Object.entries(values).map(
    ([key, value]) => `${tomlKey(key)} = ${Array.isArray(value) ? `[${value.map(tomlQuote).join(", ")}]` : tomlQuote(value)}`,
  );
}

/** The `[target]` header and its pairs, ready to insert as a whole table. */
function block(target: readonly string[], values: TomlTable): string {
  return [`[${pathText(target)}]`, ...assignments(values)].join("\n") + "\n";
}

function appendBlock(document: string, section: string): string {
  if (document === "") return section;
  return `${document.endsWith("\n") ? document : `${document}\n`}\n${section}`;
}

/** Take the blank line before a removed run with it, keeping the rest. */
function swallowBlankLine(document: string, start: number): number {
  return start >= 2 && document[start - 1] === "\n" && document[start - 2] === "\n" ? start - 1 : start;
}

/** `mcp_servers.diffninja`-style rendering of a key path. */
function pathText(path: readonly string[]): string {
  return path.map(tomlKey).join(".");
}

/** A bare key when the segment allows it, else a quoted one. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlQuote(key);
}

/** Escape for a control character: the short form TOML names, else `\uXXXX`. */
function controlEscape(code: number): string {
  switch (code) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

/** A TOML basic string: quotes, backslashes, and control characters escaped. */
function tomlQuote(value: string): string {
  let body = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") body += "\\\\";
    else if (char === '"') body += '\\"';
    else if (code < 0x20 || code === 0x7f) body += controlEscape(code);
    else body += char;
  }
  return `"${body}"`;
}

/** Reason a parse failed, with smol-toml's line and column when it has them. */
function describeTomlError(error: Error): string {
  if (!(error instanceof TomlError)) return `: ${error.message}`;
  const reason = error.message.replace(/^Invalid TOML document: /, "").split("\n")[0];
  return ` at line ${error.line}, column ${error.column}: ${reason}`;
}

/** Parse a document into tables, arrays, and scalars, or report why not. */
function parseDocument(document: string, label: string, action: "use" | "write"): TomlTableNode {
  let parsed: unknown;
  try {
    parsed = parse(document);
  } catch (error) {
    // SAFETY: catch bindings are unknown; normalize to Error at the boundary.
    const failure = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Cannot ${action} ${label}: not valid TOML${describeTomlError(failure)}`);
  }
  const result = tomlTableSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Cannot ${action} ${label}: not a table at the top level.`);
  return result.data;
}

/**
 * Parse the edited document and check the edit landed: the target table must
 * be exactly `values`, or absent when removing. Nothing is written otherwise.
 */
function assertEdited(
  document: string,
  label: string,
  target: readonly string[],
  values: TomlTable | undefined,
): void {
  const parsed = parseDocument(document, label, "write");
  const actual = tableAt(parsed, target);
  if (values === undefined) {
    if (actual !== undefined) throw new Error(`Cannot write ${label}: ${pathText(target)} is still defined.`);
    return;
  }
  if (actual === undefined || stable(actual) !== stable(values)) {
    throw new Error(`Cannot write ${label}: the edit does not produce the expected ${pathText(target)} table.`);
  }
}

/** Objects and dates are the only TOML values that can hold subtables. */
function isTomlTable(node: TomlNode): node is TomlTableNode {
  return node instanceof Object && !Array.isArray(node);
}

function tableAt(root: TomlTableNode, path: readonly string[]): TomlNode | undefined {
  let current: TomlNode = root;
  for (const segment of path) {
    if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** JSON shape of a value, with object keys sorted so order does not matter. */
function stable(node: TomlNode): string {
  if (Array.isArray(node)) return `[${node.map(stable).join(",")}]`;
  if (isTomlTable(node)) {
    const entries = Object.entries(node).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(node) ?? "null";
}
