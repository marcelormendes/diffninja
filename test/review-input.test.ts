import { describe, it, expect } from "vitest";
import { parseDiff } from "../src/review/input.js";

describe("review diff input", () => {
  it("preserves multiple files, hunks, deletions and line numbers", () => {
    const units = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,2 +3,2 @@ function run()
-old()
+newer()
 keep()
@@ -30 +30 @@
-no()
+yes()
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed()
`);
    expect(units.map(unit => [unit.file, unit.oldStart, unit.newStart, unit.added, unit.removed])).toEqual([
      ["a.ts", 3, 3, 1, 1], ["a.ts", 30, 30, 1, 1], ["gone.ts", 1, 0, 0, 1],
    ]);
  });
  it("retains binary and mode-only changes for human review", () => {
    const units = parseDiff(`diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`);
    expect(units).toHaveLength(2);
    expect(units.every(unit => !!unit.special)).toBe(true);
  });
  it("does not hide mode changes alongside text hunks", () => {
    const units = parseDiff(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
--- a/run.sh
+++ b/run.sh
@@ -1 +1 @@
-echo old
+echo new
`);
    expect(units).toHaveLength(2);
    expect(units[1].special).toBeDefined();
  });
  it("rejects truncated and overlong hunks instead of losing lines", () => {
    expect(() => parseDiff("--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-x\n+y\n")).toThrow();
    expect(() => parseDiff("--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n+lost\n")).toThrow();
    expect(() => parseDiff("diff --cc a.ts\n@@@ -1 -1 +1 @@@\n")).toThrow(/Combined/);
  });
  it("handles no-newline markers and plain unified input", () => {
    expect(parseDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n")[0].added).toBe(1);
    expect(parseDiff("")).toEqual([]);
    expect(() => parseDiff("not a diff")).toThrow();
  });
});
