import { describe, expect, test } from "vitest";
import { reviewUnits } from "../src/review/pipeline.js";
import { MAX_REVIEW_QUESTIONS, QUESTION_OPTIONS, reviewQuestions } from "../src/review/questions.js";
import type { ReviewUnit } from "../src/review/types.js";

function unit(id: string, file: string, ...lines: string[]): ReviewUnit {
  const diff = ["@@ -1,1 +1,1 @@", ...lines].join("\n");
  return {
    id, file, header: "@@ -1,1 +1,1 @@", diff, oldStart: 1, newStart: 1,
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
  };
}

function questionsOf(units: ReviewUnit[], title?: string) {
  const { items } = reviewUnits(units);
  return reviewQuestions(items, title === undefined ? undefined : { title, body: "" });
}

describe("review questions", () => {
  test("a changed source hunk asks about behavior and about the tests in the same diff", () => {
    const questions = questionsOf([
      unit("fix", "src/check.ts", "-if (n <= 0) throw new Error('n');", "+if (n < 0) throw new Error('n');"),
      unit("spec", "test/check.test.ts", "+expect(() => check(0)).not.toThrow();"),
    ]);
    expect(questions.map((question) => [question.id, question.kind, question.unitIds])).toEqual([
      ["q1", "behaviorChange", ["fix"]],
      ["q2", "testCoverage", ["fix", "spec"]],
    ]);
    expect(questions[0].options).toEqual(QUESTION_OPTIONS.behaviorChange);
    expect(questions[0].options).toContain("cannot-tell");
    expect(questions[1].text).toContain("Does any test changed in this diff exercise");
  });

  test("without a test in the diff it asks about existing tests", () => {
    const [, coverage] = questionsOf([unit("fix", "src/a.ts", "+const limit = 5;")]);
    expect(coverage.kind).toBe("testCoverage");
    expect(coverage.text).toContain("No test file changed in this diff");
    expect(coverage.unitIds).toEqual(["fix"]);
  });

  test("a test hunk is asked about weakening only when it removes an assertion or adds a skip", () => {
    const questions = questionsOf([
      unit("loosened", "test/a.test.ts", "-expect(total).toBe(3);", "+expect(total).toBeGreaterThan(0);"),
      unit("skipped", "test/b.test.ts", "+it.skip('pays', () => {});"),
      unit("added", "test/c.test.ts", "+expect(total).toBe(4);"),
    ]);
    expect(questions.map((question) => [question.kind, question.unitIds[0]])).toEqual([
      ["testWeakened", "loosened"],
      ["testWeakened", "skipped"],
    ]);
  });

  test("documentation that changes an instruction asks whether it matches the code", () => {
    const questions = questionsOf([
      unit("rule", "docs/a.md", "-Retry on failure.", "+Never retry a failed payment."),
      unit("prose", "docs/b.md", "-Hello.", "+Hello there."),
    ]);
    expect(questions.map((question) => [question.kind, question.unitIds[0]])).toEqual([["docMatchesCode", "rule"]]);
  });

  test("configuration asks about behavior but not tests; a stated goal adds an intent question", () => {
    const questions = questionsOf([unit("ci", ".github/workflows/ci.yml", "+  continue-on-error: true")], "Speed up CI");
    expect(questions.map((question) => question.kind)).toEqual(["behaviorChange", "intentFit"]);
    expect(questions[1].text).toContain('"Speed up CI"');
    expect(questions[1].options).toEqual(QUESTION_OPTIONS.intentFit);
  });

  test("passes, manual units, and unread types are never asked about", () => {
    const questions = questionsOf([
      unit("fmt", "src/a.ts", "-a=b;", "+a = b;"),
      unit("sql", "schema/a.graphql", "+type A { a: Int }"),
      { ...unit("logo", "logo.png", "Binary files differ"), special: "binary" },
    ]);
    expect(questions).toEqual([]);
  });

  test("is bounded, keeps report order, and is deterministic", () => {
    const units = Array.from({ length: 30 }, (_, index) => unit(`u${index}`, `src/u${index}.ts`, `+const v${index} = ${index};`));
    const first = questionsOf(units);
    expect(first).toHaveLength(MAX_REVIEW_QUESTIONS);
    expect(first.map((question) => question.id)).toEqual(first.map((_, index) => `q${index + 1}`));
    expect(questionsOf(units)).toEqual(first);
  });
});
