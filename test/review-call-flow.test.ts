import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildCallFlows,
  reportOrderedTextHunkFiles,
  CALL_FLOW_MAX_CHILDREN,
  CALL_FLOW_MAX_CROSS_FILE_CHILDREN,
  CALL_FLOW_MAX_DEPTH,
  CALL_FLOW_MAX_NODES,
  CALL_FLOW_MAX_ROOTS,
} from "../src/review/call-flow.js";
import { reviewDiff } from "../src/review/service.js";
import type { DefinitionDetail } from "../src/review/source.js";
import type { DiffNode, DiffStatus, DiffTreeResult } from "../src/types.js";
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
  definition?: { file: string; line: number; endLine?: number };
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
  if (spec.definition !== undefined) node.definition = spec.definition;
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

/** Import line for a fixture source file, as ESM TypeScript writes it. */
function importLine(from: string, name: string): string {
  return `import { ${name} } from '${from.replace(/\.ts$/, "")}';\n`;
}

function commitAll(cwd: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", message], { cwd });
}

/** Short revision label the report prints for provenance. */
function shortRef(cwd: string, ref: string): string {
  return execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd, encoding: "utf8" }).trim().slice(0, 8);
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
  test("a call site keeps its own location while the callee's definition detail is attached", () => {
    const tree = engineTree("FlowRunner.run", {
      key: "FlowRunner.run",
      status: "added",
      file: "src/changed.ts",
      line: 10,
      definition: { file: "src/changed.ts", line: 10, endLine: 14 },
      children: [
        {
          key: "target",
          status: "added",
          file: "src/changed.ts",
          line: 12,
          definition: { file: "src/lib/target.ts", line: 4, endLine: 6 },
        },
        { key: "kept", status: "same", file: "src/other.ts", line: 99 },
      ],
    });
    const detail = (node: DiffNode): DefinitionDetail =>
      node.key === "target"
        ? {
            source: { file: "src/lib/target.ts", line: 4, endLine: 6, ref: "abc12345", text: "function target() {}" },
            description: "Runs the target.",
          }
        : {};

    const [entry] = buildCallFlows(["src/changed.ts"], [tree], detail);
    const [root] = entry.trees;
    const [target, kept] = root.children;

    expect(entry.truncated).toBe(false);
    // The call happens in the changed file; the definition lives elsewhere.
    expect(target).toMatchObject({ key: "target", file: "src/changed.ts", line: 12, status: "added" });
    expect(target?.source).toMatchObject({ file: "src/lib/target.ts", line: 4, endLine: 6, ref: "abc12345" });
    expect(target?.description).toBe("Runs the target.");
    // The lookup had nothing for this call, so no source is invented for it.
    expect(kept?.source).toBeUndefined();
    expect(kept?.description).toBeUndefined();
    expect(Object.keys(kept ?? {})).not.toContain("source");
  });

  test("a pruned node's detail never reaches the report", () => {
    // Depth 4 edges cut the chain below e4; e5 is never serialized, so its
    // distinctive source must not appear in the output at all.
    const tree = engineTree("ctx", {
      key: "ctx",
      file: "src/changed.ts",
      definition: { file: "src/changed.ts", line: 1 },
      children: [
        { key: "e1", children: [{ key: "e2", children: [{ key: "e3", children: [{ key: "e4", children: [{ key: "e5", file: "src/deep.ts", line: 9, definition: { file: "src/deep.ts", line: 9 } }] }] }] }] },
      ],
    });
    const detail = (node: DiffNode): DefinitionDetail => ({
      source: { file: `def/${node.key}.ts`, line: 1, endLine: 1, ref: "abc12345", text: `source of ${node.key}` },
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree], detail);
    const json = JSON.stringify(entry);

    expect(entry.truncated).toBe(true);
    expect(json).toContain("source of e4");
    expect(json).not.toContain("source of e5");
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

  test("a wide node keeps its eight children plus a separate allowance for cross-file callees", () => {
    const locals = Array.from({ length: 10 }, (_unused, index) => ({
      key: `local${index}`,
      file: "src/changed.ts",
      line: index + 2,
      definition: { file: "src/changed.ts", line: index + 20 },
    }));
    const foreign = Array.from({ length: 10 }, (_unused, index) => ({
      key: `foreign${index}`,
      file: "src/changed.ts",
      line: index + 40,
      definition: { file: "src/other.ts", line: index + 1 },
    }));
    const tree = engineTree("fan", {
      key: "fan",
      file: "src/changed.ts",
      line: 1,
      definition: { file: "src/changed.ts", line: 1 },
      children: [...locals, ...foreign],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const kept = entry.trees[0].children.map(child => child.key);

    // Local calls fill the regular bound; cross-file callees get their own.
    expect(kept).toHaveLength(CALL_FLOW_MAX_CHILDREN + CALL_FLOW_MAX_CROSS_FILE_CHILDREN);
    expect(kept).toEqual([
      ...locals.slice(0, CALL_FLOW_MAX_CHILDREN).map(spec => spec.key),
      ...foreign.slice(0, CALL_FLOW_MAX_CROSS_FILE_CHILDREN).map(spec => spec.key),
    ]);
    expect(entry.truncated).toBe(true);
  });

  test("an extra allowance that covers every call sets no truncation flag", () => {
    // Nine calls: eight fill the regular bound and one cross-file callee fits the
    // extra allowance, so nothing left the report. A flag here would name a cut
    // that never happened and make the marker meaningless.
    const locals = Array.from({ length: 8 }, (_unused, index) => ({
      key: `local${index}`,
      file: "src/changed.ts",
      line: index + 2,
      definition: { file: "src/changed.ts", line: index + 20 },
    }));
    const tree = engineTree("fan", {
      key: "fan",
      file: "src/changed.ts",
      line: 1,
      definition: { file: "src/changed.ts", line: 1 },
      children: [
        ...locals,
        { key: "foreign", file: "src/changed.ts", line: 40, definition: { file: "src/other.ts", line: 1 } },
      ],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const kept = entry.trees[0].children.map(child => child.key);

    expect(kept).toEqual([...locals.map(spec => spec.key), "foreign"]);
    expect(entry.truncated).toBe(false);
  });

  test("the cross-file allowance is bounded and flags what it drops", () => {
    const locals = Array.from({ length: 5 }, (_unused, index) => ({
      key: `local${index}`,
      file: "src/changed.ts",
      line: index + 2,
    }));
    const foreign = Array.from({ length: 20 }, (_unused, index) => ({
      key: `foreign${index}`,
      file: "src/changed.ts",
      line: index + 40,
      definition: { file: "src/other.ts", line: index + 1 },
    }));
    const tree = engineTree("fan", {
      key: "fan",
      file: "src/changed.ts",
      line: 1,
      children: [...locals, ...foreign],
    });

    const [entry] = buildCallFlows(["src/changed.ts"], [tree]);
    const kept = entry.trees[0].children.map(child => child.key);

    expect(kept).toHaveLength(CALL_FLOW_MAX_CHILDREN + CALL_FLOW_MAX_CROSS_FILE_CHILDREN);
    expect(kept).not.toContain("foreign19");
    expect(entry.truncated).toBe(true);
  });

  test("a tree is filed under a file its call resolves into, even with no call site there", () => {
    const tree = engineTree("main", {
      key: "main",
      file: "src/main.ts",
      line: 1,
      definition: { file: "src/main.ts", line: 1 },
      children: [{ key: "leaf", file: "src/main.ts", line: 2, definition: { file: "src/leaf.ts", line: 7 } }],
    });

    const entries = buildCallFlows(["src/leaf.ts", "src/unreached.ts"], [tree]);

    expect(entries.map(entry => entry.file)).toEqual(["src/leaf.ts"]);
    // The call still reports the call site, not the file it resolved into.
    expect(entries[0]?.trees[0]?.children[0]).toMatchObject({ key: "leaf", file: "src/main.ts", line: 2 });
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
      commitAll(dir, "base");
      writeFileSync(join(dir, "checkout.ts"), "export function checkout() { charge(); }\nfunction authorize() {}\nfunction charge() {}\n");
      commitAll(dir, "head");

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" });

      expect(report.callFlowAvailability).toBe("available");
      expect(report.callFlows.map(entry => entry.file)).toEqual(["checkout.ts"]);
      const [entry] = report.callFlows;
      expect(entry.truncated).toBe(false);
      const nodes = flatten(entry.trees);
      const [root] = nodes;
      expect(root.node).toMatchObject({ key: "checkout", status: "changed", file: "checkout.ts" });
      expect(root.node.line).toBeGreaterThan(0);
      // The root and its callees kept in this file resolved to their definitions.
      expect(root.node.source).toMatchObject({ file: "checkout.ts", ref: shortRef(dir, "HEAD") });
      const removed = nodes.find(flat => flat.node.key === "authorize");
      expect(removed?.node).toMatchObject({ status: "removed", file: "checkout.ts", line: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("definition source follows the snapshot each node resolved in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-flow-sources-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
      write("entry.ts", `${importLine("./checkout.ts", "checkout")}/** Submits an order without changing caller code. */\nexport function submitOrder() {\n  return checkout();\n}\n`);
      write("checkout.ts", `${importLine("./payment.ts", "authorizePayment")}${importLine("./inventory.ts", "reserveStock")}/** Starts a checkout. */\nexport function checkout() {\n  authorizePayment();\n  return reserveStock();\n}\n`);
      write("payment.ts", "/** Rejects unauthorized payments. */\nexport function authorizePayment() {\n  return paymentGateway();\n}\nfunction paymentGateway() { return true; }\n");
      write("inventory.ts", "/** Reserves stock; literal <script>alert(\"source\")</script> stays text. */\nexport function reserveStock() {\n  return getAvailable();\n}\nfunction getAvailable() {\n  return normalizeStock();\n}\nfunction normalizeStock() {\n  return 4;\n}\n");
      write("receipt.ts", "export function publishReceipt() {\n  return formatReceipt();\n}\nfunction formatReceipt() { return \"receipt\"; }\n");
      commitAll(dir, "base");

      // The head revision drops the authorization call and rewrites its
      // definition, so reading the wrong side of the range is visible.
      write("checkout.ts", `${importLine("./inventory.ts", "reserveStock")}${importLine("./receipt.ts", "publishReceipt")}/** Starts a checkout. */\nexport function checkout() {\n  reserveStock();\n  Math.max(1, 2);\n  return publishReceipt();\n}\n`);
      write("payment.ts", "/** Legacy gateway, no longer called. */\nexport function authorizePayment() {\n  return legacyGateway();\n}\nfunction legacyGateway() { return true; }\n");
      commitAll(dir, "head");
      const from = shortRef(dir, "HEAD~1");
      const to = shortRef(dir, "HEAD");

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" });

      expect(report.callFlowAvailability).toBe("available");
      const entry = report.callFlows.find(flow => flow.file === "checkout.ts");
      expect(entry?.truncated).toBe(false);
      const nodes = flatten(entry?.trees ?? []);
      const node = (key: string) => nodes.find(flat => flat.node.key === key)?.node;

      // Unchanged upstream caller, kept in a file the diff never touched.
      const submitOrder = node("submitOrder");
      expect(submitOrder).toMatchObject({ file: "entry.ts", status: "changed" });
      expect(submitOrder?.source).toMatchObject({ file: "entry.ts", ref: to });
      expect(submitOrder?.description).toBe("Submits an order without changing caller code.");

      // Removed call: the definition only exists in the from snapshot, and the
      // body text proves which side was read.
      const authorizePayment = node("authorizePayment");
      expect(authorizePayment).toMatchObject({ file: "checkout.ts", status: "removed" });
      expect(authorizePayment?.source).toMatchObject({ file: "payment.ts", ref: from, line: 2 });
      expect(authorizePayment?.source?.text).toContain("paymentGateway");
      expect(authorizePayment?.description).toBe("Rejects unauthorized payments.");

      // Unchanged cross-file callee reached at the expansion boundary: the
      // reported line is its definition, never the call site above it.
      const normalizeStock = node("normalizeStock");
      expect(normalizeStock).toMatchObject({ status: "same", file: "inventory.ts", line: 6 });
      expect(normalizeStock?.source).toMatchObject({ file: "inventory.ts", ref: to, line: 8, endLine: 10 });
      expect(normalizeStock?.source?.text).toContain("return 4;");

      // A comment is copied verbatim: escaping belongs to the renderer.
      const reserveStock = node("reserveStock");
      expect(reserveStock?.description).toBe('Reserves stock; literal <script>alert("source")</script> stays text.');

      // A callee with no indexed definition states nothing rather than guessing.
      const unknown = node("Math.max");
      expect(unknown).toMatchObject({ file: "checkout.ts" });
      expect(unknown?.source).toBeUndefined();
      expect(unknown?.description).toBeUndefined();

      // No call site is ever presented as the definition.
      const publishReceipt = node("publishReceipt");
      expect(publishReceipt).toMatchObject({ file: "checkout.ts", status: "added" });
      expect(publishReceipt?.source).toMatchObject({ file: "receipt.ts", ref: to });
      expect(publishReceipt?.source?.text).toContain("formatReceipt();");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a deleted call chain reads every definition from the from snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-flow-removed-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
      write("entry.ts", `${importLine("./checkout.ts", "checkout")}export function submitOrder() {\n  return checkout();\n}\n`);
      write("checkout.ts", `${importLine("./payment.ts", "authorizePayment")}export function checkout() {\n  return authorizePayment();\n}\n`);
      write("payment.ts", "export function authorizePayment() {\n  return baseGateway();\n}\nfunction baseGateway() { return true; }\n");
      commitAll(dir, "base");

      // The whole chain is deleted in head and the file its last callee lives in
      // is rewritten, so reading the `to` side would show head's body, or
      // nothing at all for the deleted files.
      rmSync(join(dir, "entry.ts"));
      rmSync(join(dir, "checkout.ts"));
      write("payment.ts", "export function authorizePayment() {\n  return headGateway();\n}\nfunction headGateway() { return true; }\n");
      commitAll(dir, "head");
      const from = shortRef(dir, "HEAD~1");
      const to = shortRef(dir, "HEAD");

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" });
      const nodes = flatten(report.callFlows.flatMap(entry => entry.trees));
      const node = (key: string) => nodes.find(flat => flat.node.key === key)?.node;

      // A root in a file head no longer has can only be read from `from`.
      expect(node("submitOrder")).toMatchObject({ status: "removed", file: "entry.ts" });
      expect(node("submitOrder")?.source?.text).toContain("return checkout();");
      // A descendant of a removed parent keeps the same rule, even though its
      // own file still exists in head with a different body.
      expect(node("baseGateway")?.source).toMatchObject({ ref: from, file: "payment.ts" });
      expect(node("baseGateway")?.source?.text).toContain("baseGateway");
      // The intermediates are checked by name too: the filter below cannot fail
      // for a node whose source went missing.
      expect(node("checkout")?.source).toMatchObject({ file: "checkout.ts", ref: from });
      expect(node("authorizePayment")?.source).toMatchObject({ file: "payment.ts", ref: from });
      expect(node("authorizePayment")?.source?.text).toContain("baseGateway();");
      // Both snapshots are in play in one report: only removed calls are read
      // from `from`, and the surviving caller is still shown at its head body.
      const sourced = nodes.filter(flat => flat.node.source !== undefined);
      expect(sourced.filter(flat => flat.node.status === "removed").every(flat => flat.node.source?.ref === from)).toBe(true);
      expect(sourced.filter(flat => flat.node.status !== "removed").every(flat => flat.node.source?.ref === to)).toBe(true);
      expect(sourced.map(flat => flat.node.status)).toContain("changed");
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

      const report = await reviewDiff({ repo: dir, from: "HEAD~1", to: "HEAD" });

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

    const report = await reviewDiff({ diff: patch, source: "patch" });

    expect(report.callFlows).toEqual([]);
    expect(report.callFlowAvailability).toBe("needs-git-range");
    expect(report.warnings.join("\n")).toMatch(/patch-only/i);
    expect(report.callFlow).toEqual([]);
  });
});
