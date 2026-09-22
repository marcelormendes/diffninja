import { describe, expect, test } from "vitest";
import { buildCallSitesFromInfo } from "../src/calltree.js";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { formatSourceLoc } from "../src/loc.js";
import { buildCallContext } from "../src/review/call-context.js";
import type { ContextSources } from "../src/review/call-context.js";
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

});
