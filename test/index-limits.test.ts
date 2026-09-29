import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { listSnapshotFiles, takeSkippedSources } from "../src/git.js";
import { reviewDiff } from "../src/review/service.js";

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();

describe("what call-flow analysis is asked to parse", () => {
  test("oversized and surplus source files are left out in path order, and counted", () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-limits-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, { "a.py": "def a():\n    pass\n", "b.py": "def b():\n    pass\n", "c.py": "def c():\n    pass\n", "big.py": `x = "${"y".repeat(5000)}"\n`, "notes.txt": "not source\n" });
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      takeSkippedSources();
      const files = listSnapshotFiles(root, { kind: "commit", ref: "HEAD" }, [], { maxFiles: 2, maxFileBytes: 1000 });
      expect(files.map((file) => file.path)).toEqual(["a.py", "b.py"]);
      expect(takeSkippedSources()).toEqual({ oversized: 1, beyondLimit: 1 });
      expect(takeSkippedSources()).toEqual({ oversized: 0, beyondLimit: 0 });
      // The defaults leave an ordinary repository whole.
      expect(listSnapshotFiles(root, { kind: "commit", ref: "HEAD" }).map((file) => file.path)).toEqual(["a.py", "b.py", "big.py", "c.py"]);
      expect(takeSkippedSources()).toEqual({ oversized: 0, beyondLimit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a review of a repository with an enormous generated file says the file was not read", async () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-warning-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, { "app.py": "def main():\n    return 1\n", "bundle.py": `DATA = "${"z".repeat(1_200_000)}"\n` });
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      const from = git(root, "rev-parse", "HEAD");
      write(root, { "app.py": "def helper():\n    return 2\n\ndef main():\n    return helper()\n" });
      git(root, "commit", "-qam", "change");
      const report = await reviewDiff({ repo: root, from, to: git(root, "rev-parse", "HEAD") }, {});
      const warning = report.warnings.find((text) => text.includes("Call flows did not read"));
      expect(warning).toContain("2 source files over 1 MiB");
      expect(warning).toContain("not evidence of safety");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
