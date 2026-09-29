import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { reviewDiff } from "../src/review/service.js";

// A cache is read only by a diffninja with the same lock, so the printed command names this exact version.
const ownVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

let repo = "";
let fromSha = "";
let toSha = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "diffninja-grammar-warning-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.py"), "def helper():\n    return 1\n\ndef main():\n    return helper()\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  fromSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "app.py"), "def helper():\n    return 1\n\ndef extra():\n    return 2\n\ndef main():\n    return helper() + extra()\n");
  git("commit", "-qam", "change");
  toSha = git("rev-parse", "HEAD");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(repo, { recursive: true, force: true }); });

describe("call flows and grammars that are not installed", () => {
  test("a Python change reviewed without the Python grammar says so once, and downloads nothing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "diffninja-empty-cache-"));
    const bin = mkdtempSync(join(tmpdir(), "diffninja-fake-npm-"));
    try {
      // Any attempt to run npm during the review leaves a mark.
      const marker = join(bin, "npm-was-run");
      writeFileSync(join(bin, "npm"), `#!/bin/sh\necho run >> "${marker}"\nexit 1\n`, { mode: 0o755 });
      vi.stubEnv("DIFFNINJA_GRAMMAR_CACHE", empty);
      if (process.platform !== "win32") vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
      const report = await reviewDiff({ repo, from: fromSha, to: toSha }, {});
      const warning = report.warnings.filter((text) => text.includes("grammars would read"));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain("tree-sitter-python");
      expect(warning[0]).toContain(`run \`npx -y diffninja@${ownVersion} grammars install\` once`);
      expect(warning[0]).toContain("not evidence of safety");
      // Only a POSIX PATH carries the fake npm; Windows runs npm through npm-cli.js.
      if (process.platform !== "win32") expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("a Kotlin change names the install command with --build, the only one that makes Kotlin readable", async () => {
    const empty = mkdtempSync(join(tmpdir(), "diffninja-empty-cache-"));
    try {
      writeFileSync(join(repo, "App.kt"), "fun helper(): Int = 1\nfun main() { helper() }\n");
      git("add", "-A");
      git("commit", "-q", "-m", "kotlin");
      vi.stubEnv("DIFFNINJA_GRAMMAR_CACHE", empty);
      const report = await reviewDiff({ repo, from: toSha, to: git("rev-parse", "HEAD") }, {});
      const warning = report.warnings.filter((text) => text.includes("grammars would read"));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain(`run \`npx -y diffninja@${ownVersion} grammars install --build\` once`);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("with the grammar installed the same review has no such warning and finds the call flow", async () => {
    const report = await reviewDiff({ repo, from: fromSha, to: toSha }, {});
    expect(report.warnings.some((text) => text.includes("grammars would read"))).toBe(false);
    expect(report.callFlows.length).toBeGreaterThan(0);
  });
});
