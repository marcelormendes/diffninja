import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { guidelinePaths, parseBlame, topicStems } from "../src/review/history.js";
import { reviewDiff } from "../src/review/service.js";

const GUARDED = "export function total(items) {\n  if (items.length === 0) return 0;\n  return items.reduce((sum, item) => sum + item, 0);\n}\n";
const UNGUARDED = "export function total(items) {\n  return items.reduce((sum, item) => sum + item);\n}\n";
const PEER = (name: string) =>
  `from .entity import SelectEntityDescription\n\nDESCRIPTIONS = [SelectEntityDescription(key="${name}")]\n\nasync def async_setup_entry(hass, entry):\n    return DESCRIPTIONS\n`;

let dir: string;
let commitIndex = 0;

function write(file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

function commit(message: string): void {
  // Fixed dates keep blame dates and log order stable.
  commitIndex += 1;
  const date = `2024-01-${String(commitIndex).padStart(2, "0")}T12:00:00Z`;
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "commit", "-q", "-m", message], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diffninja-history-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  write("sum.ts", UNGUARDED);
  write("CONTRIBUTING.md", "# Contributing\n\nNew settings start in preview.\n");
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) write(`components/${name}/select.py`, PEER(name));
  write("queue.ts", "export const queue = [];\n");
  commit("initial");
  write("sum.ts", GUARDED);
  commit("sum: fix crash on empty input (#12)");
  write("queue.ts", "export const queue = [[], []];\n");
  commit("queue: shard the inject queue");
  write("queue.ts", "export const queue = [];\n");
  commit('Revert "queue: shard the inject queue"');
  // Mentions a revert but is not one.
  write("NOTES.md", "queue shard notes\n");
  commit("docs: restore accidentally reverted queue shard notes");
  write("sum.ts", UNGUARDED);
  write("components/hotspring/select.py", "class HotSpringSelect:\n    def select_option(self, option):\n        return option\n");
  commit("head");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("project context", () => {
  test("names the fix that last changed removed lines, a related revert, guidelines, and peer conventions", async () => {
    const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { pr: { title: "Shard the queue for sums", body: "" } });
    const sum = report.items.find((item) => item.file === "sum.ts")!;
    expect(sum.history).toEqual({
      origins: [{ commit: expect.stringMatching(/^[0-9a-f]{12}$/), date: "2024-01-02", subject: "sum: fix crash on empty input (#12)", lines: 2, notable: true }],
      unknownLines: 0,
    });
    expect(report.project?.history).toBe("complete");
    expect(report.project?.reverts.map((revert) => [revert.subject, revert.reason])).toEqual([
      ['Revert "queue: shard the inject queue"', { kind: "term", term: "queue" }],
    ]);
    expect(report.project?.guidelines).toEqual(["CONTRIBUTING.md"]);
    expect(report.project?.conventions).toEqual([{
      file: "components/hotspring/select.py",
      pattern: "components/*/select.py",
      peers: 5,
      common: [{ name: "DESCRIPTIONS", peers: 5 }, { name: "SelectEntityDescription", peers: 5 }, { name: "async_setup_entry", peers: 5 }],
    }]);
    const kinds = report.questions.map((question) => question.kind);
    expect(kinds).toEqual(expect.arrayContaining(["repeatsRevert", "followsGuidelines", "followsConvention", "undoesFix"]));
    const undo = report.questions.find((question) => question.kind === "undoesFix")!;
    expect(undo.unitIds).toEqual([sum.id]);
    expect(undo.text).toContain('"sum: fix crash on empty input (#12)"');
    expect(undo.options).toEqual(["keeps-its-purpose", "undoes-it", "cannot-tell"]);
  });

  test("the same range yields the same context", async () => {
    const first = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { pr: { title: "Shard the queue for sums", body: "" } });
    const second = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { pr: { title: "Shard the queue for sums", body: "" } });
    expect(second.project).toEqual(first.project);
    expect(second.items.map((item) => item.history)).toEqual(first.items.map((item) => item.history));
    expect(second.questions).toEqual(first.questions);
  });

  test("a shallow clone reports cut history and counts past-boundary lines as unknown", async () => {
    const shallow = mkdtempSync(join(tmpdir(), "diffninja-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "2", `file://${dir}`, shallow]);
      const report = await reviewDiff({ repo: shallow, from: "HEAD~1", to: "HEAD" }, {});
      const sum = report.items.find((item) => item.file === "sum.ts")!;
      expect(report.project?.history).toBe("shallow");
      expect(sum.history).toEqual({ origins: [], unknownLines: 2 });
      expect(report.questions.some((question) => question.kind === "undoesFix")).toBe(false);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  test("a patch review carries no project context", async () => {
    const report = await reviewDiff({ diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a;\n+b;\n", source: "Patch" });
    expect(report.project).toBeUndefined();
  });
});

describe("history helpers", () => {
  test("parseBlame attributes each final line and marks boundary commits", () => {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    const output = [
      `${sha} 1 7 2`, "author-time 1704110400", "summary fix: guard", "boundary", "filename x", "\tline",
      `${sha} 2 8`, "\tline",
      `${other} 5 9 1`, "author-time 1704196800", "summary other", "filename x", "\tline",
    ].join("\n");
    const blame = parseBlame(output);
    expect([...blame.byLine]).toEqual([[7, sha], [8, sha], [9, other]]);
    expect(blame.commits.get(sha)).toEqual({ date: "2024-01-01", subject: "fix: guard", boundary: true });
    expect(blame.commits.get(other)).toEqual({ date: "2024-01-02", subject: "other", boundary: false });
  });

  test("topic stems relate word forms and skip common words", () => {
    expect([...topicStems("rt: Sharding the inject queues to reduce contention")].sort()).toEqual(["contention", "inject", "queue", "reduce", "shard"]);
    expect([...topicStems("injectQueue sharded")].sort()).toEqual(["inject", "queue", "shard"]);
  });

  test("guidelines next to the change come first, then the root, then .github and docs; another package's guide is left out", () => {
    const tree = ["CONTRIBUTING.md", "docs/preview.md", ".github/CONTRIBUTING.md", "crates/core/CONTRIBUTING.md", "crates/other/CONTRIBUTING.md", "src/a.ts", "tests/CONTRIBUTING.md"];
    expect(guidelinePaths(tree, ["crates/core/src/lib.rs"])).toEqual(["crates/core/CONTRIBUTING.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/preview.md"]);
  });
});
