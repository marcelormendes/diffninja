import { describe, expect, test } from "vitest";
import { buildCallSitesFromInfo } from "../src/calltree.js";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { formatSourceLoc } from "../src/loc.js";
import { buildCallContext } from "../src/review/call-context.js";
import type { ContextSources } from "../src/review/call-context.js";
import {
  ContextPlan,
  INITIAL_STATE_CHARS,
  MAX_ADDED_CONTEXT_BYTES,
} from "../src/review/context-plan.js";
import { MAX_STATE_CHARS } from "../src/review/context-limits.js";
import { buildJevState } from "../src/review/jev.js";
import type { ReviewUnit } from "../src/review/types.js";

/** Members of one class where `find` calls its sibling `load`. */
const METHOD_PAIR = [
  "  find(id) {",
  "    return this.load(id);",
  "  }",
  "  load(id) {",
  "    return id;",
  "  }",
  "}",
];

/** The same members with a decorator on each, where member decorators are legal. */
const DECORATED_MEMBERS = [
  "  @Log()",
  "  find(id) {",
  "    return this.load(id);",
  "  }",
  "  @Log()",
  "  load(id) {",
  "    return id;",
  "  }",
  "}",
];

/** One `Svc` class: the given declaration line(s), then the shared members. */
function svcClass(declaration: string, members: readonly string[] = METHOD_PAIR): string {
  return [...declaration.split("\n"), ...members].join("\n");
}

/** Every place a decorator may sit relative to the export of a class. */
const DECORATED_EXPORTS = [
  {
    name: "stacked decorators above the export",
    source: svcClass("@Injectable()\n@Module({ providers: [Svc] })\nexport class Svc {"),
  },
  {
    name: "a decorator whose arguments span lines",
    source: svcClass('@Controller({\n  path: "svc",\n})\nexport class Svc {'),
  },
  {
    name: "a decorator after the export keyword",
    source: svcClass("export @Injectable() class Svc {"),
  },
  {
    name: "a decorated default export",
    source: svcClass("@Injectable()\nexport default class Svc {"),
  },
  {
    name: "a decorated abstract class",
    source: svcClass("@Injectable()\nexport abstract class Svc {"),
  },
  {
    name: "decorators on the members only",
    source: svcClass("export class Svc {", DECORATED_MEMBERS),
  },
];

/** The decorated service whose hunk context the structured tests read. */
const ORDERS_SOURCE = [
  'import { Injectable, Module } from "@nestjs/common";',
  "",
  "@Injectable()",
  "@Module({ providers: [OrdersService], exports: [OrdersService] })",
  "export class OrdersService {",
  "  async find(id: string, user: string) {",
  "    const order = await this.load(id);",
  "    return this.toDto(order, user);",
  "  }",
  "  async load(id: string) {",
  "    return this.decode(id);",
  "  }",
  "  private decode(id: string) {",
  "    return id;",
  "  }",
  "  private toDto(order: Order, user: string) {",
  "    return { order, user };",
  "  }",
  "}",
];

/**
 * Decorated service whose changed method repeats one sibling call per stage:
 * each stage adds a resolved call site to the shared callee and to the changed
 * body, so the changed body cannot join the initial state whole.
 */
function ledgerSource(stages: number, operations: readonly string[]): readonly string[] {
  const lines = [
    'import { Injectable } from "@nestjs/common";',
    "",
    "@Injectable()",
    "export class LedgerService {",
    "  constructor(private readonly repo: Repository) {}",
    "  async post(entries: Entry[]) {",
    "    const staged: Entry[] = [];",
    "    for (const entry of entries) {",
    "      const normalized = this.normalize(entry);",
  ];
  for (let stage = 0; stage < stages; stage += 1) {
    lines.push(`      staged.push(this.stage(normalized, ${stage}));`);
  }
  lines.push("    }", "    return this.repo.write(staged);", "  }");
  for (const operation of operations) {
    lines.push(
      `  async ${operation}(id: string) {`,
      "    const entries = await this.repo.read(id);",
      "    const adjusted = entries.map((entry) => ({ ...entry, id }));",
      "    await this.post(adjusted);",
      "    return this.normalize(entries[0]);",
      "  }",
    );
  }
  lines.push(
    "  private normalize(entry: Entry) { return entry; }",
    "  private stage(entry: Entry, stage: number) { return { ...entry, stage }; }",
    "}",
  );
  return lines;
}

/** One changed line of the after snapshot, with the two lines that follow it. */
function changedHunk(
  file: string,
  lines: readonly string[],
  line: number,
  replacement: string,
): ReviewUnit {
  const header = `@@ -${line},3 +${line},3 @@`;
  return {
    id: "hunk",
    file,
    header,
    diff: [header, `-${lines[line - 1]}`, `+${replacement}`, ` ${lines[line]}`, ` ${lines[line + 1]}`].join("\n"),
    added: 1,
    removed: 1,
    oldStart: line,
    newStart: line,
  };
}

/** Definition source as the report reads it: the snapshot's own lines, whole. */
function sourcesOf(lines: readonly string[]): ContextSources {
  return {
    after: (loc) => lines.slice(loc.line - 1, loc.endLine ?? loc.line).join("\n"),
  };
}

describe("decorated TypeScript exports", () => {
  test.each(DECORATED_EXPORTS)("keeps the methods and this-calls of $name", ({ source }) => {
    const file = "svc.ts";
    const index = buildIndex(extractFunctions(file, source));
    // The class decorators are neither definitions nor call steps of their own.
    expect([...index.keys()]).toEqual(["Svc.find", "Svc.load"]);
    const find = index.get("Svc.find")!;
    const load = index.get("Svc.load")!;
    // Entry inference keys off this flag, so a decorated method stays selectable.
    expect([find.exported, load.exported]).toEqual([true, true]);
    // `this.load(id)` resolves to the sibling method, not to a bare name.
    expect(buildCallSitesFromInfo(find, index).map((node) => [node.key, node.definition])).toEqual([
      ["Svc.load", { file, line: load.line, endLine: load.endLine }],
    ]);
  });

  test("carries a decorated method's whole body and its resolved sibling calls into hunk context", () => {
    const file = "orders.ts";
    const index = buildIndex(extractFunctions(file, ORDERS_SOURCE.join("\n")));
    const find = index.get("OrdersService.find")!;
    const changed = find.line! + 1;
    const unit = changedHunk(file, ORDERS_SOURCE, changed, "    const order = await this.load(String(id));");
    const context = buildCallContext([unit], buildIndex([]), index, sourcesOf(ORDERS_SOURCE)).get(unit.id)!;

    // Changed lines select the decorated method, so it leads the nodes, then the
    // decorated siblings its own calls resolve to.
    expect(context.nodes.map((node) => node.key)).toEqual([
      "after:OrdersService.find",
      "after:OrdersService.load",
      "after:OrdersService.toDto",
      "after:OrdersService.decode",
    ]);
    const node = context.nodes[0];
    const body = ORDERS_SOURCE.slice(find.line! - 1, find.endLine!).join("\n");
    expect(node.detail).toContain(
      `source=${formatSourceLoc(find)} snapshot=after begin\n${body}\n  source-end`,
    );
    // Both sibling calls resolve to the method they call, with its own parameters.
    expect(node.detail).toContain("evidence=call-sites-in-this-definition count=2");
    expect(node.detail).toContain("call this.load @ orders.ts:7");
    expect(node.detail).toContain("definition=(id: string) @ orders.ts:10-12");
    expect(node.detail).toContain("call this.toDto @ orders.ts:8");
    expect(node.detail).toContain("definition=(order: Order, user: string) @ orders.ts:16-18");
    // The same resolved calls stand alone in the report blocks.
    expect(context.entries.slice(0, 2).map((block) => block.split("\n")[0])).toEqual([
      "call this.load @ orders.ts:7",
      "call this.toDto @ orders.ts:8",
    ]);
  });

  test.each(["events.ts", "events.tsx"])("keeps decorator-only changes attached to the method source in %s", (file) => {
    const lines = [
      "@Register()",
      "export class Events {",
      '  @On("updated")',
      "  @Trace()",
      "  consume(event) {",
      "    return this.persist(event);",
      "  }",
      "  persist(event) { return event; }",
      "}",
    ];
    const index = buildIndex(extractFunctions(file, lines.join("\n")));
    const unit: ReviewUnit = {
      id: "decorator", file, header: "@@ -3 +3 @@",
      diff: '@@ -3 +3 @@\n-  @On("created")\n+  @On("updated")',
      added: 1, removed: 1, oldStart: 3, newStart: 3,
    };
    const nodes = buildCallContext([unit], buildIndex([]), index, sourcesOf(lines)).get(unit.id)!.nodes;
    const method = nodes.find(node => node.key === "after:Events.consume")!;
    expect(method.line).toBe(3);
    expect(method.detail).toContain(lines.slice(2, 7).join("\n"));
    expect(buildCallSitesFromInfo(index.get("Events.consume")!, index).map(node => node.key)).toEqual(["Events.persist"]);
    expect(index.get("Events.persist")!.line).toBe(8);
  });

  test("keeps a body the initial state cannot hold collapsed, then expands it within the budgets", () => {
    const file = "ledger.ts";
    const operations = ["reverse", "adjust", "reconcile"];
    // The callee nodes carry the stage call sites too, so the body has to stay
    // small enough for both budgets to hold it once it is asked for.
    const lines = ledgerSource(18, operations);
    const index = buildIndex(extractFunctions(file, lines.join("\n")));
    const post = index.get("LedgerService.post")!;
    const changed = lines.indexOf("      const normalized = this.normalize(entry);") + 1;
    const unit = changedHunk(file, lines, changed, '      const normalized = this.normalize(entry, "fast");');
    const nodes = buildCallContext([unit], buildIndex([]), index, sourcesOf(lines)).get(unit.id)!.nodes;
    // The changed method leads, then the siblings whose calls reach it, then the
    // callees its own body calls.
    expect(nodes.map((node) => node.key)).toEqual([
      "after:LedgerService.post",
      ...operations.map((operation) => `after:LedgerService.${operation}`),
      "after:LedgerService.normalize",
      "after:LedgerService.stage",
    ]);

    const plan = new ContextPlan(buildJevState(unit), nodes);
    const descriptors = plan.state.contextNodes!;
    // Every real node stays addressable, and the first round stays within its target.
    expect(descriptors.map((node) => node.key)).toEqual(nodes.map((node) => node.key));
    expect(JSON.stringify(plan.state).length).toBeLessThanOrEqual(INITIAL_STATE_CHARS);
    // The changed method's body does not fit yet: its descriptor carries no body.
    expect(plan.collapsedKeys).toEqual(["after:LedgerService.post"]);
    expect(descriptors[0]).toMatchObject({
      key: "after:LedgerService.post",
      label: "LedgerService.post(entries)",
      file,
      line: post.line,
      collapsed: true,
    });
    expect(descriptors[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(plan.state)).not.toContain("staged.push(this.stage(normalized, 17))");
    // A caller whose body did fit is already whole in the state.
    const reverse = descriptors.find((node) => node.key === "after:LedgerService.reverse")!;
    expect(reverse.collapsed).toBe(false);
    expect(reverse.detail).toContain("    await this.post(adjusted);");
    // Only a listed key expands, and only while both budgets allow it.
    expect(plan.expand(["after:LedgerService.missing"])).toEqual([]);
    expect(plan.expand(plan.collapsedKeys)).toEqual(["after:LedgerService.post"]);
    const expanded = plan.state.contextNodes!.find((node) => node.key === "after:LedgerService.post")!;
    expect(expanded.collapsed).toBe(false);
    expect(expanded.detail).toContain(`source=${formatSourceLoc(post)} snapshot=after begin`);
    expect(expanded.detail).toContain("      staged.push(this.stage(normalized, 17));");
    expect(expanded.detail).toContain("    return this.repo.write(staged);");
    expect(plan.addedBytes).toBeLessThanOrEqual(MAX_ADDED_CONTEXT_BYTES);
    expect(JSON.stringify(plan.state).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
  });
});
