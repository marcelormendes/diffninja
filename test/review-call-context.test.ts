import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { buildCallContext } from "../src/review/call-context.js";
import type { ContextSources } from "../src/review/call-context.js";
import { reviewDiff } from "../src/review/service.js";
import { ContextPlan, MAX_CONTEXT_NODES } from "../src/review/context-plan.js";
import { buildJevState } from "../src/review/jev.js";
import { parseDiff } from "../src/review/input.js";
import type { SourceLoc } from "../src/types.js";
import type { ReviewContextNode, ReviewUnit } from "../src/review/types.js";

function unit(line: number): ReviewUnit {
  const header = `@@ -${line} +${line} @@`;
  return { id: "caller", file: "caller.ts", header, diff: `${header}\n-callee(arg);\n+callee(arg + 1);`, added: 1, removed: 1, oldStart: line, newStart: line };
}

function context(source: string, line: number): string[] {
  const index = buildIndex(extractFunctions("caller.ts", source));
  return buildCallContext([unit(line)], buildIndex([]), index).get("caller")?.entries ?? [];
}

/** Nodes for a hunk whose prior snapshot has no definitions of its own. */
function nodes(source: string, line: number, sources: ContextSources = {}): ReviewContextNode[] {
  const index = buildIndex(extractFunctions("caller.ts", source));
  return buildCallContext([unit(line)], buildIndex([]), index, sources).get("caller")?.nodes ?? [];
}

function indexOf(source: string) {
  return buildIndex(extractFunctions("caller.ts", source));
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
    const blocks = buildCallContext([reviewUnit], buildIndex([]), index).get(reviewUnit.id)!.entries;
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
    const blocks = buildCallContext([unit(2)], before, after).get("caller")!.entries;
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

      // The same extraction supplies the keyed nodes: the parent definition's
      // body, read from each snapshot, with that snapshot's own binding.
      const nodes = report.items[0].contextNodes!;
      const afterNode = nodes.find(node => node.key === "after:caller")!;
      const beforeNode = nodes.find(node => node.key === "before:caller")!;
      expect([afterNode, beforeNode].map(node => [node.label, node.file, node.line])).toEqual([
        ["caller(arg)", "caller.ts", 1], ["caller(arg)", "caller.ts", 1],
      ]);
      expect(afterNode.detail).toContain("source=caller.ts:1 snapshot=after begin\nexport function caller(arg) { return callee(arg + 1); }\n  source-end");
      expect(beforeNode.detail).toContain("source=caller.ts:1 snapshot=before begin\nexport function caller(arg) { return callee(arg); }\n  source-end");
      expect(afterNode.detail).toContain('snapshot=after target=lexical');
      expect(afterNode.detail).toContain('arg[1] -> param: "arg + 1"');
      expect(beforeNode.detail).not.toContain('arg[1] -> param: "arg + 1"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("structured context nodes", () => {
  const source = [
    "function caller(arg) { callee(arg); }",
    "function callee(param) { return param; }",
  ].join("\n");

  test("keys a parent definition by snapshot and carries its whole source verbatim", () => {
    const planned = nodes(source, 1, { after: () => source });
    expect(planned.map(node => node.key)).toEqual(["after:caller", "after:callee"]);
    const [node] = planned;
    expect(node).toMatchObject({ key: "after:caller", label: "caller(arg)", file: "caller.ts", line: 1 });
    expect(node.detail).toContain("context node after:caller");
    expect(node.detail).toContain("location=caller.ts:1 snapshot=after role=changed-definition hunk=caller file=caller.ts");
    expect(node.detail).toContain("declared-parameters=(arg)");
    // The markers bound exactly the snapshot's own text: nothing re-indented,
    // excerpted, or rewritten on the way into the node.
    expect(node.detail).toContain(`source=caller.ts:1 snapshot=after begin\n${source}\n  source-end`);
    expect(node.detail).toContain("evidence=call-sites-in-this-definition count=1");
    expect(node.detail).toContain('arg[1] -> param: "arg"');
  });

  test("reads each node from the location the extraction reported", () => {
    const requested: SourceLoc[] = [];
    nodes([
      "function caller(arg) {",
      "  return callee(arg);",
      "}",
      "function callee(param) { return param; }",
    ].join("\n"), 2, { after: definition => { requested.push(definition); return "function callee(param) { return param; }"; } });
    expect(requested).toEqual([
      { file: "caller.ts", line: 1, endLine: 3 },
      { file: "caller.ts", line: 4 },
    ]);
  });

  test("states an unavailable source instead of hiding the node", () => {
    const [node] = nodes(source, 1);
    expect(node.key).toBe("after:caller");
    expect(node.detail).toContain("source=caller.ts:1 snapshot=after unavailable reason=whole-definition-not-readable");
    expect(node.detail).not.toContain("source-end");
    expect(node.detail).toContain("evidence=call-sites-in-this-definition count=1");
  });

  test("adds the caller that reaches the changed definition and the callee it reaches", () => {
    const planned = nodes([
      "function caller(arg) { callee(arg); }",
      "function callee(param) { helper(param); }",
      "function helper(param) { return param; }",
    ].join("\n"), 2, { after: () => null });
    expect(planned.map(node => node.key)).toEqual(["after:callee", "after:caller", "after:helper"]);
    const caller = planned.find(node => node.key === "after:caller")!;
    expect(caller.detail).toContain("role=caller");
    expect(caller.detail).toContain("evidence=call-sites-in-this-definition count=1");
    expect(caller.detail).toContain('call callee @ caller.ts:1');
    expect(caller.detail).toContain('arg[1] -> param: "arg"');
    const callee = planned.find(node => node.key === "after:callee")!;
    expect(callee.detail).toContain('call helper @ caller.ts:2');
    expect(callee.detail).toContain("evidence=call-sites-in-this-definition count=1");
    expect(planned.find(node => node.key === "after:helper")!.detail).toContain("role=callee");
  });

  test("keeps upstream ancestor definitions addressable, not just their call sites", () => {
    const definitions = [
      "function root(value) { grandparent(value); }",
      "function grandparent(value) { parent(value); }",
      "function parent(value) { leaf(value); }",
      "function leaf(value) { return value; }",
    ];
    const planned = nodes(definitions.join("\n"), 4, {
      after: loc => definitions[loc.line - 1],
    });
    expect(planned.map(node => node.key)).toEqual([
      "after:leaf", "after:parent", "after:grandparent", "after:root",
    ]);
    for (const node of planned) {
      expect(node.detail).toContain(definitions[node.line - 1]);
    }
  });

  test("keeps each snapshot's own source and binding on its own node", () => {
    const before = indexOf("function caller(arg1, arg2) { callee(arg1, arg2); }\nfunction callee(param1, param2) {}");
    const after = indexOf("function caller(arg1, arg2) { callee(arg1, arg2); }\nfunction callee(param2, param1) {}");
    const planned = buildCallContext([unit(2)], before, after, {
      before: () => "function callee(param1, param2) {}",
      after: () => "function callee(param2, param1) {}",
    }).get("caller")!.nodes;
    // Both snapshots' changed definitions lead, resulting snapshot first, then
    // the definitions that call them.
    expect(planned.map(node => node.key)).toEqual(["after:callee", "before:callee", "after:caller", "before:caller"]);
    const current = planned.find(node => node.key === "after:callee")!;
    const prior = planned.find(node => node.key === "before:callee")!;
    expect(current.detail).toContain("source=caller.ts:2 snapshot=after begin\nfunction callee(param2, param1) {}\n  source-end");
    expect(current.detail).toContain('arg[1] -> param2: "arg1"');
    expect(prior.detail).toContain("source=caller.ts:2 snapshot=before begin\nfunction callee(param1, param2) {}\n  source-end");
    expect(prior.detail).toContain('arg[1] -> param1: "arg1"');
    expect(prior.detail).not.toContain('arg[1] -> param2');
  });

  test("carries the caller, the changed definition, and its callees as nodes within depth", () => {
    const lines = [
      "function caller(arg) {",
      "  changed(arg);",
      "  sibling(arg);",
      "}",
      "function changed(input) {",
      "  return callee(input);",
      "}",
      "function sibling(param) { return param; }",
      "function callee(param) {",
      "  return nested(param);",
      "}",
      "function nested(param) {",
      "  return deeper(param);",
      "}",
      "function deeper(param) {",
      "  return deepest(param);",
      "}",
      "function deepest(param) { return beyond(param); }",
      "function beyond(param) { return param; }",
    ];
    const source = lines.join("\n");
    const planned = nodes(source, 5, {
      after: definition => lines.slice(definition.line - 1, definition.endLine ?? definition.line).join("\n"),
    });
    // The changed definition leads, then the caller that reaches it, then the
    // callees nearest first. The sibling the caller also calls gets no node, and
    // the depth limit cuts the definition past `deepest` out entirely.
    expect(planned.map(node => node.key)).toEqual([
      "after:changed", "after:caller", "after:callee", "after:nested", "after:deeper", "after:deepest",
    ]);
    const detailOf = (key: string) => planned.find(node => node.key === key)!.detail;
    // Every node carries the snapshot's own text for its own span, whole.
    expect(detailOf("after:caller")).toContain(
      "source=caller.ts:1-4 snapshot=after begin\nfunction caller(arg) {\n  changed(arg);\n  sibling(arg);\n}\n  source-end",
    );
    expect(detailOf("after:changed")).toContain(
      "source=caller.ts:5-7 snapshot=after begin\nfunction changed(input) {\n  return callee(input);\n}\n  source-end",
    );
    expect(detailOf("after:callee")).toContain(
      "source=caller.ts:9-11 snapshot=after begin\nfunction callee(param) {\n  return nested(param);\n}\n  source-end",
    );
    // A call site stays on the definition that writes it, and the binding it
    // resolved to stays on the callee node, however deep the callee sits.
    expect(detailOf("after:changed")).toContain("evidence=call-sites-in-this-definition count=1");
    expect(detailOf("after:changed")).toContain('call callee @ caller.ts:6');
    expect(detailOf("after:callee")).toContain("evidence=call-sites-reaching-this-definition count=1");
    expect(detailOf("after:callee")).toContain('call callee @ caller.ts:6');
    expect(detailOf("after:callee")).toContain('arg[1] -> param: "input"');
    expect(detailOf("after:callee")).toContain('call nested @ caller.ts:10');
    expect(detailOf("after:deeper")).toContain('call deepest @ caller.ts:16');
    expect(detailOf("after:deepest")).toContain("evidence=call-sites-reaching-this-definition count=1");
    // The caller's other calls are not expanded, and the walk stops at depth four.
    expect(detailOf("after:caller")).toContain('call changed @ caller.ts:2');
    const blocks = context(source, 5).join("\n");
    expect(blocks).toContain("reason=distant-descendants-or-siblings depth-limit=4");
    expect(blocks).not.toContain('call sibling @ caller.ts:3');
    expect(blocks).not.toContain("call beyond @ caller.ts:19");
  });

  test("retains an unseen dependency before new-file bodies already visible in the diff", () => {
    const lines = Array.from({ length: MAX_CONTEXT_NODES + 1 }, (_, i) =>
      `export function caller${i}(value) { return dependency(value); }`);
    const dependency = "export function dependency(value) { if (value < 0) throw new Error('negative'); return value; }";
    const [reviewUnit] = parseDiff([
      "diff --git a/caller.ts b/caller.ts", "--- /dev/null", "+++ b/caller.ts",
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`),
    ].join("\n"));
    const index = buildIndex([
      ...extractFunctions("caller.ts", lines.join("\n")),
      ...extractFunctions("dependency.ts", dependency),
    ]);
    const planned = buildCallContext([reviewUnit], buildIndex([]), index, {
      after: loc => loc.file === "dependency.ts" ? dependency : lines[loc.line - 1],
    }).get(reviewUnit.id)!.nodes;
    const plan = new ContextPlan(buildJevState(reviewUnit), planned);
    const supplied = plan.state.contextNodes!;
    expect(supplied.length).toBeLessThanOrEqual(MAX_CONTEXT_NODES);
    expect(supplied.find(node => node.key === "after:dependency")?.detail).toContain(dependency);
    // Reordering never discards the original source or its call evidence.
    expect(planned.find(node => node.key === "after:caller0")?.detail).toContain(lines[0]);
  });

  test("reports no evidence rather than an empty node body", () => {
    const [node] = nodes("function caller() { return 1; }", 1, { after: () => "function caller() { return 1; }" });
    expect(node.detail).toContain("evidence=none-selected reason=no-selected-call-site-touches-this-definition");
  });

  test("omits units that contribute neither blocks nor nodes", () => {
    const index = buildIndex(extractFunctions("other.ts", "function elsewhere() {}"));
    const reviewUnit = unit(1);
    reviewUnit.diff = "@@ -1 +1 @@\n-x;\n+y;";
    expect(buildCallContext([reviewUnit], buildIndex([]), index).has("caller")).toBe(false);
  });
});
