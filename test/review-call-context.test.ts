import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { buildCallContext } from "../src/review/call-context.js";
import { reviewDiff } from "../src/review/service.js";
import type { ReviewUnit } from "../src/review/types.js";

function unit(line: number): ReviewUnit {
  const header = `@@ -${line} +${line} @@`;
  return { id: "caller", file: "caller.ts", header, diff: `${header}\n-callee(arg);\n+callee(arg + 1);`, added: 1, removed: 1, oldStart: line, newStart: line };
}

function context(source: string, line: number): string[] {
  const index = buildIndex(extractFunctions("caller.ts", source));
  return buildCallContext([unit(line)], buildIndex([]), index).get("caller") ?? [];
}

describe("hunk call context", () => {
  test("keeps distinct sites but expands a definition once within depth four", () => {
    const blocks = context([
      "function caller(arg) { callee1(arg); callee1(arg + 1); }",
      "function callee1(param) { callee2(param); }",
      "function callee2(param) { callee3(param); }",
      "function callee3(param) { callee4(param); }",
      "function callee4(param) { callee5(param); }",
      "function callee5(param) { return param; }",
      "function caller2(arg) { callee6(arg); }",
      "function callee6(param) { return param; }",
    ].join("\n"), 1);
    expect(blocks.filter(block => block.startsWith("call callee1 @"))).toHaveLength(2);
    expect(blocks.filter(block => block.startsWith("call callee2 @"))).toHaveLength(1);
    expect(blocks[0]).toContain('arg[1] -> param: "arg"');
    expect(blocks[1]).toContain('arg[1] -> param: "arg + 1"');
    expect(blocks[1]).toContain("omitted expansion=repeated-definition");
    expect(blocks.find(block => block.startsWith("call callee4 @"))).toContain("snapshot=after");
    expect(blocks.some(block => block.startsWith("call callee5 @"))).toBe(false);
    expect(blocks.some(block => block.startsWith("call callee6 @"))).toBe(false);
    expect(blocks.join("\n")).toContain("reason=unrelated-to-hunk");
    expect(blocks.join("\n")).toContain("depth-limit=4");
  });

  test("prioritizes immediate callers of a changed definition, not tree-root distance", () => {
    const blocks = context([
      "function caller1(arg) { caller2(arg); }",
      "function caller2(arg) { caller3(arg); }",
      "function caller3(arg) { caller4(arg); }",
      "function caller4(arg) { caller5(arg); }",
      "function caller5(arg) { callee(arg); }",
      "function callee(param) { return param + 1; }",
    ].join("\n"), 6);
    expect(blocks[0]).toContain("call callee @ caller.ts:5");
    expect(blocks[0]).toContain('arg[1] -> param: "arg"');
    expect(blocks.some(block => block.startsWith("call caller2 @"))).toBe(false);
    expect(blocks.join("\n")).toContain("depth-limit=4");
  });

  test("retains the call on changed lines ahead of earlier sibling calls", () => {
    const blocks = context([
      "function caller(arg) {",
      "  callee1(arg);",
      "  callee2(arg);",
      "}",
      "function callee1(param) {}",
      "function callee2(param) {}",
    ].join("\n"), 3);
    expect(blocks[0]).toContain("call callee2 @ caller.ts:3");
    expect(blocks[1]).toContain("call callee1 @ caller.ts:2");
  });

  test("does not pull in unrelated functions from unified diff context lines", () => {
    const source = [
      "function caller(arg) { callee(arg); }",
      "function callee(param) { return param; }",
      "function caller2(arg) { callee2(arg); }",
      "function callee2(param) { return param; }",
    ].join("\n");
    const index = buildIndex(extractFunctions("caller.ts", source));
    const reviewUnit = unit(1);
    reviewUnit.diff += "\n function callee(param) { return param; }\n function caller2(arg) { callee2(arg); }\n function callee2(param) { return param; }";
    const blocks = buildCallContext([reviewUnit], buildIndex([]), index).get(reviewUnit.id)!;
    expect(blocks.some(block => block.startsWith("call callee @"))).toBe(true);
    expect(blocks.some(block => block.startsWith("call callee2 @"))).toBe(false);
    expect(blocks.join("\n")).toContain("reason=unrelated-to-hunk");
  });

  test("keeps nested argument call sites adjacent to the hunk", () => {
    const blocks = context([
      "function caller(arg) { callee1(callee2(arg)); }",
      "function callee1(param) {}",
      "function callee2(param) { return param; }",
    ].join("\n"), 1);
    expect(blocks.filter(block => block.startsWith("call "))).toHaveLength(2);
    expect(blocks[0]).toContain('arg[1] -> param: "callee2(arg)"');
    expect(blocks[1]).toContain("call callee2 @ caller.ts:1");
    expect(blocks[1]).toContain('arg[1] -> param: "arg"');
  });

  test("renders source expressions as JSON strings without changing literal whitespace", () => {
    const blocks = context('function caller() { callee("arg  arg\\targ", [1, 2]); }\nfunction callee(param1, param2) {}', 1);
    expect(blocks[0]).toContain(`arg[1] -> param1: ${JSON.stringify('"arg  arg\\targ"')}`);
    expect(blocks[0]).toContain('arg[2] -> param2: "[1, 2]"');
    expect(blocks[0]).toContain("mapping=positional");
    expect(blocks[0]).toContain("definition=(param1, param2) @ caller.ts:2");
  });
  test("binds each snapshot to its own parameter declaration", () => {
    const before = buildIndex(extractFunctions("caller.ts",
      "function caller(arg1, arg2) { callee(arg1, arg2); }\nfunction callee(param1, param2) {}"));
    const after = buildIndex(extractFunctions("caller.ts",
      "function caller(arg1, arg2) { callee(arg1, arg2); }\nfunction callee(param2, param1) {}"));
    const blocks = buildCallContext([unit(2)], before, after).get("caller")!;
    const prior = blocks.find(block => block.includes("snapshot=before"))!;
    const current = blocks.find(block => block.includes("snapshot=after"))!;
    expect(prior).toContain('arg[1] -> param1: "arg1"');
    expect(prior).toContain('arg[2] -> param2: "arg2"');
    expect(current).toContain('arg[1] -> param2: "arg1"');
    expect(current).toContain('arg[2] -> param1: "arg2"');
  });

  test("renders dynamic targets with unknown mappings rather than parameter guesses", () => {
    const blocks = context("function caller(arg, arg1) { arg[0](arg1); }", 1);
    expect(blocks[0]).toContain("target=unresolved");
    expect(blocks[0]).toContain("mapping=unknown");
    expect(blocks[0]).toContain('arg[1] -> ?: "arg1"');
    expect(blocks[0]).toContain("completeness=partial");
  });


  test("range review enriches argument-only changes even without structural diff trees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-context-"));
    const commit = (message: string) => {
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=caller", "-c", "user.email=caller@example.invalid", "commit", "-m", message], { cwd: dir });
    };
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "caller.ts"), "export function caller(arg) { return callee(arg); }\nfunction callee(param) { return param; }\n");
      commit("before");
      writeFileSync(join(dir, "caller.ts"), "export function caller(arg) { return callee(arg + 1); }\nfunction callee(param) { return param; }\n");
      commit("after");
      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { mock: true });
      const blocks = report.items[0].callFlow!;
      const before = blocks.find(block => block.includes("snapshot=before"))!;
      const after = blocks.find(block => block.includes("snapshot=after"))!;
      expect(before).toContain('arg[1] -> param: "arg"');
      expect(before).not.toContain('arg[1] -> param: "arg + 1"');
      expect(after).toContain('arg[1] -> param: "arg + 1"');
      expect(report.items[0].judgment).toBeDefined();
      expect(report.items[0].routing).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
