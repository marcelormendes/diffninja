import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  definitionReader,
  type DefinitionReader,
} from "../src/review/source.js";
import type { Snapshot } from "../src/types.js";

/**
 * Definition source reads against a real repository: the reader never leaves
 * the snapshot it was given, states nothing it cannot read, copies the
 * definition's own comment verbatim, and carries the whole span rather than a
 * preview.
 */

const SLASH_FILE = "src/comments.ts";
const DOCSTRING_FILE = "src/docstrings.py";
const LONG_FILE = "src/long.ts";
const LONG_LINE_FILE = "src/minified.ts";
const LONG_BODY = Array.from({ length: 30 }, (_unused, index) => `  const v${index} = ${index};`);
const LONG_DEFINITION_LINE = 2;
const LONG_END_LINE = LONG_DEFINITION_LINE + LONG_BODY.length + 1;
/** Longer than the char budget a trimmed preview used to cut a long line at. */
const MINIFIED_LINE = `export function minified() { return "${"x".repeat(6000)}"; }`;

const SLASH_SOURCE = [
  "// A leading line comment.",
  "export function lineCommented() {",
  "  return 1;",
  "}",
  "",
  "/**",
  " * A block comment prose line.",
  " * Trailing prose that is not the description.",
  " */",
  "export function blockCommented() {",
  "  return 2;",
  "}",
  "",
  "export function undocumented() {",
  "  return 3;",
  "}",
  "",
  "/** First line, with <script>alert(\"raw\")</script> copied verbatim.",
  "",
  " * Second paragraph is not the description.",
  " */",
  "export function paragraphCommented() {",
  "  return 4;",
  "}",
  "",
  "// Detached by a blank line.",
  "",
  "export function detached() {",
  "  return 5;",
  "}",
  "",
  "/**",
  " * ============",
  " * Prose after a separator line.",
  " */",
  "export function separatorFirst() {",
  "  return 6;",
  "}",
  "",
].join("\n");

const DOCSTRING_SOURCE = [
  '"""Module docstring is not a definition."""',
  "",
  "# A leading comment stands in for a docstring.",
  "def commented():",
  "    return 1",
  "",
  "",
  "def documented():",
  '    """Reserves stock.',
  "",
  "    More prose.",
  '    """',
  "    return 2",
  "",
  "",
  "def single_line_docstring():",
  '    """One line."""',
  "    return 3",
  "",
  "",
  "def no_docstring():",
  "    value = 4",
  "    return value",
  "",
  "",
  "# Grounds the decorated function.",
  "@decorator_wrapper",
  "def decorated():",
  "    return 5",
  "",
  "",
  "def trailing_comment(a):  # a trailing comment with a colon: here",
  '    """Docs after a trailing comment."""',
  "    return 6",
  "",
  "",
  "def trailing_no_doc(a):  # comment, and no docstring below",
  "    return 7",
  "",
  "",
  "def after_no_doc():",
  '    """Only this one is documented."""',
  "    return 8",
  "",
  "",
  "def multiline_signature(",
  "    a,",
  "    b,",
  ") -> int:",
  '    """Docs after a multi-line signature."""',
  "    return 9",
  "",
  "",
  "def formatted_prefix():",
  '    f"""Not a docstring: an f-string is not a constant."""',
  "    return 10",
  "",
  "",
  "def escaped_signature(a, \\",
  "    b):",
  '    """Docs after an escaped signature."""',
  "    return 11",
  "",
].join("\n");

let repo = "";
let reader: DefinitionReader;
let revision: Snapshot;

function definitionAt(file: string, line: number, endLine?: number) {
  return endLine === undefined ? { file, line } : { file, line, endLine };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "diffninja-source-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, SLASH_FILE), SLASH_SOURCE);
  writeFileSync(join(repo, DOCSTRING_FILE), DOCSTRING_SOURCE);
  writeFileSync(
    join(repo, LONG_FILE),
    `/** Long but bounded. */\nexport function longDefinition() {\n${LONG_BODY.join("\n")}\n}\n`,
  );
  writeFileSync(join(repo, LONG_LINE_FILE), `/** One long line. */\n${MINIFIED_LINE}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "definitions"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: repo, encoding: "utf8" }).trim();
  revision = { kind: "commit", ref: sha };
  reader = definitionReader(repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("definition source reader", () => {
  test("reads the committed revision, so a changed worktree cannot alter it", () => {
    const committed = reader(definitionAt(SLASH_FILE, 2, 4), revision);
    expect(committed.source).toMatchObject({
      file: SLASH_FILE,
      line: 2,
      endLine: 4,
      ref: revision.ref.slice(0, 8),
    });
    expect(committed.source?.text).toBe("export function lineCommented() {\n  return 1;\n}");
    expect(committed.description).toBe("A leading line comment.");

    const worktreePath = join(repo, SLASH_FILE);
    writeFileSync(worktreePath, "// Rewritten in the worktree.\nexport function lineCommented() {\n  return 99;\n}\n");
    try {
      const later = reader(definitionAt(SLASH_FILE, 2, 4), { kind: "worktree", ref: "WORKTREE" });
      expect(later.source?.text).toContain("return 99;");
      expect(later.source?.ref).toBe("WORKTREE");
      // The commit snapshot is unaffected by the rewrite above.
      expect(reader(definitionAt(SLASH_FILE, 2, 4), revision).source?.text).toBe(
        "export function lineCommented() {\n  return 1;\n}",
      );
    } finally {
      writeFileSync(worktreePath, SLASH_SOURCE);
    }
  });

  test("a file or span the revision cannot confirm yields nothing", () => {
    expect(reader(definitionAt("src/absent.ts", 1), revision)).toEqual({});
    expect(reader(definitionAt(SLASH_FILE, 500), revision)).toEqual({});
    expect(reader(definitionAt(SLASH_FILE, 3, 900), revision)).toEqual({});
    expect(reader(definitionAt(SLASH_FILE, 0), revision)).toEqual({});
    expect(reader(definitionAt(SLASH_FILE, 2, 4), { kind: "commit", ref: "deadbeef" })).toEqual({});
  });

  test("each snapshot file is read once and reused", () => {
    const first = reader(definitionAt(SLASH_FILE, 2, 4), revision);
    const second = reader(definitionAt(SLASH_FILE, 2, 4), revision);
    expect(second).toEqual(first);

    // With the repository gone, only a cached file can still be answered: a
    // new definition in the same file succeeds, another file cannot be read.
    const other = mkdtempSync(join(tmpdir(), "diffninja-source-cache-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: other });
      writeFileSync(join(other, "a.ts"), "export function a() {\n  return 1;\n}\n");
      writeFileSync(join(other, "b.ts"), "export function b() {\n  return 2;\n}\n");
      execFileSync("git", ["add", "."], { cwd: other });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "base"], { cwd: other });
      const cached = definitionReader(other);
      const snapshot: Snapshot = { kind: "commit", ref: execFileSync("git", ["rev-parse", "HEAD"], { cwd: other, encoding: "utf8" }).trim() };
      expect(cached(definitionAt("a.ts", 1, 3), snapshot).source).toBeDefined();

      rmSync(join(other, ".git"), { recursive: true, force: true });

      expect(cached(definitionAt("a.ts", 1, 3), snapshot).source?.text).toContain("return 1;");
      expect(cached(definitionAt("b.ts", 1, 3), snapshot)).toEqual({});
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("the description is the first prose line of the attached comment", () => {
    const cases: Array<[string, number, string | undefined]> = [
      ["lineCommented", 2, "A leading line comment."],
      ["blockCommented", 10, "A block comment prose line."],
      ["undocumented", 14, undefined],
      ["paragraphCommented", 22, 'First line, with <script>alert("raw")</script> copied verbatim.'],
      ["detached", 28, undefined],
      ["separatorFirst", 36, "Prose after a separator line."],
    ];
    for (const [name, line, description] of cases) {
      const detail = reader({ file: SLASH_FILE, line }, revision);
      expect({ name, description: detail.description }).toEqual({ name, description });
    }
  });

  test("a Python docstring is used first, and decorators are stepped over", () => {
    const cases: Array<[string, number, string | undefined]> = [
      ["commented", 4, "A leading comment stands in for a docstring."],
      ["documented", 8, "Reserves stock."],
      ["single_line_docstring", 16, "One line."],
      ["no_docstring", 21, undefined],
      ["decorated", 28, "Grounds the decorated function."],
      ["trailing_comment", 32, "Docs after a trailing comment."],
      ["trailing_no_doc", 37, undefined],
      ["after_no_doc", 41, "Only this one is documented."],
      ["multiline_signature", 46, "Docs after a multi-line signature."],
      ["formatted_prefix", 54, undefined],
      ["escaped_signature", 59, "Docs after an escaped signature."],
    ];
    for (const [name, line, description] of cases) {
      const detail = reader({ file: DOCSTRING_FILE, line }, revision);
      expect({ name, description: detail.description }).toEqual({ name, description });
    }
  });

  test("a definition longer than a preview would be is carried whole", () => {
    const detail = reader(definitionAt(LONG_FILE, LONG_DEFINITION_LINE, LONG_END_LINE), revision);
    const lines = detail.source?.text.split("\n") ?? [];

    expect(detail.source).toMatchObject({ line: LONG_DEFINITION_LINE, endLine: LONG_END_LINE });
    // Every line of the span is present: the report has no repository to fall
    // back on, so a cut would hide the rest of the function for good.
    expect(lines).toEqual(["export function longDefinition() {", ...LONG_BODY, "}"]);
    expect(detail.description).toBe("Long but bounded.");
  });

  test("a single line longer than a character budget is not cut", () => {
    const detail = reader(definitionAt(LONG_LINE_FILE, 2, 2), revision);

    expect(detail.source?.text).toBe(MINIFIED_LINE);
    expect(detail.source?.text.length).toBeGreaterThan(2000);
  });

  test("a definition within the snapshot keeps its exact lines", () => {
    const detail = reader(definitionAt(SLASH_FILE, 2, 4), revision);
    expect(detail.source?.text).toBe(SLASH_SOURCE.split("\n").slice(1, 4).join("\n"));
  });
});
