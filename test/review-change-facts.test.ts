import { describe, expect, test } from "vitest";
import { CHANGE_FACT_QUESTIONS, changeFactsOf, type ChangeFactQuestion } from "../src/review/change-facts.js";

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
