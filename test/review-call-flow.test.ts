import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildCallFlows,
  reportOrderedTextHunkFiles,
  CALL_FLOW_MAX_CHILDREN,
  CALL_FLOW_MAX_DEPTH,
  CALL_FLOW_MAX_NODES,
  CALL_FLOW_MAX_ROOTS,
} from "../src/review/call-flow.js";
import { reviewDiff } from "../src/review/service.js";
import type { DiffStatus, DiffNode, DiffTreeResult } from "../src/types.js";
import type { CallFlowNode, ReviewItem, ReviewUnit } from "../src/review/types.js";

/**
 * Synthetic engine trees. These tests never build a repository: pruning,
 * grouping, and status derivation are pure functions of the engine result.
 */

interface NodeSpec {
  key: string;
  status?: DiffStatus;
  file?: string;
  line?: number;
  children?: NodeSpec[];
}

function engineNode(spec: NodeSpec): DiffNode {
  const node: DiffNode = {
    key: spec.key,
    label: spec.key,
    status: spec.status ?? "same",
    children: (spec.children ?? []).map(engineNode),
  };
  if (spec.file !== undefined) node.file = spec.file;
  if (spec.line !== undefined) node.line = spec.line;
  return node;
}

/** A tree whose ASCII rendering is unrelated to its structure, so any code path
 * that leaked into the text would be visible in the assertions. */
function engineTree(entry: string, spec: NodeSpec, ascii = `rendered ${entry}`): DiffTreeResult {
  const tree = engineNode(spec);
  return { entry, ascii, tree };
}

interface UnitSpec {
  file: string;
  header?: string;
}

let unitCounter = 0;

function reviewUnit(spec: UnitSpec): ReviewUnit {
  unitCounter += 1;
  return {
    id: `hunk-${unitCounter}`,
    file: spec.file,
    header: spec.header ?? "@@ -1 +1 @@",
    diff: `${spec.header ?? "@@ -1 +1 @@"}\n-a\n+b\n`,
    added: 1,
    removed: 1,
    oldStart: 1,
    newStart: 1,
  };
}

function reviewItem(unit: ReviewUnit): ReviewItem {
  return { ...unit, status: "attention", priority: 90, reasons: ["test"] };
}

interface FlatNode {
  node: CallFlowNode;
  depth: number;
}

function flatten(nodes: readonly CallFlowNode[], depth = 0): FlatNode[] {
  return nodes.flatMap(node => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

function describeTree(node: CallFlowNode): string {
  const loc = node.file === undefined ? "" : `@${node.file}:${node.line ?? "?"}`;
  const children = node.children.map(describeTree).join(",");
  return `${node.key}${loc}[${node.status}]${children === "" ? "" : `(${children})`}`;
}

describe("report call flows", () => {
  test("a node carries only key, label, status, file, line, and children", () => {
    const tree = engineTree("FlowRunner.run", {
      key: "FlowRunner.run",
      status: "added",
      file: "src/changed.ts",
      line: 10,
      children: [
        { key: "target", status: "added", file: "src/changed.ts", line: 12 },
        { key: "kept", status: "same", file: "src/other.ts", line: 99 },
      ],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);

    expect(entry.file).toBe("src/changed.ts");
    expect(entry.truncated).toBe(false);
    expect(entry.trees).toHaveLength(1);
    expect(entry.trees[0]).toEqual({
      key: "FlowRunner.run",
      label: "FlowRunner.run",
      status: "added",
      file: "src/changed.ts",
      line: 10,
      children: [
        { key: "target", label: "target", status: "added", file: "src/changed.ts", line: 12, children: [] },
        { key: "kept", label: "kept", status: "same", file: "src/other.ts", line: 99, children: [] },
      ],
    });
  });

  test("recorded locations survive removal and the engine's statuses are preserved", () => {
    const tree = engineTree("checkout", {
      key: "checkout",
      file: "src/cart.ts",
      line: 3,
      children: [
        { key: "authorize", status: "removed", file: "src/auth.ts", line: 41 },
        { key: "charge", status: "same", file: "src/payments.ts", line: 7 },
      ],
    });

    const [entry] = buildCallFlows(["src/cart.ts"], [tree]);
    const [root] = entry.trees;
    const [authorize, charge] = root.children;

    expect(root.status).toBe("changed");
    expect(authorize).toMatchObject({ status: "removed", file: "src/auth.ts", line: 41 });
    expect(charge).toMatchObject({ status: "same", file: "src/payments.ts", line: 7 });
  });

  test("a same definition whose descendant changed is reported as changed", () => {
    const tree = engineTree("handler", {
      key: "handler",
      file: "src/changed.ts",
      line: 1,
      children: [
        { key: "middle", children: [{ key: "leaf", status: "added", file: "src/changed.ts", line: 9 }] },
        { key: "untouched" },
      ],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);

    expect(describeTree(entry.trees[0])).toBe(
      "handler@src/changed.ts:1[changed](middle[changed](leaf@src/changed.ts:9[added]),untouched[same])",
    );
  });

  test("status derivation visits every sibling after the first change", () => {
    const tree = engineTree("checkout", {
      key: "checkout", file: "checkout.ts",
      children: [
        { key: "first", status: "added", file: "checkout.ts" },
        { key: "second", status: "removed", file: "checkout.ts" },
        { key: "third", file: "checkout.ts", children: [{ key: "nested", status: "added", file: "checkout.ts" }] },
        { key: "untouched", file: "checkout.ts" },
      ],
    });
    const [entry] = buildCallFlows(["checkout.ts"], [tree]);
    expect(entry.trees[0].children.map(node => node.status)).toEqual(["added", "removed", "changed", "same"]);
  });

  test("derivation reads the whole tree, so a pruned branch still marks its ancestors", () => {
    // The deep branch is what made ctx changed; depth 4 edges cut the branch
    // itself, and ui still has to report the change it cannot show.
    const deep = { key: "e5", status: "added" as const, file: "src/changed.ts", line: 50 };
    const tree = engineTree("ctx", {
      key: "ctx",
      file: "src/changed.ts",
      children: [
        { key: "e1", children: [{ key: "e2", children: [{ key: "e3", children: [{ key: "e4", children: [deep] }] }] }] },
      ],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const [root] = entry.trees;
    const chain = flatten(entry.trees);

    expect(entry.truncated).toBe(true);
    expect(chain.map(flat => flat.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(chain.at(-1)?.node.key).toBe("e4");
    expect(root.status).toBe("changed");
    expect(chain.every(flat => flat.node.status === "changed")).toBe(true);
  });

  test("the report never reads the ASCII rendering", () => {
    const tree = engineTree(
      "entry",
      { key: "realCall", file: "src/changed.ts", line: 2, children: [{ key: "realChild", file: "src/changed.ts", line: 4 }] },
      "ascii-only-call()\n└─ ascii-only-child()",
    );

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const json = JSON.stringify(entry);

    expect(flatten(entry.trees).map(flat => flat.node.label)).toEqual(["realCall", "realChild"]);
    expect(json).not.toContain("ascii-only");
    expect(json).not.toContain("rendered");
  });

  test("serialization never mutates the engine tree", () => {
    const tree = engineTree("mutable", {
      key: "mutable",
      file: "src/changed.ts",
      line: 1,
      children: [
        {
          key: "fan",
          file: "src/changed.ts",
          line: 2,
          children: Array.from({ length: CALL_FLOW_MAX_CHILDREN + 2 }, (_unused, index) => ({
            key: `child${index}`,
            file: "src/other.ts",
            line: index + 3,
          })),
        },
        { key: "deep", children: [{ key: "deeper", children: [{ key: "deepest", status: "added", file: "src/changed.ts", line: 9 }] }] },
      ],
    });
    const before = JSON.stringify(tree);

    const [entry] = buildCallFlows(["src/changed.ts", "src/other.ts"], [tree]);

    expect(JSON.stringify(tree)).toBe(before);
    expect(entry.truncated).toBe(true);
  });

  test("roots are capped per file at the documented bound", () => {
    const trees = Array.from({ length: CALL_FLOW_MAX_ROOTS + 3 }, (_unused, index) =>
      engineTree(`root${index}`, { key: `root${index}`, file: "src/changed.ts", line: index + 1 }),
    );

    const [entry] = buildCallFlows(["src/changed.ts"], trees);

    expect(entry.trees).toHaveLength(CALL_FLOW_MAX_ROOTS);
    expect(entry.trees.map(root => root.key)).toEqual(
      Array.from({ length: CALL_FLOW_MAX_ROOTS }, (_unused, index) => `root${index}`),
    );
    expect(entry.truncated).toBe(true);
  });

  test("a node with more children than the bound keeps the bound in source order", () => {
    const tree = engineTree("fan", {
      key: "fan",
      file: "src/changed.ts",
      line: 1,
      children: Array.from({ length: CALL_FLOW_MAX_CHILDREN + 2 }, (_unused, index) => ({
        key: `child${index}`,
        file: "src/changed.ts",
        line: index + 2,
      })),
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);

    expect(entry.trees[0].children.map(child => child.key)).toEqual(
      Array.from({ length: CALL_FLOW_MAX_CHILDREN }, (_unused, index) => `child${index}`),
    );
    expect(entry.truncated).toBe(true);
  });

  test("changed branches that reach the file win the child budget", () => {
    const siblings = Array.from({ length: 10 }, (_unused, index) => ({
      key: `sibling${index}`,
      file: "src/other.ts",
      line: index + 1,
    }));
    // Two late siblings reach the changed file and changed; they must survive a
    // budget the first eight identical siblings would otherwise consume.
    const tree = engineTree("fan", {
      key: "fan",
      file: "src/changed.ts",
      line: 1,
      children: [
        ...siblings,
        { key: "lateChanged", children: [{ key: "hit", status: "added" as const, file: "src/changed.ts", line: 80 }] },
        { key: "lateRelevant", children: [{ key: "hit2", file: "src/changed.ts", line: 90 }] },
      ],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const kept = entry.trees[0].children.map(child => child.key);

    expect(kept).toHaveLength(CALL_FLOW_MAX_CHILDREN);
    expect(kept).toContain("lateChanged");
    expect(kept).toContain("lateRelevant");
    expect(kept.indexOf("lateChanged")).toBeLessThan(kept.indexOf("lateRelevant"));
    // Survivors keep source order rather than the priority order used to pick them.
    expect(kept.slice(0, 6)).toEqual(siblings.slice(0, 6).map(sibling => sibling.key));
    expect(entry.truncated).toBe(true);
  });

  test("the total node budget caps one file and flags the cut", () => {
    const branch = (prefix: string): NodeSpec => ({
      key: `${prefix}0`,
      file: "src/changed.ts",
      children: Array.from({ length: CALL_FLOW_MAX_CHILDREN }, (_unused, index) => ({
        key: `${prefix}${index}`,
        file: "src/changed.ts",
        children: Array.from({ length: CALL_FLOW_MAX_CHILDREN }, (_unusedChild, child) => ({
          key: `${prefix}${index}-${child}`,
          file: "src/changed.ts",
          children: Array.from({ length: CALL_FLOW_MAX_CHILDREN }, (_unusedLeaf, leaf) => ({
            key: `${prefix}${index}-${child}-${leaf}`,
            file: "src/changed.ts",
          })),
        })),
      })),
    });
    const large = branch("n");
    const tree = engineTree("big", { ...large, key: "big", children: [
      ...large.children ?? [],
      { key: "lateChange", status: "added", file: "src/changed.ts" },
    ] });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const nodes = flatten(entry.trees);

    expect(nodes).toHaveLength(CALL_FLOW_MAX_NODES);
    expect(entry.truncated).toBe(true);
    expect(Math.max(...nodes.map(flat => flat.depth))).toBeLessThanOrEqual(CALL_FLOW_MAX_DEPTH);
    expect(nodes.find(flat => flat.node.key === "lateChange")?.node.status).toBe("added");
  });

  test("a tree is filed under every changed file it reaches, and only those", () => {
    const tree = engineTree("main", {
      key: "main",
      file: "src/main.ts",
      line: 1,
      children: [
        {
          key: "helper",
          file: "src/main.ts",
          line: 5,
          children: [{ key: "write", file: "src/store.ts", line: 20 }],
        },
        { key: "render", file: "src/ui.ts", line: 30 },
      ],
    });

    const entries = buildCallFlows(["src/store.ts", "src/ui.ts", "docs/notes.md"], [tree]);

    expect(entries.map(entry => entry.file)).toEqual(["src/store.ts", "src/ui.ts"]);
    // File filtering must not silently remove cross-file caller/callee context.
    for (const entry of entries) {
      expect(flatten(entry.trees).map(flat => flat.node.key)).toEqual(["main", "helper", "write", "render"]);
    }
  });


  test("identical trees are listed once per file", () => {
    const spec: NodeSpec = { key: "dup", file: "src/changed.ts", line: 1, children: [{ key: "x", file: "src/changed.ts", line: 2 }] };
    const duplicate = [engineTree("dup", spec), engineTree("dup", spec)];

    const [entry] = buildCallFlows(["src/changed.ts"], duplicate);

    expect(entry.trees).toHaveLength(1);
    expect(entry.truncated).toBe(false);
  });

  test("files are grouped once each in report order", () => {
    const units = [
      reviewUnit({ file: "src/b.ts" }),
      reviewUnit({ file: "src/a.ts" }),
      reviewUnit({ file: "src/b.ts" }),
    ];
    const items = units.map(reviewItem);

    expect(reportOrderedTextHunkFiles(items, units)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  test("metadata-only files and files no tree reaches get no entry", () => {
    const units = [
      reviewUnit({ file: "assets/logo.png", header: "File metadata" }),
      reviewUnit({ file: "src/changed.ts" }),
    ];
    const items = units.map(reviewItem);
    const tree = engineTree("entry", { key: "entry", file: "src/changed.ts", line: 1 });

    const files = reportOrderedTextHunkFiles(items, units);
    const entries = buildCallFlows([...files, "src/untouched.ts"], [tree]);

    expect(files).toEqual(["src/changed.ts"]);
    expect(entries.map(entry => entry.file)).toEqual(["src/changed.ts"]);
  });

  test("a git-range review carries real structured trees for changed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-flow-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), "export function checkout() { authorize(); charge(); }\nfunction authorize() {}\nfunction charge() {}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), "export function checkout() { charge(); }\nfunction authorize() {}\nfunction charge() {}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "head"], { cwd: dir });

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { mock: true });

      expect(report.callFlowAvailability).toBe("available");
      expect(report.callFlows.map(entry => entry.file)).toEqual(["checkout.ts"]);
      const [entry] = report.callFlows;
      expect(entry.truncated).toBe(false);
      const nodes = flatten(entry.trees);
      const [root] = nodes;
      expect(root.node).toMatchObject({ key: "checkout", status: "changed", file: "checkout.ts" });
      expect(root.node.line).toBeGreaterThan(0);
      expect(Object.keys(root.node).sort()).toEqual(["children", "file", "key", "label", "line", "status"]);
      const allowed = ["children", "file", "key", "label", "line", "status"];
      expect(nodes.flatMap(flat => Object.keys(flat.node)).filter(key => !allowed.includes(key))).toEqual([]);
      const removed = nodes.find(flat => flat.node.key === "authorize");
      expect(removed?.node).toMatchObject({ status: "removed", file: "checkout.ts", line: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a range with no structural results says so instead of reporting empty trees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-flow-notes-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "notes.txt"), "first\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "notes.txt"), "second\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "head"], { cwd: dir });

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" }, { mock: true });

      expect(report.callFlows).toEqual([]);
      expect(report.callFlowAvailability).toBe("no-changes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a patch review reports that structured flows need a git range", async () => {
    const patch = [
      "diff --git a/src/changed.ts b/src/changed.ts",
      "--- a/src/changed.ts",
      "+++ b/src/changed.ts",
      "@@ -1,2 +1,2 @@",
      " const kept = 1;",
      "-const total = 1;",
      "+const total = 2;",
      "",
    ].join("\n");

    const report = await reviewDiff({ diff: patch, source: "patch" }, { mock: true });

    expect(report.callFlows).toEqual([]);
    expect(report.callFlowAvailability).toBe("needs-git-range");
    expect(report.warnings.join("\n")).toMatch(/patch-only/i);
    expect(report.callFlow).toEqual([]);
  });
});
