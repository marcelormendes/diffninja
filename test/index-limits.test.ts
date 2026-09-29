import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_INDEXED_FILES, changedPaths, listSnapshotFiles, takeSkippedSources } from "../src/git.js";
import { reviewDiff } from "../src/review/service.js";

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();
const HEAD = { kind: "commit", ref: "HEAD" } as const;

/** Commits written straight into the object store, each on the last, so a repository past the file limit takes seconds. */
function importCommits(root: string, commits: readonly (readonly [string, string][])[]): void {
  const stream: string[] = [];
  commits.forEach((files, index) => {
    stream.push("commit refs/heads/main", `committer t <t@t> ${1_700_000_000 + index} +0000`, "data 1", `${index}`);
    for (const [path, text] of files) stream.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(text)}`, text);
    stream.push("");
  });
  execFileSync("git", ["fast-import", "--quiet"], { cwd: root, input: `${stream.join("\n")}\n` });
}

describe("what call-flow analysis is asked to parse", () => {
  test("oversized and surplus source files are left out in code-point order, and counted", () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-limits-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, { "a.py": "def a():\n    pass\n", "B.py": "def b():\n    pass\n", "c.py": "def c():\n    pass\n", "big.py": `x = "${"y".repeat(5000)}"\n`, "notes.txt": "not source\n" });
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      takeSkippedSources();
      // Upper case sorts first by code point on every machine; a locale sort puts a.py first.
      const files = listSnapshotFiles(root, HEAD, [], new Set(), { maxFiles: 2, maxFileBytes: 1000 });
      expect(files.map((file) => file.path)).toEqual(["B.py", "a.py"]);
      expect(takeSkippedSources()).toEqual({ oversized: 1, beyondLimit: 1 });
      expect(takeSkippedSources()).toEqual({ oversized: 0, beyondLimit: 0 });
      // The defaults leave an ordinary repository whole.
      expect(listSnapshotFiles(root, HEAD).map((file) => file.path)).toEqual(["B.py", "a.py", "big.py", "c.py"]);
      expect(takeSkippedSources()).toEqual({ oversized: 0, beyondLimit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("past the limit the changed files come first, then their directories, then the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-keep-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, { "a/one.py": "x = 1\n", "a/two.py": "x = 2\n", "b/three.py": "x = 3\n", "z/four.py": "x = 4\n", "z/near.py": "x = 5\n", "z/zz/deep.py": "x = 6\n" });
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      takeSkippedSources();
      const limits = { maxFiles: 3, maxFileBytes: 1000 };
      const changed = new Set(["z/four.py"]);
      // A diff reads both of its revisions; the same three left out of each are three files, not six.
      for (let revision = 0; revision < 2; revision += 1) {
        expect(listSnapshotFiles(root, HEAD, [], changed, limits).map((file) => file.path)).toEqual(["a/one.py", "z/four.py", "z/near.py"]);
      }
      expect(takeSkippedSources()).toEqual({ oversized: 0, beyondLimit: 3 });
      // A changed path that is gone from this revision still puts its directory first.
      expect(listSnapshotFiles(root, HEAD, [], new Set(["z/zz/gone.py"]), limits).map((file) => file.path)).toEqual(["a/one.py", "a/two.py", "z/zz/deep.py"]);
      takeSkippedSources();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the changed paths name files the way the listing does, from a subdirectory too", () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-subdir-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, { "pkg/a.py": "x = 1\n", "pkg/b.py": "x = 2\n", "pkg/z.py": "x = 3\n", "other.py": "x = 4\n" });
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      write(root, { "pkg/z.py": "x = 30\n", "other.py": "x = 40\n" });
      git(root, "commit", "-qam", "change");
      const pkg = join(root, "pkg");
      const changed = changedPaths(pkg, { kind: "commit", ref: "HEAD~1" }, HEAD);
      expect([...changed]).toEqual(["z.py"]);
      expect(listSnapshotFiles(pkg, HEAD, [], changed, { maxFiles: 1, maxFileBytes: 1000 }).map((file) => file.path)).toEqual(["z.py"]);
      takeSkippedSources();
      // A moved file keeps its old path too, so the base revision still reads it.
      mkdirSync(join(pkg, "moved"));
      git(root, "mv", "pkg/b.py", "pkg/moved/b.py");
      git(root, "commit", "-qm", "move");
      expect([...changedPaths(pkg, { kind: "commit", ref: "HEAD~1" }, HEAD)].sort()).toEqual(["b.py", "moved/b.py"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed file that sorts past the file limit still gets its call flow, and the review says the analysis was partial", async () => {
    const root = mkdtempSync(join(tmpdir(), "diffninja-index-cap-"));
    try {
      git(root, "init", "-q", "-b", "main");
      const filler = Array.from({ length: MAX_INDEXED_FILES + 10 }, (_, i): [string, string] => {
        const name = `m${String(i).padStart(5, "0")}`;
        return [`lib/${name}.ts`, `export function ${name}() {\n  return ${i};\n}\n`];
      });
      importCommits(root, [
        [...filler,
          ["zz/entry.ts", 'import { main } from "./app";\n\nexport function start() {\n  return main();\n}\n'],
          ["zz/app.ts", "export function main() {\n  return helper();\n}\n\nfunction helper() {\n  return 1;\n}\n"]],
        [["zz/app.ts", "export function main() {\n  audit();\n  return helper();\n}\n\nfunction helper() {\n  return 1;\n}\n\nfunction audit() {\n  return 2;\n}\n"]],
      ]);
      const report = await reviewDiff({ repo: root, from: git(root, "rev-parse", "main~1"), to: git(root, "rev-parse", "main") }, {});
      // The caller in the changed file's directory is read too, so the path from start() is drawn.
      expect(report.callFlows.map((file) => [file.file, file.trees.map((tree) => tree.key).sort()])).toEqual([["zz/app.ts", ["main", "start"]]]);
      expect(report.callFlowAvailability).toBe("partial");
      // 15,012 sources per revision, the same 12 left out of both.
      expect(report.warnings).toContain(`Call flows did not read 12 files beyond the ${MAX_INDEXED_FILES.toLocaleString("en-US")} read per revision. Flows through them are absent, which is not evidence of safety.`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

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
      // One file, present in both revisions, is one file.
      expect(warning).toContain("did not read 1 source file over 1 MiB");
      expect(warning).toContain("not evidence of safety");
      expect(report.callFlowAvailability).toBe("partial");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
