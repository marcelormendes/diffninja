import { describe, expect, test } from "vitest";
import { allFunctions, buildIndex, extractFunctions } from "../src/extract.js";
import { buildCallSitesFromInfo, exportsInFile } from "../src/calltree.js";
import { buildCallContext } from "../src/review/call-context.js";
import { parseDiff } from "../src/review/input.js";

function fixture(files: Record<string, string>, file: string, line: number) {
  const index = buildIndex(Object.entries(files).flatMap(([name, source]) => extractFunctions(name, source)));
  const [unit] = parseDiff(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${line} +${line} @@\n-old\n+new\n`);
  const context = buildCallContext([unit], buildIndex([]), index, {
    after: loc => files[loc.file]?.split("\n").slice(loc.line - 1, loc.endLine ?? loc.line).join("\n") ?? null,
  }).get(unit.id)!;
  return { index, unit, context };
}

describe("addressable non-call context", () => {
  test("follows a callee response contract without exposing types as callable entrypoints", () => {
    const { index, context } = fixture({
      "types.ts": "export interface BatchResponse {\n  successes: string[];\n  errors: string[];\n}",
      "api.ts": "import { BatchResponse } from './types';\nexport class Api {\n  create(): Promise<BatchResponse> { return send<BatchResponse>(); }\n}",
      "sync.ts": "export class Sync {\n  constructor(private api: Api) {}\n  sync() { return this.api.create(); }\n}",
    }, "sync.ts", 3);
    const contract = context.nodes.find(node => node.file === "types.ts")!;
    expect(contract.detail).toContain("errors: string[]");
    expect(context.entries.join("\n")).toContain("contract relation");
    expect(index.has("BatchResponse")).toBe(false);
    expect(allFunctions(index).some(fn => fn.review?.kind)).toBe(false);
    expect(exportsInFile("types.ts", index)).toEqual([]);
    const calls = buildCallSitesFromInfo(index.get("Api.create")!, index);
    expect(calls.some(call => call.definition?.file === "types.ts")).toBe(false);
  });

  test("keeps response contracts addressable despite a crowded caller graph", () => {
    const { context } = fixture({
      "types.ts": "export interface BatchResponse { errors: string[]; }",
      "api.ts": "import { BatchResponse } from './types';\nexport function create(): BatchResponse { return send(); }",
      "sync.ts": "export function sync() { return create(); }",
      "callers.ts": Array.from({ length: 12 }, (_, n) => `export function caller${n}() { return sync(); }`).join("\n"),
    }, "sync.ts", 1);
    // The contract and its producer rank among the first nodes despite twelve callers.
    const leading = context.nodes.slice(0, 8);
    expect(leading.some(node => node.file === "types.ts")).toBe(true);
    expect(leading.some(node => node.file === "api.ts")).toBe(true);
  });

  test("a changed interface selects its declaration and syntactic consumers", () => {
    const { context } = fixture({
      "types.ts": "export interface Result {\n  errors: string[];\n}",
      "client.ts": "import { Result } from './types';\nexport function consume(result: Result) { return result.errors; }",
    }, "types.ts", 2);
    expect(context.nodes.some(node => node.file === "client.ts" && node.detail.includes("result.errors"))).toBe(true);
    expect(context.nodes.some(node => node.file === "types.ts" && node.detail.includes("errors: string[]"))).toBe(true);
  });

  test("carries the event publisher definition whole from a changed listener", () => {
    const { context } = fixture({
      "publisher.ts": "export class Publisher {\n  update(value) { this.events.emit('lease.updated', value); }\n}",
      "listener.ts": "export class Listener {\n  @OnEvent('lease.updated')\n  update(value) { enqueue(value); }\n}",
    }, "listener.ts", 3);
    const publisher = context.nodes.find(node => node.file === "publisher.ts")!;
    expect(publisher.detail).toContain("this.events.emit('lease.updated', value)");
    expect(publisher.detail).toContain("event relation");
    expect(publisher.detail).toContain("snapshot=after target=candidate mapping=unknown");
    // The publisher's definition is carried whole rather than shortened.
    expect(publisher.detail).toContain("update(value) { this.events.emit('lease.updated', value); }");
  });
});
