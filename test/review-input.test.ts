import { describe, it, expect } from "vitest";
import { parseDiff, gitDiff } from "../src/review/input.js";
import { readSnapshotFile } from "../src/git.js";
import { reviewDiff } from "../src/review/service.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("review diff input", () => {
  it("ignores local replacement objects and refuses evidence for a different patch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "diffninja-replaced-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      const revisions: string[] = [];
      for (const value of [1, 2, 99]) {
        writeFileSync(join(repo, "value.ts"), `export function value() { return ${value}; }\n`);
        git("add", ".");
        git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", String(value));
        revisions.push(git("rev-parse", "HEAD"));
      }
      git("replace", revisions[1], revisions[2]);
      const result = gitDiff(repo, revisions[0], revisions[1]);
      expect(result.diff).toContain("+export function value() { return 2; }");
      expect(result.diff).not.toContain("99");
      expect(readSnapshotFile(repo, { kind: "commit", ref: revisions[1] }, "value.ts")).toBe("export function value() { return 2; }\n");
      await expect(reviewDiff({
        repo, from: revisions[0], to: revisions[1], diff: result.diff.replace("return 2;", "return 3;"),
      }, { mock: true })).rejects.toThrow();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
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
    expect(units.map(unit => [unit.file, unit.special!.length > 0])).toEqual([
      ["icon.png", true], ["run.sh", true],
    ]);
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
    // The metadata unit keeps the file name and a nonempty manual flag; the
    // pipeline only routes a nonempty flag to human review.
    expect(units[1].file).toBe("run.sh");
    expect(units[1].diff).toContain("new mode 100755");
    expect(units[1].special!.length).toBeGreaterThan(0);
  });
  it("rejects truncated and overlong hunks instead of losing lines", () => {
    expect(() => parseDiff("--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-x\n+y\n")).toThrow(/truncated/);
    expect(() => parseDiff("--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n+lost\n")).toThrow(
      /content outside hunk/,
    );
    expect(() => parseDiff("diff --cc a.ts\n@@@ -1 -1 +1 @@@\n")).toThrow(/Combined/);
  });
  it("handles no-newline markers and plain unified input", () => {
    const [unit] = parseDiff(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n",
    );
    expect(unit.added).toBe(1);
    // Both markers survive in the hunk the report shows.
    expect(unit.diff.match(/\\ No newline at end of file/g)).toHaveLength(2);
    expect(parseDiff("")).toEqual([]);
    expect(() => parseDiff("not a diff")).toThrow(/file headers/);
  });
});
