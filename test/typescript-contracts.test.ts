import { describe, expect, test } from "vitest";
import { buildCallSitesFromInfo } from "../src/calltree.js";
import { buildIndex, extractFunctions } from "../src/extract.js";
import { resolveTypeContracts } from "../src/languages/typescript-contracts.js";
import type { FunctionInfo } from "../src/types.js";

const TYPES_FILE = "apps/api/src/modules/get-covered/api/types.ts";
const API_FILE =
  "apps/api/src/modules/get-covered/api/services/get-covered-api.service.ts";

function contracts(functions: readonly FunctionInfo[]): FunctionInfo[] {
  return functions.filter((fn) => fn.review?.kind);
}

/** Compact `owner -> target@line` view of the resolved contract edges. */
function edges(functions: readonly FunctionInfo[]): string[] {
  return resolveTypeContracts(functions).map(
    (edge) => `${edge.owner.key} -> ${edge.target.key}@${edge.line}`,
  );
}

function declaration(functions: readonly FunctionInfo[], key: string): FunctionInfo {
  const found = contracts(functions).find((fn) => fn.key === key);
  if (!found) throw new Error(`Missing contract declaration ${key}`);
  return found;
}

describe("type contract declarations", () => {
  test("records the whole declaration span, including the last field", () => {
    const source = [
      "export interface GetCoveredLeaseUsersResponse {",
      "  lease_users: GetCoveredLeaseUserData[];",
      "  errors: unknown[];",
      "}",
    ].join("\n");
    const functions = extractFunctions(TYPES_FILE, source);
    const contract = declaration(functions, "GetCoveredLeaseUsersResponse");
    expect(contract).toMatchObject({
      review: { kind: "interface" },
      exported: true,
      steps: [],
      line: 1,
      endLine: 4,
    });
    // The span is the declaration itself, trailing `errors` and brace included.
    expect(source.slice(contract.start, contract.end)).toBe(source);
    expect(source.slice(contract.start, contract.end)).toContain("errors: unknown[];");
  });

  test("classifies interfaces, type aliases, and enums, exported or not", () => {
    const source = [
      "export interface Shape { errors: unknown[]; }",
      "interface Local { shape: Shape; }",
      "export type Alias = Local;",
      "export enum Mode { On = 'on' }",
    ].join("\n");
    const functions = extractFunctions("src/shapes.ts", source);
    expect(contracts(functions).map((fn) => [fn.key, fn.review?.kind, fn.exported, fn.steps.length])).toEqual([
      ["Shape", "interface", true, 0],
      ["Local", "interface", false, 0],
      ["Alias", "type", true, 0],
      ["Mode", "enum", true, 0],
    ]);
    const mode = declaration(functions, "Mode");
    expect(source.slice(mode.start, mode.end)).toBe("export enum Mode { On = 'on' }");
  });

  test("a declaration is never a callable target", () => {
    const source = [
      "export interface Widget { id: string; }",
      "export function build(): Widget { return Widget(); }",
    ].join("\n");
    const functions = extractFunctions("src/widget.ts", source);
    const index = buildIndex(functions);

    // The interface owns no body, so the index holds no callable of that name.
    expect(declaration(functions, "Widget").steps).toEqual([]);
    expect(index.has("Widget")).toBe(false);
    const builder = index.get("build");
    if (!builder) throw new Error("Missing build definition");
    const sites = buildCallSitesFromInfo(builder, index);
    expect(sites.map((site) => site.key)).toEqual(["Widget"]);
    expect(sites[0].definition).toBeUndefined();

    // The written type still reaches the declaration as a contract relation.
    expect(resolveTypeContracts(functions).map((edge) => [edge.kind, edge.target.key])).toEqual([
      ["contract", "Widget"],
    ]);
  });
});

describe("type references", () => {
  test("captures a method's return annotation and generic call argument", () => {
    const typesSource = [
      "export interface GetCoveredLeaseUsersResponse {",
      "  lease_users: string[];",
      "  errors: unknown[];",
      "}",
      "export interface GetCoveredErrorResponse { errors?: Record<string, string[]>; }",
    ].join("\n");
    const apiSource = [
      'import { GetCoveredLeaseUsersResponse, GetCoveredErrorResponse } from "~/modules/get-covered/api/types";',
      "export class GetCoveredApiService {",
      "  async createLeaseUsers(data: CreateLeaseUsersDto): Promise<GetCoveredLeaseUsersResponse> {",
      "    const response = await this.httpService.post<GetCoveredLeaseUsersResponse>('/leases/users', data);",
      "    return response.data;",
      "  }",
      "  handle(error: AxiosError<GetCoveredErrorResponse>): never {",
      "    throw error;",
      "  }",
      "}",
    ].join("\n");
    const functions = [
      ...extractFunctions(TYPES_FILE, typesSource),
      ...extractFunctions(API_FILE, apiSource),
    ];

    // Return annotation (line 3) and generic call argument (line 4) are two
    // references; the parameter type, `Promise`, and `AxiosError` do not bind.
    expect(edges(functions)).toEqual([
      "GetCoveredApiService.createLeaseUsers -> GetCoveredLeaseUsersResponse@3",
      "GetCoveredApiService.createLeaseUsers -> GetCoveredLeaseUsersResponse@4",
      "GetCoveredApiService.handle -> GetCoveredErrorResponse@7",
    ]);
  });

  test("binds interface extends, indexed, and method references transitively", () => {
    const source = [
      "interface Base { b: string; }",
      "interface Shape extends Base {",
      "  [k: string]: Base;",
      "  m(value: Base): Base;",
      "}",
    ].join("\n");
    const functions = extractFunctions("src/shape.ts", source);
    expect(declaration(functions, "Shape").review?.references).toEqual([
      { name: "Base" },
      { name: "Base" },
      { name: "Base" },
    ]);
    expect(edges(functions)).toEqual([
      "Shape -> Base@2",
      "Shape -> Base@3",
      "Shape -> Base@4",
    ]);
  });

  test("shadows generic parameters, infer variables, and mapped keys", () => {
    const source = [
      "export function identity<T>(value: T): T {",
      "  return value;",
      "}",
      "export type Keys<T> = T extends infer U ? U : { [K in keyof T]: T[K] };",
    ].join("\n");
    const functions = extractFunctions("src/generics.ts", source);
    const identity = functions.find((fn) => fn.key === "identity");
    expect(identity?.review?.references).toBeUndefined();
    expect(declaration(functions, "Keys").review?.references).toBeUndefined();
    expect(edges(functions)).toEqual([]);
  });
});

describe("reference resolution", () => {
  test("resolves an alias through its relative import", () => {
    const functions = [
      ...extractFunctions("src/lib.ts", "export interface Dup { a: number; }"),
      ...extractFunctions(
        "src/user.ts",
        ['import { Dup as Renamed } from "./lib";', "export interface Uses { d: Renamed; }"].join("\n"),
      ),
    ];
    const [edge] = resolveTypeContracts(functions);
    expect(`${edge.owner.key} -> ${edge.target.key}@${edge.line}`).toBe("Uses -> Dup@2");
    expect(edge.evidence).toContain('syntactic type reference Renamed (Dup as Renamed from "./lib")');
    expect(edge.evidence).toContain("not a call");
    expect(edge.evidence).toContain("relative import path");
  });

  test("does not bind an ambiguous name, and leaves external types unresolved", () => {
    const functions = [
      ...extractFunctions("src/a.ts", "export interface Dup { a: number }"),
      ...extractFunctions("src/b.ts", "export interface Dup { b: number }"),
      ...extractFunctions(
        "src/c.ts",
        [
          "export interface Ambiguous { d: Dup }",
          "export function missing(): External { return null as unknown as External; }",
        ].join("\n"),
      ),
    ];
    expect(edges(functions)).toEqual([]);
    expect(declaration(functions, "Ambiguous").review?.references).toEqual([{ name: "Dup" }]);
  });

  test("does not bind an aliased module path matched by two snapshot files", () => {
    const functions = [
      ...extractFunctions("src/a/common/types.ts", "export interface Same { a: number }"),
      ...extractFunctions("src/b/common/types.ts", "export interface Same { b: string }"),
      ...extractFunctions(
        "src/c.ts",
        ['import { Same } from "~/common/types";', "export interface Uses { s: Same }"].join("\n"),
      ),
    ];
    expect(edges(functions)).toEqual([]);
  });

  test("does not borrow a unique declaration for an unresolved import", () => {
    const functions = [
      ...extractFunctions("src/deep/thing.ts", "export interface Only { x: number }"),
      ...extractFunctions(
        "src/use.ts",
        ['import { Only } from "external-package";', "export interface Uses { o: Only }"].join("\n"),
      ),
      ...extractFunctions(
        "src/missing.ts",
        ['import { Only } from "./missing-module";', "export interface Missing { o: Only }"].join("\n"),
      ),
    ];
    expect(resolveTypeContracts(functions)).toEqual([]);
  });

});
