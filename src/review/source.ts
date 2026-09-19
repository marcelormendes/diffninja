/**
 * Definition source for report call-flow nodes, read from the snapshot the
 * definition lived in. Nothing here is generated: a definition whose file or
 * span cannot be read honestly yields no detail rather than an approximation,
 * and the description is the definition's own attached comment or docstring,
 * copied verbatim.
 *
 * The whole span `line`..`endLine` is carried: a trimmed preview would leave
 * the rest of the function readable only online, which is exactly what an
 * offline report cannot do. Only what git cannot confirm is withheld.
 */

import { readSnapshotFile } from "../git.js";
import { detectLanguage } from "../languages/registry.js";
import type { Snapshot, SourceLoc } from "../types.js";
import type { CallFlowSource } from "./types.js";

/** Definition source and attached prose for one node; either field may be absent. */
export interface DefinitionDetail {
  source?: CallFlowSource;
  description?: string;
}

/** Reads one definition's detail; a Snapshot identifies the immutable revision. */
export type DefinitionReader = (
  definition: SourceLoc,
  snapshot: Snapshot,
) => DefinitionDetail;

/** Line and block comment markers, keyed by extractor id. */
interface CommentSyntax {
  line: string[];
  block?: [string, string];
}

const SLASH_COMMENTS: CommentSyntax = { line: ["//"], block: ["/*", "*/"] };

const COMMENT_SYNTAX = new Map<string, CommentSyntax>(Object.entries({
  bash: { line: ["#"] },
  c: SLASH_COMMENTS,
  cpp: SLASH_COMMENTS,
  csharp: SLASH_COMMENTS,
  elixir: { line: ["#"] },
  go: SLASH_COMMENTS,
  haskell: { line: ["--"], block: ["{-", "-}"] },
  java: SLASH_COMMENTS,
  javascript: SLASH_COMMENTS,
  javascriptreact: SLASH_COMMENTS,
  kotlin: SLASH_COMMENTS,
  lua: { line: ["--"], block: ["--[[", "]]"] },
  ocaml: { line: [], block: ["(*", "*)"] },
  perl: { line: ["#"] },
  php: SLASH_COMMENTS,
  python: { line: ["#"] },
  ruby: { line: ["#"] },
  rust: SLASH_COMMENTS,
  scala: SLASH_COMMENTS,
  solidity: SLASH_COMMENTS,
  swift: SLASH_COMMENTS,
  typescript: SLASH_COMMENTS,
  typescriptreact: SLASH_COMMENTS,
  zig: SLASH_COMMENTS,
} satisfies Record<string, CommentSyntax>));

/** Split snapshot text into lines without keeping a second copy of the file. */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Definition source reader with one snapshot-file read per revision and path.
 * The cache holds parsed lines, so a repeated call site of the same definition
 * costs a slice rather than a `git show`.
 */
export function definitionReader(cwd: string): DefinitionReader {
  const files = new Map<string, string[] | null>();

  const linesOf = (snapshot: Snapshot, file: string): string[] | null => {
    const key = `${snapshot.kind}\0${snapshot.ref}\0${file}`;
    const cached = files.get(key);
    if (cached !== undefined) return cached;
    const text = readSnapshotFile(cwd, snapshot, file);
    const lines = text === null ? null : splitLines(text);
    files.set(key, lines);
    return lines;
  };

  return (definition, snapshot) => {
    const lines = linesOf(snapshot, definition.file);
    if (!lines) return {};
    const line = definition.line;
    const endLine = definition.endLine ?? line;
    // A span the snapshot cannot cover means the definition is not at that
    // place in this revision, so nothing about it can be stated.
    if (line < 1 || endLine < line || endLine > lines.length) return {};
    const description = leadingDescription(definition.file, lines, line);
    const source: CallFlowSource = {
      file: definition.file,
      line,
      endLine,
      ref: snapshot.ref.slice(0, 8),
      text: lines.slice(line - 1, endLine).join("\n"),
    };
    return description === undefined ? { source } : { source, description };
  };
}

/**
 * First prose line of the definition's attached leading comment, or of its
 * Python docstring. Decorators between comment and definition are stepped over.
 */
function leadingDescription(
  file: string,
  lines: readonly string[],
  line: number,
): string | undefined {
  const language = detectLanguage(file)?.id;
  const syntax = language === undefined ? undefined : COMMENT_SYNTAX.get(language);
  if (language === "python") {
    const docstring = pythonDocstring(lines, line);
    if (docstring !== undefined) return docstring;
    return commentProse(syntax, lines, decoratorAnchor(lines, line));
  }
  return commentProse(syntax, lines, line);
}

/** Top-most line of the decorator run directly above a Python definition. */
function decoratorAnchor(lines: readonly string[], line: number): number {
  let anchor = line;
  for (let index = anchor - 2; index >= 0; index -= 1) {
    if (!(lines[index] ?? "").trimStart().startsWith("@")) break;
    anchor = index + 1;
  }
  return anchor;
}

/**
 * Prose of a comment block directly above `line`. A blank line breaks
 * attachment, and a block comment whose opener is not found is dropped rather
 * than attributed to the definition.
 */
function commentProse(
  syntax: CommentSyntax | undefined,
  lines: readonly string[],
  line: number,
): string | undefined {
  if (!syntax) return undefined;
  const above = (line - 2 >= 0 ? lines[line - 2] ?? "" : "").trim();
  if (above === "") return undefined;

  const block = syntax.block;
  const collected: string[] = [];
  if (block && above.endsWith(block[1])) {
    let opened = false;
    for (let index = line - 2; index >= 0; index -= 1) {
      const text = lines[index] ?? "";
      collected.unshift(text);
      if (text.includes(block[0])) {
        opened = true;
        break;
      }
    }
    if (!opened) return undefined;
  } else if (syntax.line.some((prefix) => above.startsWith(prefix))) {
    for (let index = line - 2; index >= 0; index -= 1) {
      const text = (lines[index] ?? "").trim();
      if (!syntax.line.some((prefix) => text.startsWith(prefix))) break;
      collected.unshift(lines[index] ?? "");
    }
  } else {
    return undefined;
  }

  return firstProseLine(syntax, collected);
}

/** First line of a comment block that carries prose, with markers stripped. */
function firstProseLine(
  syntax: CommentSyntax,
  block: readonly string[],
): string | undefined {
  for (const raw of block) {
    let text = raw.trim();
    if (syntax.block) {
      const [open, close] = syntax.block;
      if (text.startsWith(open)) text = text.slice(open.length).trim();
      if (text.endsWith(close)) text = text.slice(0, -close.length).trim();
    }
    for (const prefix of syntax.line) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length);
        break;
      }
    }
    if (syntax.block && text.startsWith("*")) text = text.slice(1);
    text = text.trim();
    // Separator lines (`---`, `***`) carry no prose.
    if (text !== "" && !/^[*=~_+-]+$/.test(text)) return text;
  }
  return undefined;
}

/** Lines a Python signature may span before its colon is given up on. */
const PYTHON_SIGNATURE_MAX_LINES = 40;

/**
 * One Python signature line: the bracket depth its code opens and the last
 * non-space character of that code. Comment text and string contents are
 * skipped, so a `#` or a bracket inside them cannot end the line or unbalance
 * the count, and a comment can trail the colon it hides.
 */
function signatureLine(text: string) {
  let last = "";
  let delta = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== "") {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "#") break;
    if (char !== " " && char !== "\t") last = char;
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") delta += 1;
    else if (char === ")" || char === "]" || char === "}") delta -= 1;
  }
  return { last, delta };
}

/**
 * Last line of a Python signature: the line whose code ends with `:` at bracket
 * depth zero. A trailing comment cannot hide the colon and no line before it is
 * skipped, so the search never walks on into the next definition and returns
 * that one's docstring as this one's description.
 */
function signatureEnd(
  lines: readonly string[],
  line: number,
): number | undefined {
  let depth = 0;
  const last = Math.min(line + PYTHON_SIGNATURE_MAX_LINES, lines.length);
  for (let current = line; current <= last; current += 1) {
    const { last: code, delta } = signatureLine(lines[current - 1] ?? "");
    depth += delta;
    if (depth > 0) continue;
    if (code === ":") return current;
    // Only an open bracket or an explicit continuation carries the signature to
    // the next line; anything else is the body, so there is no signature here.
    if (code !== "\\") return undefined;
  }
  return undefined;
}

/**
 * First prose line of a Python docstring: the first string statement of the
 * body. The signature is stepped over first, so a signature spanning several
 * lines still finds its own docstring, and a body that opens with anything
 * other than a string states no description.
 */
function pythonDocstring(
  lines: readonly string[],
  line: number,
): string | undefined {
  const body = signatureEnd(lines, line);
  if (body === undefined) return undefined;

  for (let index = body; index < lines.length; index += 1) {
    const text = (lines[index] ?? "").trim();
    if (text === "" || text.startsWith("#")) continue;
    const open = /^(?:[rRuU]{0,2})("""|''')/.exec(text)?.[1];
    if (!open) return undefined;
    const rest = text.slice(text.indexOf(open) + open.length);
    const sameLine = rest.indexOf(open);
    const opening = sameLine >= 0 ? rest.slice(0, sameLine) : rest;
    // Prose on the opening line is the first line, the usual `"""Summary.`
    // shape; only an opener standing alone moves the search below it.
    if (opening.trim() !== "") return proseOfDocstring([opening]);
    const collected: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const raw = lines[next] ?? "";
      const close = raw.indexOf(open);
      if (close >= 0) {
        collected.push(raw.slice(0, close));
        break;
      }
      collected.push(raw);
    }
    return proseOfDocstring(collected);
  }
  return undefined;
}

/** First non-empty line of docstring content, verbatim. */
function proseOfDocstring(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    const text = raw.trim();
    if (text !== "") return text;
  }
  return undefined;
}
