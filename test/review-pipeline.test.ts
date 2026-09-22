import { describe, expect, test } from "vitest";
import {
  BASE_PRIORITY,
  CHANGED_PRIORITY,
  FACT_PRIORITY,
  MANUAL_REVIEW_PRIORITY,
  TEST_FILE_ORDER_REASON,
  TRIVIAL_PRIORITY,
  reviewUnits,
} from "../src/review/pipeline.js";
import type { ReviewItem, ReviewUnit } from "../src/review/types.js";

interface UnitSpec {
  readonly id: string;
  readonly file?: string;
  readonly diff?: string;
  readonly special?: string;
}

function makeUnit(spec: UnitSpec): ReviewUnit {
  const diff = spec.diff ?? "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;";
  const lines = diff.split("\n");
  const unit: ReviewUnit = {
    id: spec.id,
    file: spec.file ?? `src/${spec.id}.ts`,
    header: lines[0],
    diff,
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
    oldStart: 1,
    newStart: 1,
  };
  if (spec.special !== undefined) unit.special = spec.special;
  return unit;
}

const hunk = (...lines: string[]) => ["@@ -1,1 +1,1 @@", ...lines].join("\n");

function byId(items: readonly ReviewItem[], id: string): ReviewItem {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

describe("status", () => {
  test("a code change outside a test file is attention, with its facts and the lines they rest on", () => {
    const { items } = reviewUnits([
      makeUnit({
        id: "check",
        diff: hunk("-  if (amount <= 0) throw new Error('invalid');", "+  if (amount < 0) throw new Error('invalid');"),
      }),
    ]);
    const [item] = items;
    expect(item.status).toBe("attention");
    expect(item.facts?.answers.limitChanged).toBe("yes");
    // base + changed + heaviest boundary fact (limit 15) + heaviest failure fact (propagated 3)
    expect(item.priority).toBe(BASE_PRIORITY + CHANGED_PRIORITY + FACT_PRIORITY.limitChanged + FACT_PRIORITY.failurePropagated);
    expect(item.reasons).toContain("limit changed — added line: if (amount < 0) throw new Error('invalid');");
  });

  test("each group contributes its heaviest fact once, never a sum", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "both", diff: hunk("-if (count > max) {", "+if (count >= max && typeof count === 'number') {") }),
    ]);
    const facts = items[0].facts!;
    expect(facts.answers.comparisonChanged).toBe("yes");
    expect(facts.answers.limitChanged).toBe("yes");
    expect(facts.answers.validationChanged).toBe("yes");
    expect(items[0].priority).toBe(BASE_PRIORITY + CHANGED_PRIORITY + FACT_PRIORITY.limitChanged);
  });

  test("a test-file change is low unless it changes a limit or discards a failure", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "assert", file: "test/a.test.ts", diff: hunk("-expect(total).toBe(1);", "+expect(total).toBe(2);") }),
      makeUnit({ id: "swallow", file: "test/b.test.ts", diff: hunk("+await setup().catch(() => {});") }),
    ]);
    expect(byId(items, "assert").status).toBe("low");
    expect(byId(items, "swallow").status).toBe("attention");
    expect(byId(items, "assert").reasons).toContain(TEST_FILE_ORDER_REASON);
  });

  test("a formatting- or comment-only code change passes at the trivial priority", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "fmt", diff: hunk("-const total=a+b; // sum", "+const total = a + b;") }),
    ]);
    expect(items[0]).toMatchObject({ status: "passed", priority: TRIVIAL_PRIORITY });
    expect(items[0].facts?.inert).toBe(true);
  });

  test("a file type diffninja cannot read is uncertain, never passed or low", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "guide", file: "docs/guide.md", diff: hunk("-Never retry.", "+Retry once.") }),
    ]);
    expect(items[0].status).toBe("uncertain");
    expect(items[0].priority).toBe(BASE_PRIORITY + CHANGED_PRIORITY);
    expect(new Set(Object.values(items[0].facts!.answers))).toEqual(new Set(["unknown"]));
  });

  test("special and empty units go to manual review without facts", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "logo", file: "assets/logo.png", diff: "Binary files differ", special: "binary" }),
      makeUnit({ id: "empty", diff: "" }),
    ]);
    for (const item of items) {
      expect(item).toMatchObject({ status: "uncertain", priority: MANUAL_REVIEW_PRIORITY });
      expect(item.facts).toBeUndefined();
    }
  });

  test("an exact no-op and a blank-only text change pass without facts", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "noop", diff: "@@ -1,1 +1,1 @@\n const a = 1;" }),
      makeUnit({ id: "blank", file: "notes.md", diff: hunk("+", "-  ") }),
    ]);
    for (const item of items) {
      expect(item).toMatchObject({ status: "passed", priority: TRIVIAL_PRIORITY });
      expect(item.facts).toBeUndefined();
    }
  });
});

describe("report order", () => {
  test("manual work first, then source by priority, then tests, then passes", () => {
    const { items } = reviewUnits([
      makeUnit({ id: "fmt", diff: hunk("-a=b;", "+a = b;") }),
      makeUnit({ id: "type-test", file: "index.test-d.ts", diff: hunk("+expectType<number>(limit(1));", "+if (typeof value === 'number') {}") }),
      makeUnit({ id: "fix", file: "index.js", diff: hunk("+generator.clearQueue = clearQueue;") }),
      makeUnit({ id: "readme", file: "readme.md", diff: hunk("+Call `clearQueue()` to reject pending work.") }),
      makeUnit({ id: "logo", file: "logo.png", diff: "Binary files differ", special: "binary" }),
      makeUnit({ id: "guard", file: "index.js", diff: hunk("-if (n <= 0) throw new TypeError('n');", "+if (n < 1) throw new TypeError('n');") }),
    ]);
    // The type test's validation fact would outrank the fix by priority alone;
    // test files come after the code they exercise, docs are not demoted.
    expect(items.map((item) => item.id)).toEqual(["logo", "guard", "fix", "readme", "type-test", "fmt"]);
    expect(byId(items, "type-test").priority).toBeGreaterThan(byId(items, "fix").priority);
  });

  test("the same input always produces the same report", () => {
    const units = () => [
      makeUnit({ id: "a", diff: hunk("-if (x > 1) retry();", "+if (x >= 1) retry();") }),
      makeUnit({ id: "b", file: "test/b.test.ts", diff: hunk("+expect(run()).toBe(1);") }),
      makeUnit({ id: "c", file: "docs/c.md", diff: hunk("+Always retry.") }),
    ];
    expect(reviewUnits(units())).toEqual(reviewUnits(units()));
  });
});
