import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { CHANGE_FACT_QUESTIONS, MAX_READ_LINE_CHARS, changeFactsOf, type ChangeFactQuestion } from "../src/review/change-facts.js";
import { reviewUnits } from "../src/review/pipeline.js";

/** A hunk from marked lines: "-" removed, "+" added, anything else context. */
function hunk(...lines: string[]): string {
  return ["@@ -1,1 +1,1 @@", ...lines.map((line) => (/^[+-]/.test(line) ? line : ` ${line}`))].join("\n");
}

function yesOf(file: string, diff: string): ChangeFactQuestion[] {
  const facts = changeFactsOf({ file, diff });
  return CHANGE_FACT_QUESTIONS.filter((question) => facts.answers[question] === "yes");
}

describe("change facts", () => {
  test("a relaxed bound is a comparison, a limit, a guarded input check, and a propagated failure", () => {
    const facts = changeFactsOf({
      file: "src/check.ts",
      diff: hunk(
        "export function check(amount: number) {",
        "-  if (amount <= 0) throw new Error('invalid');",
        "+  if (amount < 0) throw new Error('invalid');",
        "}",
      ),
    });
    expect(facts.answers).toEqual({
      comparisonChanged: "yes",
      limitChanged: "yes",
      validationChanged: "yes",
      failurePropagated: "yes",
      failureDeferred: "no",
      failureDiscarded: "no",
      contractChanged: "no",
      dataChanged: "no",
      queryChanged: "no",
    });
    expect(facts.evidence.limitChanged).toEqual({ side: "added", text: "if (amount < 0) throw new Error('invalid');" });
    expect(facts.inert).toBe(false);
  });

  test("a changed guard makes the unchanged raise below it a propagated failure", () => {
    expect(
      yesOf(
        "lib/client.js",
        hunk(
          "-if (opts.max != null && !Number.isInteger(opts.size)) {",
          "+if (opts.max != null && !Number.isInteger(opts.max)) {",
          "  throw new InvalidArgumentError('max must be an integer')",
          "}",
        ),
      ),
    ).toEqual(["comparisonChanged", "validationChanged", "failurePropagated"]);
  });

  test("a numeric bound in a named limit changes without a comparison", () => {
    expect(yesOf("src/a.ts", hunk("-const timeoutMs = 5_000;", "+const timeoutMs = 30_000;"))).toEqual(["limitChanged"]);
  });

  test("an expected number in a test assertion is not a limit", () => {
    expect(yesOf("test.js", hunk("-t.is(limit.activeCount, 1);", "+t.is(limit.activeCount, 2);"))).toEqual([]);
  });

  test("a moved line cancels out, and strings and comments never match", () => {
    expect(
      yesOf(
        "src/a.ts",
        hunk(
          "-if (count > max) {",
          "-  throw new Error('if (a > b) retry later');",
          "-}",
          "+// if (x < y) throw; catch {}",
          "+if (count > max) {",
          "+  throw new Error('if (a > b) retry later');",
          "+}",
        ),
      ),
    ).toEqual([]);
  });

  test("detects deferred and discarded failures", () => {
    expect(yesOf("src/a.ts", hunk("+await withRetry(() => send(payload), { retries: 3 });"))).toContain(
      "failureDeferred",
    );
    expect(yesOf("src/a.ts", hunk("+const value = await load().catch(() => null);"))).toEqual(["failureDiscarded"]);
    expect(yesOf("src/a.ts", hunk("try {", "  run();", "-} catch (error) { report(error); }", "+} catch {}"))).toEqual(
      ["failureDiscarded"],
    );
    expect(
      yesOf("src/a.ts", hunk("try {", "  run();", "+} catch (error) {", "+  return [];", "+}")),
    ).toEqual(["failureDiscarded"]);
    // A handler that reports the error does not discard it.
    expect(
      yesOf("src/a.ts", hunk("try {", "  run();", "+} catch (error) {", "+  logger.error(error);", "+  throw error;", "+}")),
    ).toEqual(["failurePropagated"]);
  });

  test("reads Python and Go handlers", () => {
    expect(
      yesOf("app/load.py", hunk("try:", "    load()", "-except ValueError as error:", "-    raise", "+except ValueError:", "+    pass")),
    ).toEqual(["failurePropagated", "failureDiscarded"]);
    expect(yesOf("app/load.py", hunk("-if value is None:", "+if value is not None:"))).toEqual(["comparisonChanged"]);
    expect(yesOf("pkg/load.go", hunk("v, err := load()", "+if err != nil {", "+\treturn nil, nil", "+}"))).toEqual([
      "comparisonChanged",
      "failureDiscarded",
    ]);
    expect(yesOf("pkg/load.go", hunk("+\treturn nil, fmt.Errorf(\"load: %w\", err)"))).toEqual(["failurePropagated"]);
  });

  test("a formatting- or comment-only change is inert, and Python indentation is not layout", () => {
    expect(
      changeFactsOf({ file: "src/a.ts", diff: hunk("-const total=a+b; // sum", "+const total = a + b;") }).inert,
    ).toBe(true);
    expect(changeFactsOf({ file: "src/a.ts", diff: hunk("-const total = a + b;", "+const total = a - b;") }).inert).toBe(
      false,
    );
    expect(
      changeFactsOf({ file: "a.py", diff: hunk("if ready:", "-    run()", "+run()") }).inert,
    ).toBe(false);
    // Changing the text of a string changes behavior, even though facts ignore it.
    expect(
      changeFactsOf({ file: "src/a.ts", diff: hunk("-  description: 'Marks rows as FAILED',", "+  description: 'Marks rows as DONE',") }).inert,
    ).toBe(false);
    expect(
      changeFactsOf({ file: "src/a.ts", diff: hunk("-  'multi ' +", "-  'line',", "+  'multi line',") }).inert,
    ).toBe(false);
  });

  test("a removed line whose text starts with dashes is still a removed line", () => {
    expect(yesOf("src/a.ts", "@@ -1,1 +1,1 @@\n---count > 0 && retry();\n+--count > 1 && retry();")).toContain(
      "comparisonChanged",
    );
  });

  test("answers nothing for a file type it cannot read, never no", () => {
    const facts = changeFactsOf({ file: "schema/query.graphql", diff: hunk("-type A { a: Int }", "+type A { a: String }") });
    expect(facts.language).toBeNull();
    expect(facts.inert).toBeNull();
    expect(facts.answers).toEqual({});
    expect(facts.evidence).toEqual({});
  });

  test("public contracts: exports, routes, DTO and entity fields, and public signatures", () => {
    for (const [file, line] of [
      ["src/a.ts", "+export async function syncLeases(ids: string[]): Promise<void> {"],
      ["src/a.controller.ts", "+  @Post('enrollments/:id/approve')"],
      ["src/a.dto.ts", "+  @IsOptional()"],
      ["src/a.entity.ts", "+  @Column({ nullable: true })"],
      ["src/a.service.ts", "+  async approveEnrollment(id: string, actor: Actor): Promise<Enrollment> {"],
      ["app/a.py", "+def approve(enrollment_id):"],
      ["pkg/a.go", "+func Approve(id string) error {"],
    ]) {
      expect(yesOf(file, hunk(line)), line).toContain("contractChanged");
    }
    // Private helpers, calls, and control flow are not contracts.
    for (const line of ["+  private normalize(value: string): string {", "+  if (ready) {", "+  await this.repo.save(entity);", "+const x = 'export function fake() {';"]) {
      expect(yesOf("src/a.ts", hunk(line)), line).not.toContain("contractChanged");
    }
  });

  test("precision: defaults, type positions, assertions, and migrations are not facts", () => {
    expect(yesOf("src/a.ts", hunk("+  const charges = response?.payload?.charges ?? [];"))).toEqual([]);
    expect(yesOf("src/a.ts", hunk("+  config: ConstructorParameters<typeof RateLimiter>[0],"))).not.toContain("validationChanged");
    expect(yesOf("src/a.spec.ts", hunk("+  charges.forEach((c) => expect(typeof c.amount).toBe('number'));"))).not.toContain("validationChanged");
    expect(yesOf("src/a.ts", hunk("+  if (typeof value !== 'number') throw new TypeError('value');"))).toContain("validationChanged");
    expect(yesOf("src/db/migrations/1700.js", hunk("+  async up(queryInterface) {"))).not.toContain("contractChanged");
  });

  test("a hunk that starts inside a block comment reads its continuation lines as comment", () => {
    expect(yesOf("src/a.ts", hunk("   * transitions, requeue). The HTTP call", "+ * retries with backoff when the provider throws", "   */"))).toEqual([]);
    expect(yesOf("src/a.ts", hunk("+ */ if (count > max) throw new Error('x');"))).toContain("comparisonChanged");
  });

  test("error formatting, value defaults, and suppression counts are not facts", () => {
    expect(yesOf("src/a.ts", hunk("+  error: error instanceof Error ? error.message : String(error),"))).not.toContain("validationChanged");
    expect(yesOf("src/a.ts", hunk("+  const needsEligibility = options.internetEligible || options.internetOptOut;"))).toEqual([]);
    expect(yesOf("src/a.ts", hunk("+  rawStatuses.includes(EnrollmentStatus.Active) ||"))).toContain("comparisonChanged");
    expect(yesOf("apps/api/eslint-suppressions.json", hunk('-      "count": 20', '+      "count": 21'))).toEqual([]);
    expect(yesOf("test/a.spec.ts", hunk("+      expect.objectContaining({ anomaly_count: 240 }),", "-      expect.objectContaining({ anomaly_count: 5 }),"))).toEqual([]);
    expect(yesOf("test/a.spec.ts", hunk("+  if (calls === 2) {", "+    throw new Error('db down');", "+  }"))).not.toContain("validationChanged");
    expect(yesOf("src/db/migrations/test/1700.spec.ts", hunk("+import { INestApplication } from '@nestjs/common';"))).not.toContain("dataChanged");
    expect(changeFactsOf({ file: "src/db/migrations/1700.js", diff: hunk("+'use strict';", "+", "+module.exports = {", "+  async up(q) {", "+    await q.addIndex('leases', ['status']);") }).evidence.dataChanged?.text).toBe(
      "await q.addIndex('leases', ['status']);",
    );
  });

  test("imports only: statements, requires, and names inside a multi-line import list", () => {
    const only = (diff: string) => changeFactsOf({ file: "src/a.ts", diff }).importsOnly;
    expect(only(hunk("-import { a } from './a';", "+import { a, b } from './a';"))).toBe(true);
    expect(only(hunk("import {", "  toReviewAddress,", "+  toReviewEvidence,", "} from '../utils';"))).toBe(true);
    expect(only(hunk("+const { x } = require('./x');"))).toBe(true);
    // A hunk that starts inside the list, its `import {` above the hunk.
    expect(only(hunk("  formatFilterSize,", "+  hasNonPositiveDimension,", "} from './helpers';", "import { PageDto } from '~/pagination';"))).toBe(true);
    expect(only(hunk("+import { b } from './b';", "+const value = b(1);"))).toBe(false);
    expect(only(hunk("+  evidence: toReviewEvidence(review),"))).toBe(false);
    expect(changeFactsOf({ file: "app/a.py", diff: hunk("+from app.utils import load") }).importsOnly).toBe(true);
  });

  test("a database query written in the code's strings", () => {
    expect(yesOf("src/search.service.ts", hunk(
      "   const rows = await this.db.query(`",
      "-    SELECT id, name FROM properties WHERE active",
      "+    SELECT id, name, score FROM ranked WHERE score > :min ORDER BY score DESC",
      "   `);",
    ))).toContain("queryChanged");
    // Words in prose or identifiers are not SQL.
    expect(yesOf("src/a.ts", hunk("+  const message = 'select a plan from the list';"))).not.toContain("queryChanged");
    expect(yesOf("src/a.ts", hunk("+  const fromDate = where(select);"))).not.toContain("queryChanged");
  });

  test("schema and stored data: SQL in migrations and .sql files, and migration builder calls", () => {
    expect(yesOf("src/db/migrations/1700-add-col.ts", hunk("+    await queryRunner.query('ALTER TABLE enrollments ADD COLUMN approved_at timestamptz');"))).toContain("dataChanged");
    expect(yesOf("src/db/migrations/1700.ts", hunk("+    await queryRunner.dropColumn('leases', 'legacy_id');"))).toContain("dataChanged");
    expect(yesOf("db/fix.sql", hunk("+DELETE FROM leases WHERE end_date < now();"))).toEqual(["dataChanged"]);
    expect(yesOf("src/db/migrations/20260922-enum.js", hunk("+      `ALTER TYPE \"${ENUM_NAME}\" ADD VALUE IF NOT EXISTS 'X';`,"))).toContain("dataChanged");
    expect(yesOf("src/db/seed.js", hunk("+    await queryInterface.bulkUpdate('leases', { active: false }, {});"))).toContain("dataChanged");
    // Anything that changes inside a migrations directory changes the schema or data.
    expect(yesOf("src/db/migrations/20260922-noop.js", hunk("+  async down() {}"))).toContain("dataChanged");
    expect(yesOf("db/fix.sql", hunk("-SELECT 1;", "+SELECT 2;"))).toEqual([]);
    expect(changeFactsOf({ file: "db/fix.sql", diff: hunk("-SELECT 1; -- old", "+SELECT 1;") }).inert).toBe(true);
    // A comment that mentions SQL is not a data change.
    expect(yesOf("src/a.ts", hunk("+// TODO: DELETE FROM leases later"))).not.toContain("dataChanged");
  });

  test("prose: instructions, link targets, and numeric limits; a heading is not a comment", () => {
    expect(yesOf("README.md", hunk("-## Retries", "+## Retries", "-You may retry.", "+You must not retry more than once."))).toEqual([
      "instructionChanged",
    ]);
    expect(yesOf("docs/a.md", hunk("-[guide](https://a.dev/v1/guide)", "+[guide](https://a.dev/v2/guide)"))).toEqual([
      "referenceChanged",
    ]);
    expect(yesOf("docs/a.rst", hunk("-The request timeout is 30 seconds.", "+The request timeout is 5 seconds."))).toEqual([
      "limitChanged",
    ]);
    expect(yesOf("docs/a.md", hunk("-Welcome, reader.", "+Welcome, dear reader."))).toEqual([]);
    expect(changeFactsOf({ file: "docs/a.md", diff: hunk("-a b", "-c", "+a", "+b c") }).inert).toBe(true);
  });

  test("config: weakened gates, in every common form, and removed check steps", () => {
    for (const added of [
      "+        continue-on-error: true",
      "+      run: npm test || true",
      "+  allow_failure: true",
      "+          statusCodes: '{\"403\":\"warn\"}'",
      "+    if: false",
    ]) {
      expect(yesOf(".github/workflows/ci.yml", hunk(added)), added).toContain("gateWeakened");
    }
    expect(yesOf(".github/workflows/ci.yml", hunk("       - run: npm ci", "-      - run: npm test"))).toContain("gateWeakened");
    // Removing a weakening setting strengthens the gate.
    expect(yesOf(".github/workflows/ci.yml", hunk("-        continue-on-error: true"))).not.toContain("gateWeakened");
    // A changed check command is not a removed check.
    expect(yesOf(".github/workflows/ci.yml", hunk("-      - run: npm test", "+      - run: npm test -- --coverage"))).not.toContain(
      "gateWeakened",
    );
  });

  test("config: permissions, pins, limits, and comment-only edits", () => {
    expect(yesOf(".github/workflows/ci.yml", hunk("+permissions:", "+  contents: write"))).toContain("permissionChanged");
    expect(yesOf(".github/workflows/ci.yml", hunk("-      - uses: actions/checkout@v4", "+      - uses: actions/checkout@main"))).toEqual([
      "pinChanged",
    ]);
    expect(yesOf("package.json", hunk('-    "lodash": "^4.17.20",', '+    "lodash": "*",'))).toContain("pinChanged");
    expect(yesOf("deploy.yml", hunk("-    timeout-minutes: 10", "+    timeout-minutes: 60"))).toContain("limitChanged");
    expect(changeFactsOf({ file: "deploy.yml", diff: hunk("-replicas: 2 # old", "+replicas: 2") }).inert).toBe(true);
    // JSON has no comments: a # inside a value is content.
    expect(changeFactsOf({ file: "a.json", diff: hunk('-  "tag": "a"', '+  "tag": "a #b"') }).inert).toBe(false);
  });
});

/**
 * Every regex written in change-facts.ts: its regex literals, and each `new RegExp`
 * over a String.raw template, with the String.raw constants it names filled in.
 */
function sourceRegexes(): RegExp[] {
  const text = readFileSync(new URL("../src/review/change-facts.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("change-facts.ts", text, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  const rawText = (node: ts.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isTaggedTemplateExpression(node)) return rawText(node.template);
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.rawText;
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce(
        (out, span) => out + (constants.get(span.expression.getText(file)) ?? "") + (span.literal.rawText ?? ""),
        node.head.rawText ?? "",
      );
    }
    return undefined;
  };
  const regexes: RegExp[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isTaggedTemplateExpression(node.initializer)) {
      constants.set(node.name.getText(file), rawText(node.initializer) ?? "");
    } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.getText(file);
      const end = literal.lastIndexOf("/");
      regexes.push(new RegExp(literal.slice(1, end), literal.slice(end + 1)));
    } else if (ts.isNewExpression(node) && node.expression.getText(file) === "RegExp") {
      const source = rawText(node.arguments?.[0]);
      if (source !== undefined) regexes.push(new RegExp(source, rawText(node.arguments?.[1]) ?? ""));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return regexes;
}

/**
 * Lines built to strain a regex from its own source: each run of literal text
 * (`\s` read as a space, `\s*` as nothing, escaped punctuation as itself), alone,
 * spaced, and joined to the next run, repeated to `length` characters, then
 * also after a run that follows `^` and before a character a negated class stops at.
 */
function strainingLines(source: string, length: number): string[] {
  const runs: string[] = [];
  const starts: string[] = [];
  const stops: string[] = [];
  let run = "";
  let anchored = false;
  const flush = () => {
    if (run === "") return;
    runs.push(run);
    if (anchored) starts.push(`${run} `);
    anchored = false;
    run = "";
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1] ?? "";
    if (char === "\\") {
      index += 1;
      if (next === "s") run += "*?".includes(source[index + 1] ?? "") ? "" : " ";
      else if (/[A-Za-z0-9]/.test(next)) flush();
      else run += next;
    } else if (char === "[") {
      flush();
      const negated = next === "^";
      for (index += negated ? 2 : 1; index < source.length && source[index] !== "]"; index++) {
        if (source[index] === "\\") index += 1;
        else if (negated) stops.push(source[index]);
      }
    } else if (char === "(") {
      flush();
      if (next === "?") index += source[index + 2] === "<" && /[=!]/.test(source[index + 3] ?? "") ? 3 : 2;
    } else if (char === "{" && /^\{\d+(?:,\d*)?\}/.test(source.slice(index))) {
      index = source.indexOf("}", index);
    } else if (char === "^") {
      flush();
      anchored = true;
    } else if ("|)$.".includes(char)) {
      flush();
    } else if (!"*+?".includes(char)) {
      run += char;
    }
  }
  flush();
  const units = new Set<string>();
  runs.forEach((unit, index) => {
    const following = runs[index + 1] ?? "";
    for (const candidate of [unit, `${unit} `, unit + following, `${unit} ${following}`]) if (candidate.trim() !== "") units.add(candidate);
  });
  const lines = new Set<string>();
  for (const unit of units) {
    const body = unit.repeat(Math.ceil(length / unit.length));
    for (const start of ["", ...starts]) for (const stop of ["", ...stops]) lines.add(start + body + stop);
  }
  return [...lines];
}

describe("change facts on hostile or generated lines", () => {
  // A pull request chooses its lines. These took minutes (16,000 characters of `=` took
  // 155 s) while the whole MCP server, every other tool call included, waited.
  const generous = 3000;
  const timed = (work: () => void): number => {
    const started = performance.now();
    work();
    return performance.now() - started;
  };
  /** Time to read `diff`, measured against a same-sized ordinary one, so a slower machine moves both. */
  const withinLinear = (file: string, diff: string, ordinary: string, label: string) => {
    changeFactsOf({ file, diff: hunk("-a();", "+b();") });
    const baseline = timed(() => changeFactsOf({ file, diff: ordinary }));
    const elapsed = timed(() => changeFactsOf({ file, diff }));
    expect(elapsed, `${label}: ${Math.round(elapsed)} ms against ${Math.round(baseline)} ms`).toBeLessThan(Math.max(4 * baseline, 500));
  };
  const context = (line: string) => hunk(line, "-a();", "+b();", line);
  const lines = (count: number, make: (index: number) => string) => ["@@ -1,1 +1,1 @@", ...Array.from({ length: count }, (_, index) => make(index))].join("\n");

  // Detects a regex that rescans the rest of a line from every place it could start:
  // on the old patterns `catch(`, `except `, ` ? `, `run `, `uses:`, `public static `,
  // `import {…}` and a path of `lock`s took from 0.2 to 12 seconds at this length.
  test("every pattern stays linear on a long line of its own literal text", () => {
    const regexes = sourceRegexes();
    expect(regexes.length).toBeGreaterThan(50);
    const scan = (pattern: RegExp, line: string) => {
      const everyMatch = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
      return timed(() => line.replace(everyMatch, ""));
    };
    const slow: string[] = [];
    for (const pattern of regexes) {
      for (const line of strainingLines(pattern.source, 100_000)) {
        // Measured twice before it counts, so one pause for garbage collection is not a failure.
        if (scan(pattern, line) > 250 && scan(pattern, line) > 250) slow.push(`/${pattern.source}/ on ${JSON.stringify(line.slice(0, 40))}`);
      }
    }
    expect(slow).toEqual([]);
  });

  // Detects facts read from part of a line: a changed line past the bound was read whole
  // (seconds for 200 KB) and answered, where padding decides what the answer rests on.
  test("a changed line longer than the analysis reads leaves the hunk unread and uncertain", () => {
    for (const [file, unit] of [["src/a.ts", "catch("], ["src/a.ts", " ? "], ["src/a.py", "except "], ["src/A.java", "public static "], [".github/workflows/ci.yml", "run "], [".github/workflows/ci.yml", "uses:"]]) {
      const line = unit.repeat(Math.ceil(200_000 / unit.length));
      for (const diff of [hunk("-old();", `+${line}`), hunk(`-${line}`, "+new();")]) {
        expect(changeFactsOf({ file, diff }), `${file} ${JSON.stringify(unit)}`).toEqual({ language: null, inert: null, answers: {}, evidence: {} });
      }
    }
    const relaxed = hunk("-if (n <= 10) stop();", `+if (n < 10) stop(); // ${"x".repeat(MAX_READ_LINE_CHARS)}`);
    expect(changeFactsOf({ file: "src/a.ts", diff: relaxed }).answers).toEqual({});
    const unit = { id: "a", file: "test/a.test.ts", header: "@@ -1,1 +1,1 @@", newStart: 1, oldStart: 1, added: 1, removed: 1, diff: relaxed };
    expect(reviewUnits([unit]).items[0].status).toBe("uncertain");
    expect(changeFactsOf({ file: "src/a.ts", diff: hunk(`+${"x".repeat(MAX_READ_LINE_CHARS)}`) }).language).toBe("c-like");
    expect(changeFactsOf({ file: "src/a.ts", diff: hunk(`+${"x".repeat(MAX_READ_LINE_CHARS + 1)}`) }).language).toBeNull();
  });

  // Detects an operand read only up to a window: a change past its 200th character was invisible.
  test("a change deep inside a long operand is still a changed bound", () => {
    const bound = (last: string) => `if (x <= 1${"0".repeat(248)}${last}) stop();`;
    expect(yesOf("src/a.ts", hunk(`-${bound("0")}`, `+${bound("1")}`))).toContain("limitChanged");
  });

  // Detects the handler patterns rescanning a context line (also read, but never bounded)
  // from every `catch` or `except`: 200 KB took 8 to 16 seconds, and `import {…}` 12.
  test("a long context line is read in linear time", () => {
    const ordinary = context("x".repeat(200_000));
    for (const unit of ["catch (", "catch(", ".catch( ", "except ", "if err != nil { "]) {
      for (const file of ["src/a.ts", "src/a.py", "src/a.rb"]) {
        withinLinear(file, context(unit.repeat(Math.ceil(200_000 / unit.length))), ordinary, `${file} ${JSON.stringify(unit)}`);
      }
    }
    withinLinear("src/a.ts", context(`import ${"{".repeat(200_000)}}`), ordinary, "import {…}");
  });

  // Detects a pattern quadratic within one line at the bound: two megabytes of such lines
  // took 0.8 to 2.6 seconds against 0.12 for ordinary ones.
  test("a hunk of lines at the read bound is read in linear time", () => {
    const atBound = (text: string) => lines(500, () => `+${text.repeat(Math.ceil(MAX_READ_LINE_CHARS / text.length)).slice(0, MAX_READ_LINE_CHARS)}`);
    const ordinary = atBound("x = 1; ");
    for (const [file, unit] of [["src/a.ts", " ? "], ["src/a.ts", "catch ("], ["src/a.py", "except "], ["src/A.java", "public static "], [".github/workflows/ci.yml", "run "], [".github/workflows/ci.yml", "uses:"]]) {
      const text = unit === "public static " ? `public ${"static ".repeat(MAX_READ_LINE_CHARS / 7)}` : unit;
      withinLinear(file, atBound(text), ordinary, `${file} ${JSON.stringify(unit)}`);
    }
  });

  // Detects a per-line copy of the rest of the hunk (handlers, guards) and every removed
  // limit line compared with every added one: 1 to 7.6 seconds on the old code.
  test("an 80,000-line hunk is read in linear time", () => {
    const ordinary = lines(80_000, (index) => `+const v${index} = ${index};`);
    withinLinear("src/a.ts", lines(80_000, (index) => `+} catch (e${index}) {`), ordinary, "handlers");
    withinLinear("src/a.py", lines(80_000, (index) => `+except E${index}:`), ordinary, "python handlers");
    withinLinear("src/a.ts", lines(80_000, (index) => `+if (a${index} > ${index}) run${index}();`), ordinary, "conditions");
    const limits = lines(80_000, (index) => (index < 40_000 ? `-const limitA${index} = 1;` : `+const limitB${index} = 2;`));
    for (const file of ["src/a.ts", "docs/a.md", "deploy.yml"]) withinLinear(file, limits, ordinary, `limit lines in ${file}`);
  });

  test("a line with hundreds of comparisons is compared once, not once per comparison", () => {
    const before = Array.from({ length: 400 }, (_, index) => `a${index} < ${index}`).join(" && ");
    const after = Array.from({ length: 400 }, (_, index) => `a${index} < ${index + 1}`).join(" && ");
    expect(timed(() => changeFactsOf({ file: "src/a.ts", diff: hunk(`-if (${before}) run();`, `+if (${after}) run();`) }))).toBeLessThan(generous);
  });

  test("an ordinary relaxed bound is still found next to a long line", () => {
    const filler = "a==b || ".repeat(450);
    const facts = changeFactsOf({ file: "src/a.ts", diff: hunk("-if (n <= 10) stop();", "+if (n < 10) stop();", `+const x = ${filler}1;`) });
    expect(facts.answers.limitChanged).toBe("yes");
    expect(facts.evidence.limitChanged?.text).toBe("if (n < 10) stop();");
  });

  test("operands are read the same way as before on ordinary lines", () => {
    expect(yesOf("src/a.ts", hunk("-if (items.length >= max) stop();", "+if (items.length > max) stop();"))).toContain("limitChanged");
    expect(yesOf("src/a.ts", hunk("-if (cfg.limit[i] <= -5) stop();", "+if (cfg.limit[i] <= -9) stop();"))).toContain("limitChanged");
    expect(yesOf("src/a.py", hunk("-if a is not None: run()", "+if a is None: run()"))).toContain("comparisonChanged");
    expect(yesOf("src/a.ts", hunk("-if (a == b) run();", "+if (a == b) run();"))).toEqual([]);
  });
});

describe("a moved bound among many comparisons", () => {
  /** One comparison as the analysis reads it: operands and operator. */
  interface Atom {
    readonly left: string;
    readonly operator: string;
    readonly right: string;
  }
  const strictness = new Map([["<", "<="], ["<=", "<"], [">", ">="], [">=", ">"]]);
  const isNumber = (token: string) => /^-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?$/i.test(token);
  const line = (atom: Atom) => `if (${atom.left} ${atom.operator} ${atom.right}) run();`;

  /** The rule before the keyed join, without its cap: every removed comparison against every added one, in order. */
  function referenceLimit(removed: readonly Atom[], added: readonly Atom[]): number {
    for (const before of removed) {
      for (const [index, after] of added.entries()) {
        const sameOperands = before.left === after.left && before.right === after.right;
        if (sameOperands && strictness.get(before.operator) === after.operator) return index;
        const sameDirection = before.operator === after.operator || strictness.get(before.operator) === after.operator;
        if (!sameDirection) continue;
        if (before.left === after.left && isNumber(before.right) && isNumber(after.right) && before.right !== after.right) return index;
        if (before.right === after.right && isNumber(before.left) && isNumber(after.left) && before.left !== after.left) return index;
      }
    }
    return -1;
  }

  /** One side's comparisons left once the other side's identical ones cancel them, earliest first, as a moved line cancels. */
  function surviving(side: readonly Atom[], other: readonly Atom[]): Atom[] {
    const remaining = new Map<string, number>();
    for (const atom of other) remaining.set(line(atom), (remaining.get(line(atom)) ?? 0) + 1);
    return side.filter((atom) => {
      const count = remaining.get(line(atom)) ?? 0;
      remaining.set(line(atom), count - 1);
      return count <= 0;
    });
  }

  // Detects a join that answers differently from comparing every pair: another
  // match, another order, or a miss past a cap (the old code stopped at 150 per side).
  test("finds the bound comparing every pair finds, on random hunks", () => {
    let seed = 20260928;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const names = ["a", "b", "n", "x.y", "q[0]", "$v", "_k"];
    const numbers = ["0", "1", "2", "10", "2.5", "1e3", "1_000"];
    const operators = ["<", "<=", ">", ">=", "==", "!=", "===", "!=="];
    const operand = () => (random() < 0.5 ? pick(names) : pick(numbers));
    const atom = (): Atom => ({ left: operand(), operator: pick(operators), right: random() < 0.2 ? `-${pick(numbers)}` : operand() });
    const nudge = (from: Atom): Atom => {
      const roll = random();
      if (roll < 0.4) return { ...from, operator: strictness.get(from.operator) ?? pick(operators) };
      if (roll < 0.7) return { ...from, right: pick(numbers) };
      return { ...from, left: pick(numbers) };
    };
    // Comparisons that match nothing, to push the one that matters past any cap.
    const padding = (count: number, name: string) => Array.from({ length: count }, (_, index): Atom => ({ left: `p${index}`, operator: "==", right: `${name}${index}` }));
    let found = 0;
    for (let round = 0; round < 3000; round++) {
      const pad = round % 3 === 0 ? Math.floor(random() * 400) : 0;
      const removed = [...padding(pad, "r"), ...Array.from({ length: Math.floor(random() * 10) }, atom)];
      const added = [...padding(pad, "s"), ...Array.from({ length: Math.floor(random() * 10) }, () => (removed.length > pad && random() < 0.4 ? nudge(pick(removed.slice(pad))) : atom()))];
      const survivors = surviving(added, removed);
      const expected = referenceLimit(surviving(removed, added), survivors);
      const diff = hunk(...removed.map((each) => `-${line(each)}`), ...added.map((each) => `+${line(each)}`));
      const evidence = changeFactsOf({ file: "src/a.ts", diff }).evidence.limitChanged?.text ?? null;
      expect(evidence, diff).toBe(expected === -1 ? null : line(survivors[expected]));
      if (expected !== -1) found += 1;
    }
    expect(found).toBeGreaterThan(500);
  });

  // Detects the cap: with 150 rewritten comparisons before it, a relaxed bound in a test
  // file was not a limit change, and the hunk dropped from attention to low.
  test("rewritten comparisons before a relaxed bound do not hide it", () => {
    for (const pad of [150, 151, 400, 2000]) {
      const removed = [...Array.from({ length: pad }, (_, index) => `-if (a${index} == b${index}) log();`), "-if (elapsed <= 10) fail();"];
      const added = [...Array.from({ length: pad }, (_, index) => `+if (a${index} == c${index}) log();`), "+if (elapsed <= 1000) fail();"];
      const diff = hunk(...removed, ...added);
      for (const file of ["test/pay.test.ts", "src/pay.ts"]) {
        const facts = changeFactsOf({ file, diff });
        expect(facts.evidence.limitChanged, `${file} after ${pad}`).toEqual({ side: "added", text: "if (elapsed <= 1000) fail();" });
      }
      const unit = { id: "a", file: "test/pay.test.ts", header: "@@ -1,1 +1,1 @@", newStart: 1, oldStart: 1, added: added.length, removed: removed.length, diff };
      expect(reviewUnits([unit]).items[0].status, `after ${pad}`).toBe("attention");
    }
  });

  // Detects the per-line cap: a line's comparisons past the 1,000th were not read.
  test("comparisons earlier on the same line do not hide a relaxed bound", () => {
    const padded = (bound: string) => `if (${"x==".repeat(1000)}x && ${bound}) stop();`;
    const facts = changeFactsOf({ file: "test/a.test.ts", diff: hunk(`-${padded("n <= 10")}`, `+${padded("n < 10")}`) });
    expect(facts.answers.limitChanged).toBe("yes");
  });
});
