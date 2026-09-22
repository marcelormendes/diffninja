import { describe, expect, test } from "vitest";
import { buildCallSitesFromInfo } from "../src/calltree.js";
import { buildIndex, extractFunctions } from "../src/extract.js";
import type { FunctionIndex } from "../src/extract.js";
import type { SourceLoc } from "../src/types.js";

/**
 * The dependency whose method the caller must resolve to across files. Its
 * method spans several lines, so a resolved definition has to carry its whole
 * body, not just its first line.
 */
const API_SOURCE = [
  "export class GetCoveredApiService {",
  "  createLeaseUsers(dto: LeaseDto) {",
  "    const users = dto.users;",
  "    return users;",
  "  }",
  "}",
];

/** The dependency reached through a plain (non-constructor) class field. */
const HTTP_SOURCE = [
  "export class HttpClient {",
  "  post(url: string) {",
  "    return fetch(url);",
  "  }",
  "}",
];

/**
 * One sync service whose constructor declares `getCoveredApiService`. Every
 * declaration also gives the class its own same-named `createLeaseUsers`, so a
 * call through the dependency must not resolve to that sibling instead.
 */
function syncSource(param: string): string {
  return [
    'import { Injectable, Inject } from "@nestjs/common";',
    'import { GetCoveredApiService } from "./api";',
    "",
    "@Injectable()",
    "export class GetCoveredTenantSyncService {",
    "  constructor(",
    param,
    "  ) {}",
    "",
    "  syncLeases() {",
    "    return this.getCoveredApiService.createLeaseUsers({});",
    "  }",
    "",
    "  createLeaseUsers(dto: LeaseDto) {",
    "    return dto;",
    "  }",
    "}",
  ].join("\n");
}

/** Parameter properties the extractor can type: visibility and/or `readonly`. */
const PARAMETER_PROPERTIES = [
  {
    name: "a decorated private parameter property",
    param: "    @Inject(GET_COVERED_API) private readonly getCoveredApiService: GetCoveredApiService,",
  },
  {
    name: "a public parameter property",
    param: "    public getCoveredApiService: GetCoveredApiService,",
  },
  {
    name: "a protected parameter property",
    param: "    protected getCoveredApiService: GetCoveredApiService,",
  },
  {
    name: "a bare readonly parameter property",
    param: "    readonly getCoveredApiService: GetCoveredApiService,",
  },
];

/** Field declarations that name no single class, so no receiver can be keyed. */
const UNTYPED_FIELDS = [
  { name: "an inferred field", field: "  getCoveredApiService = buildApi();" },
  {
    name: "a generic annotation",
    field: "  private readonly getCoveredApiService: GetCoveredApiService<LeaseDto>;",
  },
  {
    name: "a union annotation",
    field: "  private readonly getCoveredApiService: GetCoveredApiService | FallbackApi;",
  },
  {
    name: "a qualified annotation",
    field: "  private readonly getCoveredApiService: api.GetCoveredApiService;",
  },
];

function indexOf(files: readonly (readonly [string, string])[]): FunctionIndex {
  return buildIndex(
    files.flatMap(([file, source]) => extractFunctions(file, source)),
  );
}

/** Every call site written in `owner`'s body, reduced to what a consumer sees. */
function sitesOf(
  index: FunctionIndex,
  owner: string,
): { key: string; callee?: string; target?: string; definition?: SourceLoc }[] {
  const info = index.get(owner);
  if (!info) throw new Error(`nothing indexed as ${owner}`);
  return buildCallSitesFromInfo(info, index).map((node) => ({
    key: node.key,
    callee: node.context?.callee,
    target: node.context?.target,
    definition: node.definition,
  }));
}

describe("calls through typed TypeScript receivers", () => {
  test.each(PARAMETER_PROPERTIES)(
    "keys a call through $name to the dependency's class, not the caller's",
    ({ param }) => {
      const index = indexOf([
        ["api.ts", API_SOURCE.join("\n")],
        ["sync.ts", syncSource(param)],
      ]);
      const dependency = index.get("GetCoveredApiService.createLeaseUsers")!;

      const sites = sitesOf(index, "GetCoveredTenantSyncService.syncLeases");
      expect(sites).toEqual([
        {
          key: "GetCoveredApiService.createLeaseUsers",
          // The target expression as written is untouched, and association with
          // a definition stays a candidate heuristic because dispatch is dynamic.
          callee: "this.getCoveredApiService.createLeaseUsers",
          target: "candidate",
          definition: {
            file: "api.ts",
            line: dependency.line,
            endLine: dependency.endLine,
          },
        },
      ]);
      // The location is the dependency's whole definition, in the other file.
      expect(dependency.endLine!).toBeGreaterThan(dependency.line!);
      expect(
        API_SOURCE.slice(dependency.line! - 1, dependency.endLine).join("\n"),
      ).toContain("return users;");
      // The calling class declares a same-named sibling; it was not attached.
      const sibling = index.get("GetCoveredTenantSyncService.createLeaseUsers")!;
      expect([sibling.file, sibling.line]).not.toEqual([
        sites[0]!.definition!.file,
        sites[0]!.definition!.line,
      ]);
    },
  );

  test("keeps the dependency of a receiver read inside a nested closure", () => {
    const source = [
      "export class SyncService {",
      "  constructor(private readonly api: Api) {}",
      "",
      "  sync(ids: number[]) {",
      "    return ids.map((id) => this.api.createLeaseUsers(id));",
      "  }",
      "",
      "  createLeaseUsers(id: number) {",
      "    return id;",
      "  }",
      "}",
    ].join("\n");
    const index = indexOf([
      [
        "api.ts",
        ["export class Api {", "  createLeaseUsers(id: number) {", "    return id;", "  }", "}"].join("\n"),
      ],
      ["sync.ts", source],
    ]);
    const dependency = index.get("Api.createLeaseUsers")!;

    const sites = sitesOf(index, "SyncService.sync");
    expect(sites).toEqual([
      {
        key: "ids.map",
        callee: "ids.map",
        target: "unresolved",
        definition: undefined,
      },
      {
        key: "Api.createLeaseUsers",
        callee: "this.api.createLeaseUsers",
        target: "candidate",
        definition: {
          file: "api.ts",
          line: dependency.line,
          endLine: dependency.endLine,
        },
      },
    ]);
  });

  test("keys a call through a typed class field to that field's class", () => {
    const source = [
      "export class RouterService {",
      "  private readonly client: HttpClient;",
      "",
      "  send() {",
      '    return this.client.post("/");',
      "  }",
      "",
      '  post(url: string) {',
      "    return url;",
      "  }",
      "}",
    ].join("\n");
    const index = indexOf([
      ["http.ts", HTTP_SOURCE.join("\n")],
      ["router.ts", source],
    ]);
    const dependency = index.get("HttpClient.post")!;
    const sibling = index.get("RouterService.post")!;

    const sites = sitesOf(index, "RouterService.send");
    expect(sites).toEqual([
      {
        key: "HttpClient.post",
        callee: "this.client.post",
        target: "candidate",
        definition: {
          file: "http.ts",
          line: dependency.line,
          endLine: dependency.endLine,
        },
      },
    ]);
    // The calling class declares its own `post`; it was not attached.
    expect([sibling.file, sibling.line]).not.toEqual([
      sites[0]!.definition!.file,
      sites[0]!.definition!.line,
    ]);
  });

  test.each(UNTYPED_FIELDS)(
    "leaves a call through $name unkeyed instead of borrowing the caller's method",
    ({ field }) => {
      const source = [
        "export class UntypedOwner {",
        field,
        "",
        "  run() {",
        "    return this.getCoveredApiService.createLeaseUsers({});",
        "  }",
        "",
        "  createLeaseUsers(dto: LeaseDto) {",
        "    return dto;",
        "  }",
        "}",
      ].join("\n");
      const index = indexOf([["owner.ts", source]]);
      // The same-named sibling exists, so the receiver could borrow it wrongly.
      expect(index.has("UntypedOwner.createLeaseUsers")).toBe(true);

      const sites = sitesOf(index, "UntypedOwner.run");
      expect(sites).toEqual([
        {
          key: "this.getCoveredApiService.createLeaseUsers",
          callee: "this.getCoveredApiService.createLeaseUsers",
          target: "unresolved",
          definition: undefined,
        },
      ]);
    },
  );

  test("resolves a plain this-call to its sibling method with the whole body", () => {
    const source = [
      "export class OrdersService {",
      "  find(id: string) {",
      "    return this.load(id);",
      "  }",
      "",
      "  load(id: string) {",
      "    const key = `order:${id}`;",
      "    return key;",
      "  }",
      "}",
    ].join("\n");
    const index = indexOf([["orders.ts", source]]);
    const load = index.get("OrdersService.load")!;

    expect(sitesOf(index, "OrdersService.find")).toEqual([
      {
        key: "OrdersService.load",
        callee: "this.load",
        target: "candidate",
        definition: {
          file: "orders.ts",
          line: load.line,
          endLine: load.endLine,
        },
      },
    ]);
    expect(load.endLine!).toBeGreaterThan(load.line!);
  });

  test("does not key a static member's this-receiver to an instance field's class", () => {
    const source = [
      "export class Scheduler {",
      "  private readonly client: HttpClient;",
      "",
      "  static warmUp() {",
      '    return this.client.post("/warm");',
      "  }",
      "",
      '  static onReady = () => this.client.post("/ready");',
      "",
      "  post(url: string) {",
      "    return url;",
      "  }",
      "}",
    ].join("\n");
    const index = indexOf([
      ["http.ts", HTTP_SOURCE.join("\n")],
      ["scheduler.ts", source],
    ]);
    // Both the dependency's method and the caller's own same-named sibling are
    // indexed, so a wrong key would resolve to one of them.
    expect(index.has("HttpClient.post")).toBe(true);
    expect(index.has("Scheduler.post")).toBe(true);

    for (const owner of ["Scheduler.warmUp", "Scheduler.onReady"]) {
      expect(sitesOf(index, owner)).toEqual([
        {
          key: "this.client.post",
          callee: "this.client.post",
          target: "unresolved",
          definition: undefined,
        },
      ]);
    }
  });
});
