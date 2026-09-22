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
  });

  test("a removed line whose text starts with dashes is still a removed line", () => {
    expect(yesOf("src/a.ts", "@@ -1,1 +1,1 @@\n---count > 0 && retry();\n+--count > 1 && retry();")).toContain(
      "comparisonChanged",
    );
  });

  test("answers unknown everywhere for a language it cannot read, never no", () => {
    const facts = changeFactsOf({ file: "docs/guide.md", diff: hunk("-Never retry.", "+Retry once when the limit > 3.") });
    expect(facts.language).toBeNull();
    expect(facts.inert).toBeNull();
    expect(new Set(Object.values(facts.answers))).toEqual(new Set(["unknown"]));
    expect(facts.evidence).toEqual({});
  });
});
