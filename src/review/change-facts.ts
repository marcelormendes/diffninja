/**
 * Local, deterministic facts about the added and removed lines of one hunk.
 *
 * Without any model and without the text leaving the machine, it answers
 * existence questions that depend on what the file is. Code: did a condition or
 * comparison change, a limit, an input check, and did the lines hand an error to
 * the caller, defer it, or discard it. Documentation: did an instruction to
 * readers, a link target, or a numeric limit change. Configuration: was a CI gate
 * weakened, did permissions or secret access change, a version pin, a limit. Each
 * `yes` carries the line that produced it, so a reviewer sees what it is about.
 *
 * The analysis is lexical, not a parse: in code, strings become a placeholder and
 * comments are removed; in configuration only comments are; and patterns are
 * matched on what remains, on the changed lines of
 * each side and on the lines around them that the hunk shows. That keeps it usable
 * on a patch with no repository, and it keeps its limits plain:
 *
 *   - only file types listed here are read; any other file answers no question
 *     at all, never `no`;
 *   - a hunk with a changed line longer than {@link MAX_READ_LINE_CHARS} is not
 *     read either, rather than answered from part of that line;
 *   - `no` means the changed lines the hunk shows contain no such pattern, never
 *     that the property is absent from the file or the program;
 *   - a line moved without change cancels out, because every question compares
 *     what the removed lines had with what the added lines have.
 */

import { testLikeFile } from "./file-role.js";
import type { ReviewUnit } from "./types.js";

/** Questions asked of source code, in the order the report shows them. */
export const CODE_FACT_QUESTIONS = [
  "comparisonChanged",
  "limitChanged",
  "validationChanged",
  "failurePropagated",
  "failureDeferred",
  "failureDiscarded",
  "contractChanged",
  "dataChanged",
  "queryChanged",
] as const;

/** Questions asked of SQL files: schema and data changes. */
export const SQL_FACT_QUESTIONS = ["dataChanged"] as const;

/** Questions asked of prose (documentation): what a reader is told to do or rely on. */
export const PROSE_FACT_QUESTIONS = ["instructionChanged", "referenceChanged", "limitChanged"] as const;

/** Questions asked of configuration: CI gates, permissions, pins, and bounds. */
export const CONFIG_FACT_QUESTIONS = ["gateWeakened", "permissionChanged", "pinChanged", "limitChanged"] as const;

/** Every question, once, in report order. */
export const CHANGE_FACT_QUESTIONS = [
  ...CODE_FACT_QUESTIONS,
  "instructionChanged",
  "referenceChanged",
  "gateWeakened",
  "permissionChanged",
  "pinChanged",
] as const;

export type ChangeFactQuestion = (typeof CHANGE_FACT_QUESTIONS)[number];

export type ChangeFactAnswer = "yes" | "no";

/** Source families: how comments and strings are written, and whether indentation is syntax. */
export type CodeLanguage = "c-like" | "python" | "ruby";

/** What kind of text a file is, and so which questions apply to it. */
export type ChangeFactLanguage = CodeLanguage | "sql" | "prose" | "config";

/** The changed line a `yes` rests on, exactly as the diff shows it. */
export interface ChangeFactEvidence {
  readonly side: "added" | "removed";
  readonly text: string;
}

export interface ChangeFacts {
  /**
   * Null when this analysis does not read the hunk: a file type it cannot read,
   * or a changed line longer than {@link MAX_READ_LINE_CHARS}. Then no question is answered.
   */
  readonly language: ChangeFactLanguage | null;
  /**
   * True when the removed and added text are the same once comments and layout
   * (for prose, line breaks and spacing) are ignored. Null for an unread type.
   */
  readonly inert: boolean | null;
  /**
   * True when every changed code line is an import (a module import, `require`,
   * `using`, or a name inside a multi-line import list): wiring that other hunks
   * put to use. False for other kinds of text, and null for an unread type.
   */
  readonly importsOnly?: boolean;
  /** Exactly the questions {@link factQuestionsFor} lists for the language. */
  readonly answers: Readonly<Partial<Record<ChangeFactQuestion, ChangeFactAnswer>>>;
  readonly evidence: Readonly<Partial<Record<ChangeFactQuestion, ChangeFactEvidence>>>;
}

const C_LIKE_FILE =
  /\.(?:[cm]?[jt]sx?|java|kts?|cs|go|rs|c|h|cc|cpp|cxx|hpp|hh|swift|php|scala|dart|groovy)$/i;
const PYTHON_FILE = /\.pyi?$/i;
const RUBY_FILE = /\.rb$/i;
const SQL_FILE = /\.sql$/i;
const PROSE_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc|asciidoc)$/i;
const CONFIG_FILE =
  /\.(?:ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties)$|(?:^|\/)(?:\.env(?:\.[\w.-]+)?|Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const JSON_FILE = /\.json[c5]?$/i;

/** Evidence text is the source line, bounded so one long line cannot dominate a report. */
const EVIDENCE_TEXT_LIMIT = 160;

/**
 * The longest changed line the analysis reads. A longer one is minified or
 * generated text, or padding that would push a change past any bound on how
 * much of a line is read, so its hunk is left unread and uncertain instead.
 */
export const MAX_READ_LINE_CHARS = 4000;

/** What diffninja does not read in a hunk whose facts have no language, as a phrase after "does not read". */
export function unreadCause(file: string): string {
  return changeFactLanguageOf(file) === null ? "this file type" : `a hunk with a changed line over ${MAX_READ_LINE_CHARS.toLocaleString("en-US")} characters`;
}

export function changeFactLanguageOf(file: string): ChangeFactLanguage | null {
  if (C_LIKE_FILE.test(file)) return "c-like";
  if (PYTHON_FILE.test(file)) return "python";
  if (RUBY_FILE.test(file)) return "ruby";
  if (SQL_FILE.test(file)) return "sql";
  if (PROSE_FILE.test(file)) return "prose";
  if (CONFIG_FILE.test(file)) return "config";
  return null;
}

/** The questions a file of this kind is asked; none for an unread type. */
export function factQuestionsFor(language: ChangeFactLanguage | null): readonly ChangeFactQuestion[] {
  if (language === null) return [];
  if (language === "prose") return PROSE_FACT_QUESTIONS;
  if (language === "config") return CONFIG_FACT_QUESTIONS;
  if (language === "sql") return SQL_FACT_QUESTIONS;
  return CODE_FACT_QUESTIONS;
}

/* ------------------------------------------------------------- scanning */

/** A multi-line construct a scan is inside of when a line ends. */
type OpenBlock = "comment" | '"""' | "'''" | "`" | null;

/** Scan position carried from one line of a side to the next. */
interface ScanState {
  open: OpenBlock;
}

/** A star followed by whitespace, a slash or the end of the line: how a block comment's continuation line starts. */
const COMMENT_CONTINUATION = /^\*(?:\s|\/|$)/;

/**
 * One line with strings replaced by `S` and comments removed. `state` carries a
 * block comment or multi-line string into the next line of the same side.
 */
function scanLine(line: string, language: CodeLanguage, state: ScanState, keepStrings = false): string {
  let out = "";
  // Whether `out` holds anything but whitespace yet, kept as a flag: trimming it
  // for every character would make a long line quadratic to scan.
  let codeSeen = false;
  // A string's text, or its placeholder: facts ignore string content, while the
  // formatting-only check must see it, since changing a literal changes behavior.
  const literal = (from: number, to: number) => (keepStrings ? line.slice(from, to) : "S");
  let index = 0;
  while (index < line.length) {
    if (state.open === "comment") {
      const end = line.indexOf("*/", index);
      if (end < 0) return out;
      index = end + 2;
      state.open = null;
      continue;
    }
    if (state.open !== null) {
      const end = closingIndex(line, index, state.open);
      if (end < 0) return keepStrings ? out + line.slice(index) : out;
      if (keepStrings) out += line.slice(index, end + state.open.length);
      index = end + state.open.length;
      state.open = null;
      continue;
    }
    if (language === "c-like" && line.startsWith("//", index)) break;
    // A hunk can start inside a block comment it never shows opening: a line
    // that begins `* ` or `*/` is that comment's continuation, not code.
    if (language === "c-like" && !codeSeen && COMMENT_CONTINUATION.test(line.slice(index, index + 2))) {
      const close = line.indexOf("*/", index);
      if (close >= 0) {
        index = close + 2;
        continue;
      }
      break;
    }
    if (language === "c-like" && line.startsWith("/*", index)) {
      state.open = "comment";
      index += 2;
      continue;
    }
    if (language !== "c-like" && line.startsWith("#", index)) break;
    if (language === "python" && (line.startsWith('"""', index) || line.startsWith("'''", index))) {
      const delimiter = line.startsWith('"""', index) ? '"""' : "'''";
      const end = closingIndex(line, index + 3, delimiter);
      if (end < 0) {
        state.open = delimiter;
        return out + literal(index, line.length);
      }
      out += literal(index, end + 3);
      codeSeen = true;
      index = end + 3;
      continue;
    }
    const char = line[index];
    if (char === "`" && language === "c-like") {
      const end = closingIndex(line, index + 1, "`");
      if (end < 0) {
        state.open = "`";
        return out + literal(index, line.length);
      }
      out += literal(index, end + 1);
      codeSeen = true;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = closingIndex(line, index + 1, char);
      if (end < 0) return out + literal(index, line.length);
      out += literal(index, end + 1);
      codeSeen = true;
      index = end + 1;
      continue;
    }
    out += char;
    if (!codeSeen && char !== undefined && !/\s/.test(char)) codeSeen = true;
    index += 1;
  }
  return out;
}

/**
 * One configuration line without its `#` comment. Quoted values are kept: in
 * configuration the value is the point, and `"warn"` must stay readable. JSON
 * has no comments, so its lines are kept whole.
 */
function scanConfigLine(line: string, json: boolean): string {
  if (json) return line;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

/** Index of an unescaped `delimiter` at or after `from`, or -1. */
function closingIndex(line: string, from: number, delimiter: string): number {
  for (let index = from; index < line.length; index++) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }
    if (line.startsWith(delimiter, index)) return index;
  }
  return -1;
}

/** Code text with layout ignored: single spaces, and none next to punctuation. */
function compact(code: string): string {
  return code
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ (?=[^\w$])|(?<=[^\w$]) /g, "");
}

interface SideLine {
  /** The line as the diff shows it, without its +/-/space marker. */
  readonly raw: string;
  /** Strings as `S`, comments removed, whitespace collapsed to single spaces. */
  readonly code: string;
  /** Comments removed but string text kept: what the formatting-only check compares. */
  readonly literal: string;
  readonly changed: boolean;
  /** Leading indentation width, significant for Python. */
  readonly indent: number;
}

interface Sides {
  readonly before: SideLine[];
  readonly after: SideLine[];
}

/** How one side's lines become comparable text; state carries across a side. */
type LineScanner = (line: string, state: ScanState) => string;

/** The fact scanner and the literal-preserving scanner for one file type. */
interface Scanners {
  readonly code: LineScanner;
  readonly literal: LineScanner;
}

function scannerFor(language: ChangeFactLanguage, file: string): Scanners {
  if (language === "prose") return { code: (line) => line, literal: (line) => line };
  if (language === "sql") {
    // `--` comments go; string text stays, it is what a statement writes.
    const scan: LineScanner = (line) => line.replace(/--.*$/, "");
    return { code: scan, literal: scan };
  }
  if (language === "config") {
    const json = JSON_FILE.test(file);
    const scan: LineScanner = (line) => scanConfigLine(line, json);
    return { code: scan, literal: scan };
  }
  return {
    code: (line, state) => scanLine(line, language, state),
    literal: (line, state) => scanLine(line, language, state, true),
  };
}

/** Both sides of the hunk, or null when a changed line is too long to read. */
function sidesOf(diff: string, scanners: Scanners): Sides | null {
  const before: SideLine[] = [];
  const after: SideLine[] = [];
  const beforeState: ScanState = { open: null };
  const afterState: ScanState = { open: null };
  const beforeLiteral: ScanState = { open: null };
  const afterLiteral: ScanState = { open: null };
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // File headers precede the first hunk; inside one, `---x` is a removed `--x`.
    if (!inHunk || line.startsWith("\\")) continue;
    const marker = line[0];
    if ((marker === "-" || marker === "+") && line.length - 1 > MAX_READ_LINE_CHARS) return null;
    const raw = line.slice(1);
    const entry = (state: ScanState, literalState: ScanState, changed: boolean): SideLine => ({
      raw,
      code: scanners.code(raw, state).replace(/\s+/g, " ").trim(),
      literal: scanners.literal(raw, literalState).replace(/\s+/g, " ").trim(),
      changed,
      indent: raw.length - raw.trimStart().length,
    });
    if (marker === "-") before.push(entry(beforeState, beforeLiteral, true));
    else if (marker === "+") after.push(entry(afterState, afterLiteral, true));
    else if (marker === " " || line === "") {
      before.push(entry(beforeState, beforeLiteral, false));
      after.push(entry(afterState, afterLiteral, false));
    }
  }
  return { before, after };
}

/* --------------------------------------------------------------- patterns */

const COMPARISON_OPERATOR = /(===|!==|==|!=|(?<![<=])<=|(?<![>=])>=|(?<=\s)<(?=\s)|(?<=\s)>(?=\s))/g;
const PYTHON_COMPARISON_OPERATOR = /(\bis not\b|\bnot in\b|\bis\b)/g;
const CONDITION_KEYWORD = /\b(if|elif|while|unless|until|switch|when)\b/;
// `??` supplies a default and is not a condition a reviewer checks.
const LOGICAL_OPERATOR = /(&&|\|\||\band\b|\bor\b)/;
/** Where a logical operator is a condition: continuing one, or a returned boolean. */
const CONDITION_LINE = /^(?:return\b|&&|\|\||!|\()|(?:&&|\|\||\()\s*$/;

/**
 * Whether a line has a ternary, as the regex `\s\?\s[^:]*\s:\s` matches it, in
 * linear time. That regex rescans the rest of the line from every ` ? ` for the
 * next colon; here that colon is found once and shared by every ` ? ` before it.
 */
function hasTernary(code: string): boolean {
  let colon = code.indexOf(":");
  for (let mark = code.indexOf("?"); mark >= 0; mark = code.indexOf("?", mark + 1)) {
    if (!SPACE.test(code[mark - 1] ?? "") || !SPACE.test(code[mark + 1] ?? "")) continue;
    if (colon !== -1 && colon < mark + 2) colon = code.indexOf(":", mark + 2);
    if (colon === -1) return false;
    // The space before the colon cannot be the one after `?`.
    if (colon > mark + 2 && SPACE.test(code[colon - 1] ?? "") && SPACE.test(code[colon + 1] ?? "")) return true;
  }
  return false;
}

/** What a line is tested with: a regex, or a matcher written out where the regex would be quadratic. */
type Pattern = Pick<RegExp, "test">;

/**
 * `head`, a span up to the first `close` after it, then `tail`: the regex
 * `head[^close]*close tail`, in linear time. With `open`, the span is optional
 * and starts with it: `head(?:open[^close]*close)?tail`. The regex rescans the
 * rest of the line from every head for the next `close`, so a line of heads
 * without one took seconds; here that `close` is found once and shared.
 * `head` must be global and `tail` sticky.
 */
function spanPattern(head: RegExp, open: string | null, close: string, tail: RegExp): Pattern {
  const tailAt = (text: string, at: number) => {
    tail.lastIndex = at;
    return tail.test(text);
  };
  return {
    test: (text) => {
      let closing = text.indexOf(close);
      for (const match of text.matchAll(head)) {
        let from = (match.index ?? 0) + match[0].length;
        if (open !== null) {
          if (tailAt(text, from)) return true;
          if (text[from] !== open) continue;
          from += 1;
        }
        if (closing !== -1 && closing < from) closing = text.indexOf(close, from);
        if (closing !== -1 && tailAt(text, closing + 1)) return true;
      }
      return false;
    },
  };
}

const LIMIT_WORD =
  /\b\w*(?:timeout|limit|max|min|size|length|len|offset|index|idx|count|capacity|retries|attempts|ttl|threshold|page|batch|delay|interval|slice|substring|substr|take|skip|range|depth|width|height|bound)\w*/i;
const NUMBER = /(?<![\w$.])-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?\b/gi;
/** Non-global twin of {@link NUMBER} for `test`, which a global pattern makes stateful. */
const HAS_NUMBER = new RegExp(NUMBER.source, "i");

const VALIDATION =
  // `typeof` only as a runtime check, compared with a value: never in a type
  // position (`ConstructorParameters<typeof X>`) or inside an assertion.
  /\btypeof\s+[\w$.?[\]]+\s*[!=]==?|[!=]==?\s*typeof\b|\binstanceof\s+(?!\w*(?:Error|Exception)\b)|\b(?:isinstance|issubclass)\b|\bArray\.isArray\b|\bNumber\.is(?:Integer|Finite|NaN|SafeInteger)\b|\bis_a\?|\bkind_of\?|\binvariant\(|\b(?:validate|ensure)\w*\(|\bz\.\w+\(|\bJoi\.|\byup\.|\.safeParse\(/;

const PROPAGATION =
  /\bthrow\b|\braise\b|\breject\(|\bPromise\.reject\b|\breturn\s+(?:nil\s*,\s*)?err\b|\bErr\(|\bpanic!?\(|\bnext\(\s*(?:err|error)\b|\b(?:cb|callback|done)\(\s*(?:err|error)\b|\bfmt\.Errorf\(|\berrors\.New\(/;

/** A test assertion: its expected numbers are expectations, never bounds. */
const ASSERTION = /\b(?:expect|assert\w*|should)\s*[.(]|\bt\.\w+\(|\.to(?:Be|Equal|StrictEqual|HaveLength|Match|Contain)\w*\(/;

const DEFERRAL = /\b(?:retry|retries|retrying|retried|backoff|requeue|reschedul\w*|dead_?letter|dlq)\w*/i;

/** Values a handler returns instead of the error: a default, not a failure. */
const DEFAULT_VALUE = String.raw`(?:null|undefined|nil|None|false|False|0|-1|S|\[\s*\]|\{\s*\}|\(\s*\))`;
/** `catch` and the space after it; {@link spanPattern} reads the binding. */
const CATCH = /\bcatch\s*/g;
const INLINE_DISCARD: readonly Pattern[] = [
  new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|${DEFAULT_VALUE})\s*\)`),
  /\.catch\(\s*(?:noop|_\.noop|\(\)\s*=>\s*void\s+0)\s*\)/,
  spanPattern(CATCH, "(", ")", /\s*\{\s*\}/y),
  spanPattern(CATCH, "(", ")", new RegExp(String.raw`\s*\{\s*(?:return(?:\s+${DEFAULT_VALUE})?|continue|break)\s*;?\s*\}`, "y")),
  spanPattern(/\bexcept\b/g, null, ":", /\s*(?:pass|continue)\s*$/y),
  /\brescue\s+nil\b/,
  /^_\s*=\s*err\b/,
];
const CATCH_BLOCK = spanPattern(CATCH, "(", ")", /\s*\{\s*$/y);
const GO_ERROR_BLOCK = /\bif\s*\(?\s*err\s*!=\s*nil\s*\)?\s*\{\s*$/;
const BLOCK_HANDLER = {
  "c-like": { test: (code: string) => CATCH_BLOCK.test(code) || GO_ERROR_BLOCK.test(code) },
  python: /^except\b[^:]*:\s*$/,
  ruby: /^rescue\b/,
} satisfies Record<CodeLanguage, Pattern>;
const DISCARDING_BODY = new RegExp(
  String.raw`^(?:pass|continue|break;?|return(?:\s+${DEFAULT_VALUE}(?:\s*,\s*nil)?)?\s*;?|nil)$`,
);

/* -------------------------------------------------------------- analysis */

interface Hit {
  readonly key: string;
  readonly line: SideLine;
}

/** What one side has that the other does not, hit for hit. */
interface HitDifference {
  readonly removed: Hit[];
  readonly added: Hit[];
}

/** Removed hits with no identical added hit, and the other way round. */
function difference(before: readonly Hit[], after: readonly Hit[]): HitDifference {
  const remaining = new Map<string, number>();
  for (const hit of after) remaining.set(hit.key, (remaining.get(hit.key) ?? 0) + 1);
  const removed: Hit[] = [];
  for (const hit of before) {
    const count = remaining.get(hit.key) ?? 0;
    if (count > 0) remaining.set(hit.key, count - 1);
    else removed.push(hit);
  }
  const consumed = new Map<string, number>();
  for (const hit of before) consumed.set(hit.key, (consumed.get(hit.key) ?? 0) + 1);
  const added: Hit[] = [];
  for (const hit of after) {
    const count = consumed.get(hit.key) ?? 0;
    if (count > 0) consumed.set(hit.key, count - 1);
    else added.push(hit);
  }
  return { removed, added };
}

interface ComparisonAtom {
  readonly left: string;
  readonly operator: string;
  readonly right: string;
}

/**
 * Every comparison on a line is read, operands whole: each operand lies between
 * two operators, so the reads cover each character a bounded number of times.
 */
const OPERAND_CHAR = /[\w$.[\]]/;
const SPACE = /\s/;

/** The operand ending just before `at`: whitespace skipped, then the run of operand characters. */
function operandBefore(code: string, at: number): string {
  let end = at;
  while (end > 0 && SPACE.test(code[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && OPERAND_CHAR.test(code[start - 1] ?? "")) start -= 1;
  return code.slice(start, end);
}

/** The operand starting after `from`: whitespace skipped, an optional minus, then the run of operand characters. */
function operandAfter(code: string, from: number): string {
  let start = from;
  while (start < code.length && SPACE.test(code[start] ?? "")) start += 1;
  let end = start;
  if (code[end] === "-") end += 1;
  const bodyStart = end;
  while (end < code.length && OPERAND_CHAR.test(code[end] ?? "")) end += 1;
  return end === bodyStart ? "" : code.slice(start, end);
}

function comparisonAtoms(code: string, language: CodeLanguage): ComparisonAtom[] {
  const atoms: ComparisonAtom[] = [];
  const patterns = language === "python" ? [COMPARISON_OPERATOR, PYTHON_COMPARISON_OPERATOR] : [COMPARISON_OPERATOR];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const at = match.index ?? 0;
      atoms.push({ left: operandBefore(code, at), operator: match[0].trim(), right: operandAfter(code, at + match[0].length) });
    }
  }
  return atoms;
}

/** The condition a line tests: a keyword's guarded expression, or the whole logical line. */
function conditionOf(code: string): string | null {
  const keyword = CONDITION_KEYWORD.exec(code);
  if (keyword) {
    let rest = code.slice(keyword.index + keyword[0].length).trimStart();
    if (rest.startsWith("(")) {
      let depth = 0;
      for (let index = 0; index < rest.length; index++) {
        if (rest[index] === "(") depth += 1;
        else if (rest[index] === ")" && --depth === 0) return compact(`${keyword[0]} ${rest.slice(0, index + 1)}`);
      }
      return compact(`${keyword[0]} ${rest}`);
    }
    rest = rest.replace(/\s*[:{]\s*$/, "");
    return compact(`${keyword[0]} ${rest}`);
  }
  // A line of a multi-line condition, or a returned boolean; an assignment such
  // as `const x = a || b` combines values and is not a condition by itself.
  if ((LOGICAL_OPERATOR.test(code) && CONDITION_LINE.test(code)) || hasTernary(code)) return compact(code);
  return null;
}

function conditionHits(lines: readonly SideLine[], language: CodeLanguage): Hit[] {
  const hits: Hit[] = [];
  for (const line of lines) {
    if (!line.changed || line.code === "") continue;
    const condition = conditionOf(line.code);
    if (condition !== null) hits.push({ key: `cond:${condition}`, line });
    for (const atom of comparisonAtoms(line.code, language)) {
      hits.push({ key: `cmp:${atom.left}${atom.operator}${atom.right}`, line });
    }
  }
  return hits;
}

/** Changed lines whose code matches `pattern`, keyed by their layout-free code. */
function lineHits(lines: readonly SideLine[], pattern: RegExp): Hit[] {
  return lines
    .filter((line) => line.changed && line.code !== "" && pattern.test(line.code))
    .map((line) => ({ key: compact(line.code), line }));
}

/** Each bound operator and its strict or non-strict twin. */
const STRICTNESS = new Map([["<", "<="], ["<=", "<"], [">", ">="], [">=", ">"]]);
const isNumber = (token: string) => /^-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?$/i.test(token);

/**
 * For each group of `items`, the index of its first item and of the first after
 * it with another value. Whatever value a lookup brings, one of the two is the
 * group's first item with a different value: a lookup instead of a scan of
 * every item, which made pairing one side of a hunk with the other quadratic.
 */
function firstDiffering<T>(
  items: readonly T[],
  groupOf: (item: T) => string | null,
  valueOf: (item: T) => string,
): (group: string, value: string) => number | undefined {
  const groups = new Map<string, { first: number; other?: number }>();
  items.forEach((item, index) => {
    const group = groupOf(item);
    if (group === null) return;
    const seen = groups.get(group);
    if (seen === undefined) groups.set(group, { first: index });
    else if (seen.other === undefined && valueOf(item) !== valueOf(items[seen.first])) seen.other = index;
  });
  return (group, value) => {
    const seen = groups.get(group);
    if (seen === undefined) return undefined;
    return valueOf(items[seen.first]) !== value ? seen.first : seen.other;
  };
}

/**
 * A bound whose admitted range changed: the same comparison with a strict and a
 * non-strict operator swapped, or a numeric side changed; or a line naming a limit
 * whose only difference is a number.
 */
function limitHit(removed: readonly Hit[], added: readonly Hit[], language: CodeLanguage): Hit | null {
  // A line has one hit per condition and per comparison; its comparisons are read once, not once per hit.
  const atomsOf = (hits: readonly Hit[]) => {
    const seen = new Set<SideLine>();
    const atoms: Array<{ atom: ComparisonAtom; hit: Hit }> = [];
    for (const hit of hits) {
      if (seen.has(hit.line)) continue;
      seen.add(hit.line);
      for (const atom of comparisonAtoms(hit.line.code, language)) atoms.push({ atom, hit });
    }
    return atoms;
  };
  // For the first removed comparison that has one, the earliest added comparison
  // that moves its bound, found by lookups in the added side. Comparing every
  // pair was quadratic, and the cap that bounded it let padding hide the change.
  const candidates = atomsOf(added);
  const exact = new Map<string, number>();
  candidates.forEach(({ atom }, index) => {
    const key = `${atom.left}\n${atom.operator}\n${atom.right}`;
    if (!exact.has(key)) exact.set(key, index);
  });
  const sameLeft = firstDiffering(candidates, ({ atom }) => (isNumber(atom.right) ? `${atom.left}\n${atom.operator}` : null), ({ atom }) => atom.right);
  const sameRight = firstDiffering(candidates, ({ atom }) => (isNumber(atom.left) ? `${atom.right}\n${atom.operator}` : null), ({ atom }) => atom.left);
  for (const { atom: before } of atomsOf(removed)) {
    const twin = STRICTNESS.get(before.operator);
    // The same operands with the strict and non-strict operator swapped.
    const found = [twin === undefined ? undefined : exact.get(`${before.left}\n${twin}\n${before.right}`)];
    // The same direction, one side the same and the other a different number.
    for (const operator of twin === undefined ? [before.operator] : [before.operator, twin]) {
      if (isNumber(before.right)) found.push(sameLeft(`${before.left}\n${operator}`, before.right));
      if (isNumber(before.left)) found.push(sameRight(`${before.right}\n${operator}`, before.left));
    }
    const earliest = Math.min(...found.filter((index): index is number => index !== undefined));
    if (earliest !== Infinity) return candidates[earliest].hit;
  }
  return null;
}

function numericLimitHit(before: readonly SideLine[], after: readonly SideLine[]): Hit | null {
  const limitLines = (lines: readonly SideLine[]) =>
    lines
      .filter((line) => line.changed && line.code !== "" && LIMIT_WORD.test(line.code) && HAS_NUMBER.test(line.code) && !ASSERTION.test(line.code))
      .map((line) => ({ key: compact(line.code), numberless: compact(line.code.replace(NUMBER, "N")), line }));
  // For the first removed line that has one, the earliest added line of the
  // same form, numbers aside, with other numbers.
  const added = limitLines(after);
  const differing = firstDiffering(added, (line) => line.numberless, (line) => line.key);
  for (const old of limitLines(before)) {
    const index = differing(old.numberless, old.key);
    if (index !== undefined) return added[index];
  }
  return null;
}

/**
 * A changed condition that guards a raise. It is an input check, whatever it tests,
 * and the raise it controls is a failure handed to the caller on a path the
 * changed line controls, even when the raise itself is unchanged context.
 */
function guardHits(lines: readonly SideLine[], changedConditions: ReadonlySet<SideLine>): Hit[] {
  const hits: Hit[] = [];
  lines.forEach((line, index) => {
    if (!changedConditions.has(line)) return;
    let after = index + 1;
    while (after < lines.length && lines[after].code === "") after += 1;
    const next: SideLine | undefined = lines[after];
    if (PROPAGATION.test(line.code) || (next !== undefined && PROPAGATION.test(next.code))) {
      hits.push({ key: `guard:${compact(line.code)}`, line });
    }
  });
  return hits;
}

/** Handlers that swallow the error, anchored on a changed line of this side. */
function discardHits(lines: readonly SideLine[], language: CodeLanguage): Hit[] {
  const hits: Hit[] = [];
  lines.forEach((line, index) => {
    if (line.code === "") return;
    if (INLINE_DISCARD.some((pattern) => pattern.test(line.code))) {
      if (line.changed) hits.push({ key: `discard:${compact(line.code)}`, line });
      return;
    }
    if (!BLOCK_HANDLER[language].test(line.code)) return;
    const body: SideLine[] = [];
    let closed = false;
    for (let after = index + 1; after < lines.length; after++) {
      const candidate = lines[after];
      if (candidate.code === "") continue;
      if (language === "python" && candidate.indent <= line.indent) {
        closed = true;
        break;
      }
      if (language !== "python" && candidate.code.startsWith("}")) {
        body.push(candidate);
        closed = true;
        break;
      }
      if (language === "ruby" && /^end\b/.test(candidate.code)) {
        body.push(candidate);
        closed = true;
        break;
      }
      body.push(candidate);
      if (body.length > 2) break;
    }
    const statements = body.filter((candidate) => !/^\}|^end\b/.test(candidate.code));
    const swallows =
      (closed || language === "python") &&
      statements.length <= 1 &&
      statements.every((candidate) => DISCARDING_BODY.test(candidate.code));
    const involved = [line, ...body];
    if (swallows && involved.some((candidate) => candidate.changed)) {
      hits.push({ key: `discard:${involved.map((candidate) => compact(candidate.code)).join("|")}`, line });
    }
  });
  return hits;
}

function evidenceOf(hit: Hit, side: "added" | "removed"): ChangeFactEvidence {
  const text = hit.line.raw.trim();
  return { side, text: text.length > EVIDENCE_TEXT_LIMIT ? `${text.slice(0, EVIDENCE_TEXT_LIMIT - 1)}…` : text };
}

/** First surviving hit, added side first: the new code is what a reviewer reads. */
function firstEvidence(diff: HitDifference): ChangeFactEvidence | null {
  if (diff.added.length > 0) return evidenceOf(diff.added[0], "added");
  if (diff.removed.length > 0) return evidenceOf(diff.removed[0], "removed");
  return null;
}

function isInert(sides: Sides, language: CodeLanguage | "config"): boolean {
  const key = (line: SideLine) => (language === "python" ? `${line.indent}:${compact(line.literal)}` : compact(line.literal));
  const code = (lines: readonly SideLine[]) => lines.filter((line) => line.changed && line.literal !== "").map(key);
  const before = code(sides.before);
  const after = code(sides.after);
  return before.length === after.length && before.every((value, index) => value === after[index]);
}

/* ----------------------------------------------------- prose and config */

/** Words that tell a reader what they must, may, or may not do or rely on. */
const NORMATIVE =
  /\b(?:must|shall|should|required|requires|never|always|only|cannot|can't|do not|don't|deprecated|breaking|at most|at least|not supported|unsupported|recommended)\b/i;
/** A link target or bare URL. */
const REFERENCE = /\]\(\s*<?([^)\s>]+)|(https?:\/\/[^\s)>"'\]]+)/g;

/** Settings that turn a failing CI check into a passing or advisory one. */
const GATE_WEAKENING =
  /continue-on-error:\s*true|allow_failure:\s*true|\|\|\s*true\b|\bset\s+\+e\b|--no-verify\b|\bif:\s*false\b|\bskip\b|\bwarn(?:ing)?\b|\bignore\b|fail_?[oO]n_?[eE]rror\W+false|--passWithNoTests|\bexit\s+0\b|--force\b/i;
/**
 * A step that runs a check; fewer of them after the change is a weaker gate.
 * `^(?=(.*?X))\1` takes the first `run` or `uses:` once, since a lookahead does
 * not backtrack, and a check after any later one is also after the first. The
 * plain `run.*test` rescanned the line from every `run`, quadratic on a long line.
 */
const CHECK_STEP =
  /^(?=(.*?\b(?:run|script|command)\b))\1.*\b(?:test|tests|lint|check|audit|verify|typecheck|tsc|vitest|jest|pytest|mypy|eslint|oxlint)\b|^(?=(.*?\buses:))\2.*\b(?:codeql|lint|test|scan)/i;
const PERMISSION =
  /\bpermissions\b|:\s*write(?:-all)?\b|\bwrite-all\b|\bpull_request_target\b|\bsecrets\.|\bid-token\b|\bGITHUB_TOKEN\b|\bprivileged:\s*true|\ballowPrivilegeEscalation\b|\brunAsUser:\s*0\b|^USER\s+root\b|\bsudo\b/i;
const PIN_SETTING = /\bimage:\s*\S+|^FROM\s|\bversion\b|"[@\w./-]+"\s*:\s*"\s*[\^~<>=*]?\s*(?:v?\d|latest|\*)/i;
const USES = /\buses:\s*/gi;
const WHITESPACE = /\s/g;

/**
 * `uses:` naming a ref, as `uses:\s*\S+@` matches it, in linear time. That regex
 * rescanned the rest of the word from every `uses:` in it; here the next `@` and
 * the next space are found once and shared.
 */
function usesRef(text: string): boolean {
  let mark = text.indexOf("@");
  let space = -1;
  for (const match of text.matchAll(USES)) {
    const word = (match.index ?? 0) + match[0].length;
    if (word >= text.length) return false;
    if (mark !== -1 && mark <= word) mark = text.indexOf("@", word + 1);
    if (mark === -1) return false;
    if (space < word) {
      WHITESPACE.lastIndex = word;
      space = WHITESPACE.exec(text)?.index ?? text.length;
    }
    if (mark < space) return true;
  }
  return false;
}

const PIN: Pattern = { test: (text) => PIN_SETTING.test(text) || usesRef(text) };

/** Changed lines of one side whose text carries each link target they name. */
function referenceHits(lines: readonly SideLine[]): Hit[] {
  const hits: Hit[] = [];
  for (const line of lines) {
    if (!line.changed) continue;
    for (const match of line.raw.matchAll(REFERENCE)) hits.push({ key: match[1] ?? match[2], line });
  }
  return hits;
}

/** Changed lines matching `pattern`, keyed by their text with case and spacing ignored. */
function textHits(lines: readonly SideLine[], pattern: Pattern): Hit[] {
  return lines
    .filter((line) => line.changed && line.code !== "" && pattern.test(line.code))
    .map((line) => ({ key: line.code.toLowerCase(), line }));
}

/** The same words in the same order on both sides: reflowed or respaced prose. */
function proseInert(sides: Sides): boolean {
  const words = (lines: readonly SideLine[]) =>
    lines.filter((line) => line.changed).map((line) => line.code).join(" ").split(/\s+/).filter((word) => word !== "");
  const before = words(sides.before);
  const after = words(sides.after);
  return before.length === after.length && before.every((word, index) => word === after[index]);
}

type Recorder = (question: ChangeFactQuestion, found: ChangeFactEvidence | null) => void;

/**
 * A declaration others build on: an exported symbol, an HTTP route, a DTO or
 * entity field, or a public method or function signature. Read on code with
 * strings set aside, so a string that looks like a declaration never counts.
 */
const CONTRACT: readonly RegExp[] = [
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|abstract)\b/,
  /^@(?:Get|Post|Put|Patch|Delete|All|Controller|Resolver|Query|Mutation|Column|PrimaryColumn|PrimaryGeneratedColumn|Entity|ManyToOne|OneToMany|OneToOne|ManyToMany|JoinColumn|Index|Unique|Is[A-Z]\w*|Min|Max|Length|ValidateNested|Type|Transform|Api(?:Property|ResponseProperty)\w*|Field|Prop|Schema)\b/,
  /^(?:public\s+|static\s+|async\s+|override\s+|readonly\s+)*(?!(?:if|for|while|switch|catch|return|function|await|new|else|do|try)\b)[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^={;]+)?\s*\{$/,
  // Modifiers are part of the type run: listing them in a loop before it made
  // every split between the two a new try, quadratic on a line of modifiers.
  /^(?:public|protected)\s+[\w<>[\],.? ]+\s+\w+\s*\(/,
  /^def\s+[A-Za-z]\w*\s*\(/,
  /^class\s+[A-Z]\w*/,
  /^func\s+(?:\([^)]*\)\s*)?[A-Z]\w*\s*\(/,
  /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\b/,
];

/** Schema changes and writes to stored data, in SQL text or a migration builder call. */
const DATA_CHANGE =
  /\b(?:ALTER\s+(?:TABLE|TYPE|INDEX|VIEW|SEQUENCE)|ADD\s+VALUE|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TYPE|VIEW|MATERIALIZED\s+VIEW)|DROP\s+(?:TABLE|COLUMN|INDEX|TYPE|VIEW|CONSTRAINT|SCHEMA)|ADD\s+(?:COLUMN|CONSTRAINT)|RENAME\s+(?:COLUMN|TO)|TRUNCATE|DELETE\s+FROM|UPDATE\s+[\w."]+\s+SET|INSERT\s+INTO)\b|\b(?:addColumn|dropColumn|renameColumn|changeColumn|createTable|dropTable|alterTable|renameTable|createIndex|dropIndex|createForeignKey|dropForeignKey|removeColumn|addIndex|removeIndex|addConstraint|removeConstraint|bulkInsert|bulkUpdate|bulkDelete)\s*\(/i;

/** A migration directory: whatever changes there changes the schema or stored data. */
const MIGRATION_PATH = /(?:^|\/)migrations?\//i;

/** Changed lines whose literal text (comments removed, strings kept) matches. */
function literalHits(lines: readonly SideLine[], pattern: RegExp): Hit[] {
  return lines
    .filter((line) => line.changed && line.literal !== "" && pattern.test(line.literal))
    .map((line) => ({ key: compact(line.literal), line }));
}

/**
 * SQL written inside the code's strings: upper-case clause keywords that appear
 * in a line's string text but not in its code, so identifiers and prose do not count.
 */
const SQL_QUERY = /\b(?:SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION|CASE WHEN|RETURNING|ON CONFLICT|WITH [a-z_]+ AS)\b/;

function queryHits(lines: readonly SideLine[]): Hit[] {
  return lines
    .filter((line) => line.changed && SQL_QUERY.test(line.literal) && !SQL_QUERY.test(line.code))
    .map((line) => ({ key: `sql:${compact(line.literal)}`, line }));
}

function contractHits(lines: readonly SideLine[]): Hit[] {
  return lines
    .filter((line) => line.changed && line.code !== "" && CONTRACT.some((pattern) => pattern.test(line.code)))
    .map((line) => ({ key: compact(line.code), line }));
}

function proseFacts(sides: Sides, record: Recorder): void {
  record("instructionChanged", firstEvidence(difference(textHits(sides.before, NORMATIVE), textHits(sides.after, NORMATIVE))));
  record("referenceChanged", firstEvidence(difference(referenceHits(sides.before), referenceHits(sides.after))));
  const limit = numericLimitHit(sides.before, sides.after);
  record("limitChanged", limit === null ? null : evidenceOf(limit, "added"));
}

/**
 * Bookkeeping files whose numbers record state, not bounds. `^(?=([\s\S]*X))\1`
 * takes the last keyword once: if a plain name runs from any keyword to the
 * extension, one runs from the last. Trying every keyword was quadratic on a long path.
 */
const BOOKKEEPING_FILE = /^(?=([\s\S]*(?:suppressions?|baseline|snapshot|lock)))\1[\w.-]*\.(?:json|ya?ml|toml)$/i;

function configFacts(sides: Sides, record: Recorder, file: string): void {
  const weakening = difference(textHits(sides.before, GATE_WEAKENING), textHits(sides.after, GATE_WEAKENING));
  const checksBefore = textHits(sides.before, CHECK_STEP);
  const checksAfter = textHits(sides.after, CHECK_STEP);
  const removedCheck = difference(checksBefore, checksAfter).removed;
  // Added weakening settings, or fewer check steps than before; removing a
  // weakening setting strengthens the gate and is not reported here.
  const gate =
    weakening.added.length > 0
      ? evidenceOf(weakening.added[0], "added")
      : checksBefore.length > checksAfter.length && removedCheck.length > 0
        ? evidenceOf(removedCheck[0], "removed")
        : null;
  record("gateWeakened", gate);
  record("permissionChanged", firstEvidence(difference(textHits(sides.before, PERMISSION), textHits(sides.after, PERMISSION))));
  record("pinChanged", firstEvidence(difference(textHits(sides.before, PIN), textHits(sides.after, PIN))));
  const limit = BOOKKEEPING_FILE.test(file) ? null : numericLimitHit(sides.before, sides.after);
  record("limitChanged", limit === null ? null : evidenceOf(limit, "added"));
}

function codeFacts(sides: Sides, language: CodeLanguage, record: Recorder, file: string): void {
  const conditions = difference(conditionHits(sides.before, language), conditionHits(sides.after, language));
  record("comparisonChanged", firstEvidence(conditions));

  const limit = limitHit(conditions.removed, conditions.added, language) ?? numericLimitHit(sides.before, sides.after);
  record("limitChanged", limit === null ? null : evidenceOf(limit, "added"));

  const changedConditionLines = new Set([...conditions.removed, ...conditions.added].map((hit) => hit.line));
  const validation = difference(
    [...lineHits(sides.before, VALIDATION).filter((hit) => !ASSERTION.test(hit.line.code)), ...guardHits(sides.before, changedConditionLines)],
    [...lineHits(sides.after, VALIDATION).filter((hit) => !ASSERTION.test(hit.line.code)), ...guardHits(sides.after, changedConditionLines)],
  );
  // A test's checks and mocks are not input validation of the code under review.
  record("validationChanged", testLikeFile(file) ? null : firstEvidence(validation));

  record(
    "failurePropagated",
    firstEvidence(
      difference(
        [...lineHits(sides.before, PROPAGATION), ...guardHits(sides.before, changedConditionLines)],
        [...lineHits(sides.after, PROPAGATION), ...guardHits(sides.after, changedConditionLines)],
      ),
    ),
  );
  record("failureDeferred", firstEvidence(difference(lineHits(sides.before, DEFERRAL), lineHits(sides.after, DEFERRAL))));
  record("failureDiscarded", firstEvidence(difference(discardHits(sides.before, language), discardHits(sides.after, language))));
  // A migration's up/down is not a contract others build on; its data fact covers it.
  if (!MIGRATION_PATH.test(file)) {
    record("contractChanged", firstEvidence(difference(contractHits(sides.before), contractHits(sides.after))));
  }
  record("queryChanged", firstEvidence(difference(queryHits(sides.before), queryHits(sides.after))));
  const data = firstEvidence(difference(literalHits(sides.before, DATA_CHANGE), literalHits(sides.after, DATA_CHANGE)));
  record("dataChanged", data ?? (MIGRATION_PATH.test(file) && !testLikeFile(file) ? firstChangedLine(sides) : null));
}

/** Lines that say nothing about what a migration does. */
const TRIVIAL_LINE = /^(?:S;?|import\b|export\s*\{|(?:const|let|var)\s+[\w{}\s,:]+=\s*require\(|[{}()[\];,]+$|module\.exports\s*=\s*\{$)/;

/** The first telling changed line, added side first: what a migration hunk does. */
function firstChangedLine(sides: Sides): ChangeFactEvidence | null {
  const telling = (line: SideLine) => line.changed && line.code !== "" && !TRIVIAL_LINE.test(line.code);
  const added = sides.after.find(telling);
  if (added !== undefined) return evidenceOf({ key: "", line: added }, "added");
  const removed = sides.before.find(telling);
  return removed === undefined ? null : evidenceOf({ key: "", line: removed }, "removed");
}

/** The facts for one hunk, each `yes` with the changed line it rests on. */
export function changeFactsOf(unit: Pick<ReviewUnit, "file" | "diff">): ChangeFacts {
  const language = changeFactLanguageOf(unit.file);
  if (language === null) return { language, inert: null, answers: {}, evidence: {} };

  const sides = sidesOf(unit.diff, scannerFor(language, unit.file));
  if (sides === null) return { language: null, inert: null, answers: {}, evidence: {} };
  const answers: Partial<Record<ChangeFactQuestion, ChangeFactAnswer>> = {};
  for (const question of factQuestionsFor(language)) answers[question] = "no";
  const evidence: Partial<Record<ChangeFactQuestion, ChangeFactEvidence>> = {};
  const record: Recorder = (question, found) => {
    if (found === null) return;
    answers[question] = "yes";
    evidence[question] = found;
  };

  if (language === "prose") {
    proseFacts(sides, record);
    return { language, inert: proseInert(sides), answers, evidence };
  }
  if (language === "config") {
    configFacts(sides, record, unit.file);
    return { language, inert: isInert(sides, language), answers, evidence };
  }
  if (language === "sql") {
    record("dataChanged", firstEvidence(difference(literalHits(sides.before, DATA_CHANGE), literalHits(sides.after, DATA_CHANGE))));
    return { language, inert: isInert(sides, "config"), answers, evidence };
  }
  codeFacts(sides, language, record, unit.file);
  return { language, inert: isInert(sides, language), importsOnly: importsOnly(sides), answers, evidence };
}

const IMPORT_START = /^(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+[\w.]+\s+import\b|using\s+[\w.]+\s*;|(?:const|let|var)\s+[\w{}\s,:]+=\s*require\()/;
// `(?=([^;]*\{))\1` takes the last `{` before any `;` once: if a `}` follows it,
// one follows every earlier `{`, and trying each of them was quadratic.
const IMPORT_LIST_OPEN = /^(?:import\b(?=([^;]*\{))\1[^}]*$|import\s*\($|from\s+[\w.]+\s+import\s*\($|export\s*\{[^}]*$)/;
const IMPORT_LIST_CLOSE = /[})]/;

const IMPORT_LIST_ITEM = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/;
const IMPORT_LIST_END = /^\}\s*from\b/;

/** Whether each changed line of a side sits in an import statement or list. */
function importLines(lines: readonly SideLine[]): boolean[] {
  // A hunk can start inside an import list whose `import {` it never shows: names
  // that run down to a `} from '…'` line belong to that list.
  const tail: boolean[] = Array.from({ length: lines.length }, () => false);
  let inTail = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const code = lines[index].code.trim();
    if (IMPORT_LIST_END.test(code)) inTail = true;
    else if (inTail && !(IMPORT_LIST_ITEM.test(code) || code === "")) inTail = false;
    tail[index] = inTail;
  }
  let inList = false;
  return lines.map((line, index) => {
    if (tail[index]) return true;
    const code = line.code.trim();
    if (inList) {
      if (IMPORT_LIST_CLOSE.test(code)) inList = false;
      return true;
    }
    if (IMPORT_LIST_OPEN.test(code)) {
      inList = true;
      return true;
    }
    return IMPORT_START.test(code);
  });
}

function importsOnly(sides: Sides): boolean {
  let changed = 0;
  for (const lines of [sides.before, sides.after]) {
    const imports = importLines(lines);
    for (const [index, line] of lines.entries()) {
      if (!line.changed || line.code === "") continue;
      changed += 1;
      if (!imports[index]) return false;
    }
  }
  return changed > 0;
}
