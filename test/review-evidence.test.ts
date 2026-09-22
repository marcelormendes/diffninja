import { describe, expect, test } from "vitest";
import { buildIndex, extractFunctions, type FunctionIndex } from "../src/extract.js";
import { buildCallContext, type ContextSourceReader, type ContextSources } from "../src/review/call-context.js";
import { buildReviewEvidence } from "../src/review/evidence.js";
import { moduleResolver } from "../src/review/module-resolution.js";
import type { AutomaticFinding, CheckCoverage, ReviewAgendaEntry } from "../src/review/evidence-types.js";
import { parseDiff } from "../src/review/input.js";
import type { ReviewUnit } from "../src/review/types.js";

/** Files kept as text, so a reader hands back exactly the snapshot's lines. */
type Files = Record<string, string>;

/** Fixture snapshot as a keyed object literal, without widening each binding. */
function snapshotOf(files: Record<string, string>): Files {
  return files;
}

/** Unified hunk whose header counts come from its own body. */
function hunk(file: string, start: number, body: string[]): string {
  const oldCount = body.filter(line => !line.startsWith("+")).length;
  const newCount = body.filter(line => !line.startsWith("-")).length;
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},${oldCount} +${start},${newCount} @@`,
    ...body,
  ].join("\n");
}

function addedHunks(files: Files): string {
  return Object.entries(files)
    .map(([file, source]) => hunk(file, 1, source.split("\n").map(line => `+${line}`)))
    .join("\n");
}

function readerOf(files: Files): ContextSourceReader {
  return loc =>
    files[loc.file]?.split("\n").slice(loc.line - 1, loc.endLine ?? loc.line).join("\n") ?? null;
}

function indexOf(files: Files): FunctionIndex {
  return buildIndex(
    Object.entries(files).flatMap(([name, source]) => extractFunctions(name, source)),
  );
}

interface Scenario {
  units: ReviewUnit[];
  after: FunctionIndex;
  before: FunctionIndex;
  sources: ContextSources;
}

/** Review input whose snapshots are `files`, unless a test passes prior text. */
function scenario(diff: string, files: Files, prior: Files = files): Scenario {
  return {
    units: parseDiff(diff),
    after: indexOf(files),
    before: indexOf(prior),
    sources: { after: readerOf(files), before: readerOf(prior) },
  };
}

function evidence(input: Scenario) {
  return buildReviewEvidence(input.units, {
    before: input.before,
    after: input.after,
    sources: input.sources,
    baseRef: "base0123",
    headRef: "head4567",
  });
}

function kindOf(findings: readonly AutomaticFinding[], kind: AutomaticFinding["kind"]): AutomaticFinding[] {
  return findings.filter(finding => finding.kind === kind);
}

function checkOf(checks: readonly CheckCoverage[], kind: CheckCoverage["kind"]): CheckCoverage {
  const check = checks.find(entry => entry.kind === kind);
  if (!check) throw new Error(`missing check ${kind}`);
  return check;
}

function entryOf(agenda: readonly ReviewAgendaEntry[], id: string): ReviewAgendaEntry {
  const entry = agenda.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`missing agenda entry ${id}; have ${agenda.map(item => item.id).join(", ")}`);
  return entry;
}

const RESPONSE_TYPES = [
  "export interface CreateResult {",
  "  success: boolean;",
  "  errors: string[];",
  "  users: string[];",
  "  count: number;",
  "}",
].join("\n");

/** A producer whose declared response shape carries failures and successes. */
const PRODUCER = [
  "import { CreateResult } from './types';",
  "export async function createResidents(names: string[]): Promise<CreateResult> {",
  "  const users: string[] = [];",
  "  const errors: string[] = [];",
  "  await store.insert('residents', { names });",
  "  return { success: errors.length === 0, errors, users, count: users.length };",
  "}",
].join("\n");

/** One changed receiver file whose body is the lines the test supplies. */
function receiverScenario(body: string[]): Scenario {
  const files = snapshotOf({
    "src/types.ts": RESPONSE_TYPES,
    "src/service.ts": PRODUCER,
    "src/handler.ts": [
      "import { createResidents } from './service';",
      "export async function handle(body: Body) {",
      ...body,
      "}",
    ].join("\n"),
  });
  return scenario(
    hunk("src/handler.ts", 2, [
      " export async function handle(body: Body) {",
      "-  const result = await createResidents(body.names);",
      ...body.map(line => `+  ${line}`),
      " }",
    ]),
    files,
  );
}

describe("unused failure results", () => {
  test.each([
    ["shorthand escape", "const result = await createResidents(body.names);", "return { result };"],
    ["defaulted failure field", "const { errors = [], users } = await createResidents(body.names);", "return { errors, users };"],
    ["quoted failure field", "const { 'errors': failures, users } = await createResidents(body.names);", "return { failures, users };"],
    ["computed field", "const { [body.key]: value, users } = await createResidents(body.names);", "return { value, users };"],
    ["pending producer", "const pending = createResidents(body.names);", "return { started: true };"],
  ])("does not allege an unread response for %s", (_name, binding, use) => {
    const result = evidence(receiverScenario([binding, use]));
    expect(kindOf(result.findings, "unused-error-result")).toEqual([]);
  });

  test("does not borrow a unique local producer's contract for an external import", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": "import { CreateResult } from './types';\nexport function resolve(): CreateResult { return send(); }\n",
      "src/handler.ts": "import { resolve } from 'node:path';\nexport function handle() { const result = resolve('/tmp'); return result.length; }\n",
    });
    const result = evidence(scenario(addedHunks({ "src/handler.ts": files["src/handler.ts"] }), files));
    expect(kindOf(result.findings, "unused-error-result")).toEqual([]);
  });
  test("follows a typed receiver through an immutable path alias, not a same-named foreign module", () => {
    const files = snapshotOf({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": "import { CreateResult } from './types';\nexport class Api { async createResidents(): Promise<CreateResult> { return send(); } }\n",
      "src/handler.ts": [
        "import { Api } from '@app/service';",
        "export class Handler {",
        "  constructor(private readonly api: Api) {}",
        "  async handle() {",
        "    const result = await this.api.createResidents();",
        "    return result.users.length;",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(addedHunks({ "src/handler.ts": files["src/handler.ts"] }), files);
    const resolveImport = moduleResolver(file => files[file] ?? null);
    const result = buildReviewEvidence(input.units, { ...input, resolveImport });
    expect(kindOf(result.findings, "unused-error-result")).toHaveLength(1);
    const wrongConfig = moduleResolver(file => file === "tsconfig.json"
      ? JSON.stringify({ compilerOptions: { paths: { "@app/*": ["foreign/*"] } } }) : files[file] ?? null);
    expect(kindOf(buildReviewEvidence(input.units, { ...input, resolveImport: wrongConfig }).findings, "unused-error-result")).toEqual([]);
  });

  test("never resolves a builtin or escaping path as an alias to local source", () => {
    const resolveImport = moduleResolver(file => file === "tsconfig.json"
      ? JSON.stringify({ compilerOptions: { paths: { "node:*": ["src/*"], "@outside/*": ["../../*"] } } })
      : file === "src/path.ts" ? "export function resolve() {}" : null);
    expect(resolveImport("src/main.ts", "node:path")).toBeUndefined();
    expect(resolveImport("src/main.ts", "@outside/path")).toBeUndefined();
  });

  test("reports a response whose failure field a changed receiver never reads", () => {
    const result = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "return { ok: true, count: result.users.length, users: result.users };",
    ]));
    const findings = kindOf(result.findings, "unused-error-result");
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.title).toContain("Unread errors field");
    expect(finding.title).toContain("handle(body)");
    expect(finding.scope).toContain("holds it as `result` (resolved call to createResidents at line 3)");
    expect(finding.scope).toContain("errors: string[]");
    // The receiver's own code and its reported results lead, then the contract:
    // a long run of contract excerpts can never crowd these out.
    expect(finding.evidence.map(item => item.role)).toEqual(["change", "related", "contract", "related"]);
    expect(finding.evidence[0].text).toContain("createResidents(body.names)");
    expect(finding.evidence[1].label).toContain("read result field users");
    expect(finding.evidence[2].text).toContain("errors: string[]");
    expect(finding.evidence[2].ref).toBe("head4567");
    expect(finding.evidence[3].label).toContain("returned count at line");
    expect(finding.evidence[3].text).toContain("count: result.users.length");
    expect(finding.limitation).toContain("does not establish");
    expect(finding.unitIds).toHaveLength(1);
  });

  test("reports a receiver that destructures the reported fields and drops the failure field", () => {
    const result = evidence(receiverScenario([
      "const { users } = await createResidents(body.names);",
      "return { ok: true, count: users.length };",
    ]));
    const findings = kindOf(result.findings, "unused-error-result");
    expect(findings).toHaveLength(1);
    expect(findings[0].scope).toContain("fields { users }");
    // The destructured field's own count usage, not the pattern line.
    const count = findings[0].evidence.find(item => item.label.includes("count at line 4"));
    expect(count?.text).toContain("return { ok: true, count: users.length };");
  });

  test("reports a changed function typed by the response that never reads its failure field", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/report.ts": [
        "import { CreateResult } from './types';",
        "export function report(result: CreateResult) {",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/report.ts", 2, [
        " export function report(result: CreateResult) {",
        "-  return { ok: true };",
        "+  return { ok: true, count: result.users.length };",
        " }",
      ]),
      files,
    );
    const findings = kindOf(evidence(input).findings, "unused-error-result");
    expect(findings).toHaveLength(1);
    expect(findings[0].scope).toContain("declared as CreateResult");
  });

  test("treats a receiver that reads the failure field as no finding", () => {
    const result = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "if (result.errors.length > 0) throw new Error(result.errors.join(', '));",
      "return { ok: true, count: result.users.length };",
    ]));
    expect(kindOf(result.findings, "unused-error-result")).toHaveLength(0);
    expect(checkOf(result.checks, "unused-error-result").detail).toContain("0 receivers were found");
  });

  test("never alleges an unused field when the response is returned, passed, aliased, or rested", () => {
    const forwarded = evidence(receiverScenario(["return createResidents(body.names);"]));
    expect(kindOf(forwarded.findings, "unused-error-result")).toHaveLength(0);
    expect(checkOf(forwarded.checks, "unused-error-result").detail).toContain("hand the whole response on");

    const passed = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "logResponse(result);",
      "return { ok: true };",
    ]));
    expect(kindOf(passed.findings, "unused-error-result")).toHaveLength(0);

    const aliased = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "const alias = result;",
      "return { ok: true, count: alias.users.length };",
    ]));
    expect(kindOf(aliased.findings, "unused-error-result")).toHaveLength(0);

    const rested = evidence(receiverScenario([
      "const { users, ...rest } = await createResidents(body.names);",
      "return { ok: true, count: users.length, rest };",
    ]));
    expect(kindOf(rested.findings, "unused-error-result")).toHaveLength(0);

    const positional = evidence(receiverScenario([
      "const [first] = await createResidents(body.names);",
      "return { ok: true, first };",
    ]));
    expect(kindOf(positional.findings, "unused-error-result")).toHaveLength(0);
  });

  test("follows a response held inside a class method body", () => {
    // A member definition is not a module on its own, so its fragment parse goes
    // through a container wrapper; the response must still be followed there.
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/sync.ts": [
        "import { createResidents } from './service';",
        "export class SyncService {",
        "  constructor(private readonly service: Store) {}",
        "  async sync(names: string[]) {",
        "    const result = await createResidents(names);",
        "    this.logger.log({ message: 'synced', count: result.users.length });",
        "    return { ok: true, users: result.users };",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/sync.ts", 5, [
        "-    const result = await createResidents([]);",
        "+    const result = await createResidents(names);",
      ]),
      files,
    );
    const findings = kindOf(evidence(input).findings, "unused-error-result");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("SyncService.sync");
    // This body returns no count, so the count it logs is the reported one.
    const count = findings[0].evidence.find(item => item.label.includes("count at line 6"));
    expect(count?.text).toContain("count: result.users.length");
  });

  test("finds the same receiver every time inside a long class method", () => {
    // A member body is parsed through a container wrapper, and the structural
    // questions compare syntax nodes. Repeating the identical input is what
    // catches a comparison that depends on handle identity instead of node id:
    // with handle identity this receiver is lost in some runs and not others.
    const filler = [0, 1, 2, 3].flatMap(nth => [
      `    const rows${nth} = response.lease_users.filter((row) => row.external_id !== '${nth}').map((row) => ({ id: row.id, name: row.user.name }));`,
      `    await this.repository${nth}.bulkCreate(rows${nth}, { transaction, ignoreDuplicates: true });`,
    ]);
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/sync.ts": [
        "import { createResidents } from './service';",
        "export class SyncService {",
        "  async sync(names: string[]) {",
        "    const response = await createResidents(names);",
        ...filler,
        "    this.logger.log({ message: 'synced', count: response.users.length });",
        "    return { ok: true, users: response.users };",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/sync.ts", 4, [
        "-    const response = await createResidents([]);",
        "+    const response = await createResidents(names);",
      ]),
      files,
    );
    const outcomes = Array.from({ length: 150 }, () =>
      kindOf(evidence(input).findings, "unused-error-result").map(finding => finding.id).join("|"),
    );
    expect(new Set(outcomes)).toEqual(
      new Set(["unused-error-result:src/sync.ts:3:CreateResult.errors"]),
    );
    expect(outcomes[0]).not.toBe("");
  });

  test("still inspects a receiver a deletion-only hunk touched", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/handler.ts": [
        "import { createResidents } from './service';",
        "export async function handle(body: Body) {",
        "  const result = await createResidents(body.names);",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    const prior = snapshotOf({
      ...files,
      "src/handler.ts": [
        "import { createResidents } from './service';",
        "export async function handle(body: Body) {",
        "  const result = await createResidents(body.names);",
        "  if (result.errors.length > 0) throw new Error('failed');",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    // The hunk only deletes the failure check, so it has no added line at all.
    const input = scenario(
      hunk("src/handler.ts", 2, [
        " export async function handle(body: Body) {",
        "   const result = await createResidents(body.names);",
        "-  if (result.errors.length > 0) throw new Error('failed');",
        "   return { ok: true, count: result.users.length };",
        " }",
      ]),
      files,
      prior,
    );
    const result = evidence(input);
    expect(kindOf(result.findings, "unused-error-result")).toHaveLength(1);
    expect(checkOf(result.checks, "unused-error-result").detail).toContain("examined as receivers");
    expect(entryOf(result.agenda, "agenda:partial-failure").unitIds).toHaveLength(1);
  });

  test("does not read a pending promise as a response", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/pending.ts": [
        "import { CreateResult } from './types';",
        "export function report(pending: Promise<CreateResult>) {",
        "  return { ok: true, count: 1 };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/pending.ts", 2, [
        "-export function report(pending: Pending) {",
        "+export function report(pending: Promise<CreateResult>) {",
      ]),
      files,
    );
    // A parameter declared as a Promise holds the pending value, not the result.
    expect(kindOf(evidence(input).findings, "unused-error-result")).toHaveLength(0);
  });

  test("does not follow a same-named local instead of the producer", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/shadow.ts": [
        "import { CreateResult } from './types';",
        "export function handle(makeResult: (names: string[]) => Promise<CreateResult>) {",
        "  const createResidents = makeResult;",
        "  return { ok: true, count: createResidents([]).length };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/shadow.ts", 2, [
        "-export function handle(makeResult: ResultFactory) {",
        "+export function handle(makeResult: (names: string[]) => Promise<CreateResult>) {",
        "   const createResidents = makeResult;",
        "   return { ok: true, count: createResidents([]).length };",
      ]),
      files,
    );
    // The local `createResidents` shadows the producer's bare key, so the call
    // is not evidence that this receiver holds the producer's response.
    expect(kindOf(evidence(input).findings, "unused-error-result")).toHaveLength(0);
  });

  test("skips a heuristic candidate call rather than attaching a contract", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/callback.ts": [
        "import { CreateResult } from './types';",
        "export function run(factory: ResultFactory) {",
        "  const result = factory.createResidents([]);",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/callback.ts", 3, [
        "-  const result = factory.createResidents([]);",
        "+  const result = factory.createResidents([]);",
      ]),
      files,
    );
    const findings = kindOf(evidence(input).findings, "unused-error-result");
    // Whatever the extractor resolved, the receiver's own body never names the
    // producer's contract by resolution here, so no finding is asserted.
    expect(findings.every(finding => finding.scope.includes("createResidents") === false)).toBe(true);
  });

  test("never reads another declaration's fields as this contract's", () => {
    // Two declarations on one line: the fragment read for the second one must
    // not reuse the first one's parsed fields.
    const files = snapshotOf({
      "src/types.ts": [
        "export interface BatchResult { errors: string[]; users: string[] }",
        "export interface Tally { count: number }",
      ].join("\n"),
      "src/service.ts": [
        "import { BatchResult } from './types';",
        "export async function load(): Promise<BatchResult> {",
        "  return send();",
        "}",
      ].join("\n"),
      "src/use.ts": [
        "import { Tally } from './types';",
        "export function report(tally: Tally) {",
        "  return { ok: true, count: tally.count };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/use.ts", 2, [
        "-export function report(tally: Tally) {",
        "+export function report(tally: Tally) {",
        "   return { ok: true, count: tally.count };",
      ]),
      files,
    );
    // `Tally` declares no failure field, so it is not a response contract; the
    // adjacent `BatchResult` must not lend it its `errors` field.
    expect(kindOf(evidence(input).findings, "unused-error-result")).toHaveLength(0);
  });

  test("does not claim a response is read when a method is invoked on it", () => {
    const result = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "return result.users.map(entry => entry.name).length > 0;",
    ]));
    // `.length` on an array of names is not a count of the response's items; the
    // only reads here are `users` and the array's own length.
    expect(kindOf(result.findings, "unused-error-result")).toHaveLength(1);
    const viaMethod = evidence(receiverScenario([
      "const response = await createResidents(body.names);",
      "return response.ensureReported();",
    ]));
    // The whole response is handed to a method, so nothing is claimed.
    expect(kindOf(viaMethod.findings, "unused-error-result")).toHaveLength(0);
    expect(checkOf(viaMethod.checks, "unused-error-result").detail).toContain("cannot follow");
  });

  test("says what it could not read instead of passing", () => {
    const input = receiverScenario([
      "const result = await createResidents(body.names);",
      "return { ok: true, count: result.users.length };",
    ]);
    const blind = buildReviewEvidence(input.units, {
      before: input.before,
      after: input.after,
      sources: { after: readerOf({}), before: readerOf({}) },
    });
    expect(checkOf(blind.checks, "unused-error-result").status).toBe("partial");
    expect(checkOf(blind.checks, "duplicate-body").status).toBe("partial");
    expect(blind.findings).toEqual([]);
    expect(entryOf(blind.agenda, "agenda:check-scope").reason).toContain("unused-error-result: partial");
  });
});

describe("duplicated bodies", () => {
  const files = snapshotOf({
    "src/first.ts": [
      "export function firstNames(names: string[]): string[] {",
      "  const kept: string[] = [];",
      "  for (const name of names) {",
      "    if (name.length === 0) continue;",
      "    kept.push(name.trim().toLowerCase());",
      "  }",
      "  return kept;",
      "}",
    ].join("\n"),
    "src/second.ts": [
      "// A second copy, with its own comment and spacing.",
      "export function secondNames(names: string[]): string[] {",
      "  const kept: string[] = [];",
      "",
      "  for (const name of names) {",
      "    /* skip the empties */ if (name.length === 0) continue;",
      "    kept.push(name.trim().toLowerCase());",
      "  }",
      "",
      "  return kept;",
      "}",
    ].join("\n"),
  });

  test("matches bodies across two changed files through comments and formatting", () => {
    const result = evidence(scenario(addedHunks(files), files));
    const findings = kindOf(result.findings, "duplicate-body");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("firstNames");
    expect(findings[0].title).toContain("secondNames");
    expect(findings[0].evidence.map(item => item.file)).toEqual(["src/first.ts", "src/second.ts"]);
    expect(findings[0].limitation).toContain("do not establish equivalent behavior");
    expect(findings[0].unitIds).toHaveLength(2);
  });

  test("keeps literals and operators distinct", () => {
    const differing = snapshotOf({
      "src/first.ts": [
        "export function firstNames(names: string[]) {",
        "  return names.filter(name => name.length === 0).map(name => name.trim() + '!');",
        "}",
      ].join("\n"),
      "src/second.ts": [
        "export function secondNames(names: string[]) {",
        "  return names.filter(name => name.length === 1).map(name => name.trim() + '?');",
        "}",
      ].join("\n"),
    });
    expect(kindOf(evidence(scenario(addedHunks(differing), differing)).findings, "duplicate-body")).toHaveLength(0);
  });

  test("states the comparison bounds of its own result", () => {
    const input = scenario(addedHunks(files), files);
    const detail = checkOf(evidence(input).checks, "duplicate-body").detail;
    expect(detail).toContain("Comments and formatting are ignored; literals and operators are compared as written.");
    expect(detail).toContain("definitions were skipped");
    expect(detail).toContain("bodies of callable definitions in the changed files");
  });
});

describe("reading agenda", () => {
  const files = snapshotOf({
    "src/types.ts": RESPONSE_TYPES,
    "src/service.ts": [
      "import { CreateResult, Status } from './types';",
      "export async function createResidents(names: string[]): Promise<CreateResult> {",
      "  const users: string[] = [];",
      "  const errors: string[] = [];",
      "  await store.insert('residents', { status: Status.Active, names });",
      "  return { success: errors.length === 0, errors, users, count: users.length };",
      "}",
    ].join("\n"),
    "src/handler.ts": [
      "import { createResidents } from './service';",
      "export async function handle(body: Body) {",
      "  const result = await createResidents(body.names);",
      "  return { ok: true, count: result.users.length };",
      "}",
      "export function route(request: Request) {",
      "  return handle(request.body);",
      "}",
    ].join("\n"),
  });

  const diff = [
    hunk("src/service.ts", 3, [
      "   const errors: string[] = [];",
      "-  await store.save('residents', { names });",
      "+  await store.insert('residents', { status: Status.Active, names });",
      "   return { success: errors.length === 0, errors, users, count: users.length };",
    ]),
    hunk("src/handler.ts", 2, [
      " export async function handle(body: Body) {",
      "-  const result = await createResidents([]);",
      "+  const result = await createResidents(body.names);",
      "   return { ok: true, count: result.users.length };",
    ]),
    "diff --git a/assets/logo.png b/assets/logo.png",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
  ].join("\n");

  test("asks the partial-failure and lifecycle questions first, in question form", () => {
    const result = evidence(scenario(diff, files));
    const [first, second] = result.agenda;
    expect(first.id).toBe("agenda:partial-failure");
    expect(first.title).toMatch(/^Partial failure: .*\?$/);
    expect(first.reason).toContain("CreateResult");
    expect(first.reason).toContain("errors");
    expect(first.findingIds).toEqual(["unused-error-result:src/handler.ts:2:CreateResult.errors"]);
    expect(second.id).toBe("agenda:external-write");
    expect(second.title).toMatch(/\?$/);
    expect(second.reason).toContain("Status.Active");
    expect(second.evidence.length).toBeGreaterThan(0);
    // Fixed questions, not verdicts: no bug vocabulary anywhere in the pair.
    expect(`${first.title} ${first.reason} ${second.title} ${second.reason}`).not.toMatch(/bug|defect|broken/i);
  });

  test("carries the response contract, the receiver, its provider, and the caller chain", () => {
    const input = scenario(diff, files);
    const context = buildCallContext(input.units, input.before, input.after, input.sources);
    for (const unit of input.units) unit.contextNodes = context.get(unit.id)?.nodes;
    const result = evidence(input);
    const failure = entryOf(result.agenda, "agenda:partial-failure");
    // The caller the hunk cannot show comes from the context nodes, change first.
    expect(failure.context.map(node => node.key)).toContain("after:route");
    expect(failure.context[0].key).toBe("after:handle");
    expect(failure.context.length).toBeLessThanOrEqual(3);
    // One slot per role first: the change, its caller, the reported results, and
    // the declared contract all survive a five-slot entry.
    expect(failure.evidence.map(item => item.role)).toEqual([
      "change",
      "caller",
      "related",
      "contract",
      "change",
    ]);
    expect(failure.evidence[0].text).toContain("createResidents(body.names)");
    expect(failure.evidence[2].text).toContain("count: result.users.length");
    expect(failure.evidence[3].text).toContain("errors: string[]");
    expect(failure.evidence[4].text).toContain("errors.length === 0");
    expect(failure.evidence.every(item => item.text.length <= 2_000)).toBe(true);
    expect(failure.evidence.map(item => item.id).length).toBe(new Set(failure.evidence.map(item => item.id)).size);
  });

  test("gives the lifecycle entry the constants, the caller, and its dispatch chain", () => {
    const withEnum = snapshotOf({
      ...files,
      "src/types.ts": [
        RESPONSE_TYPES,
        "export enum ResidentState { Active = 'active', Suspended = 'suspended' }",
      ].join("\n"),
      "src/service.ts": [
        "import { CreateResult, ResidentState } from './types';",
        "export async function createResidents(names: string[]): Promise<CreateResult> {",
        "  const users: string[] = [];",
        "  const errors: string[] = [];",
        "  await store.insert('residents', { state: ResidentState.Active, names });",
        "  return { success: errors.length === 0, errors, users, count: users.length };",
        "}",
        "export function enqueueResidents(names: string[]) {",
        "  return queue.publish('residents.created', names);",
        "}",
      ].join("\n"),
      "src/listener.ts": [
        "export class Listener {",
        "  @OnEvent('residents.created')",
        "  update(value: string[]) {",
        "    return value.length;",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/service.ts", 5, [
        "-  await store.insert('residents', { names });",
        "+  await store.insert('residents', { state: ResidentState.Active, names });",
      ]),
      withEnum,
    );
    const context = buildCallContext(input.units, input.before, input.after, input.sources);
    for (const unit of input.units) unit.contextNodes = context.get(unit.id)?.nodes;
    const entry = entryOf(evidence(input).agenda, "agenda:external-write");
    expect(entry.reason).toContain("ResidentState.Active");
    expect(entry.evidence.some(item => item.text.includes("ResidentState.Active"))).toBe(true);
    const roles = entry.evidence.map(item => item.role);
    expect(roles).toContain("change");
    expect(roles).toContain("caller");
  });

  test("keeps every hunk addressable, metadata-only ones included", () => {
    const input = scenario(diff, files);
    const result = evidence(input);
    const covered = new Set(result.agenda.flatMap(entry => entry.unitIds));
    expect([...covered].sort()).toEqual(input.units.map(unit => unit.id).sort());
    const metadata = entryOf(result.agenda, "agenda:hunks:assets/logo.png");
    expect(metadata.reason).toContain("metadata-only");
    expect(metadata.evidence[0].text).toContain("Binary files");
    // A bounded excerpt never loses a hunk: every unit an entry covers is named
    // by its own header and counts, not only the one shown as an excerpt.
    for (const entry of result.agenda.filter(candidate => candidate.id.startsWith("agenda:hunks:"))) {
      for (const unitId of entry.unitIds) {
        const unit = input.units.find(candidate => candidate.id === unitId)!;
        expect(entry.reason).toContain(unit.special ? "metadata-only" : unit.header.split(" @@")[0]);
      }
      expect(entry.evidence.length).toBeLessThanOrEqual(1);
    }
  });

  test("reports declared-contract changes with the changed definitions that name them", () => {
    const prior = snapshotOf({
      ...files,
      "src/types.ts": [
        "export interface CreateResult {",
        "  success: boolean;",
        "  errors: string[];",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      [
        hunk("src/types.ts", 1, [
          " export interface CreateResult {",
          "   success: boolean;",
          "   errors: string[];",
          "+  users: string[];",
          "+  count: number;",
          " }",
        ]),
        hunk("src/service.ts", 3, [
          "   const errors: string[] = [];",
          "-  await store.save('residents', { names });",
          "+  await store.insert('residents', { names });",
          "   return { success: errors.length === 0, errors, users, count: users.length };",
        ]),
      ].join("\n"),
      files,
      prior,
    );
    const entry = entryOf(evidence(input).agenda, "agenda:contract-change");
    expect(entry.reason).toContain("added users, count");
    // A syntactic type reference, never claimed as a runtime write.
    expect(entry.reason).toContain("name CreateResult (syntactic type reference, not a runtime write)");
    expect(entry.evidence.map(item => item.role)).toContain("caller");
  });

  test("does not ask the lifecycle question when no state value is written", () => {
    const quiet = snapshotOf({ ...files, "src/service.ts": PRODUCER });
    const input = scenario(
      hunk("src/service.ts", 5, [
        "-  await store.insert('residents', { names });",
        "+  await store.insert('residents', { names: names.slice(0, 10) });",
      ]),
      quiet,
    );
    expect(evidence(input).agenda.some(entry => entry.id === "agenda:external-write")).toBe(false);
  });

  test("orders the same way twice and independently of the order units arrive in", () => {
    const input = scenario(diff, files);
    const once = evidence(input);
    const twice = evidence(input);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const reversed = buildReviewEvidence([...input.units].reverse(), {
      before: input.before,
      after: input.after,
      sources: input.sources,
      baseRef: "base0123",
      headRef: "head4567",
    });
    expect(reversed.agenda.map(entry => `${entry.priority} ${entry.id}`)).toEqual(
      once.agenda.map(entry => `${entry.priority} ${entry.id}`),
    );
    expect(reversed.findings.map(finding => finding.id)).toEqual(once.findings.map(finding => finding.id));
  });
});

describe("response typing and body selection", () => {
  test("never treats a collection or wrapper of the response as one response", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/batch.ts": [
        "import { CreateResult } from './types';",
        "export function asList(): CreateResult[] {",
        "  return [];",
        "}",
        "export function wrapped(): Wrapper<CreateResult> {",
        "  return box();",
        "}",
        "export async function one(): Promise<CreateResult> {",
        "  return send();",
        "}",
      ].join("\n"),
      "src/use.ts": [
        "import { CreateResult } from './types';",
        "export function takeList(results: CreateResult[]) {",
        "  return { ok: true, count: results.length };",
        "}",
        "export function takeOne(result: CreateResult) {",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/use.ts", 2, [
        "-export function takeList(results: CreateResult[]) {",
        "+export function takeList(results: CreateResult[]) {",
        "   return { ok: true, count: results.length };",
      ]) + "\n" + hunk("src/use.ts", 6, [
        "-export function takeOne(result: CreateResult) {",
        "+export function takeOne(result: CreateResult) {",
        "   return { ok: true, count: result.users.length };",
      ]),
      files,
    );
    const findings = kindOf(evidence(input).findings, "unused-error-result");
    // Only the plain single response is a receiver; the array is a collection.
    expect(findings.map(finding => finding.scope)).toHaveLength(1);
    expect(findings[0].scope).toContain("declared as CreateResult");
    expect(findings[0].title).toContain("takeOne");
  });

  test("uses the definition's own body, not a large nested callback default", () => {
    const long = Array.from({ length: 40 }, (_, n) => `    handle${n}(value);`).join("\n");
    const outer = [
      "  const kept = options.filter(entry => entry.enabled).map(entry => entry.name);",
      "  return kept.length === 0 ? [] : kept.slice(0, 10);",
    ];
    const files = snapshotOf({
      "src/first.ts": ["export function configure(options = () => {", long, "}) {", ...outer, "}"].join("\n"),
      "src/second.ts": ["export function configure(options = () => {", long, "}) {", ...outer, "}"].join("\n"),
    });
    // The two outer bodies are token-identical, but the nested default callback
    // is longer; the comparison must use the outer body either way.
    const result = evidence(scenario(addedHunks(files), files));
    const findings = kindOf(result.findings, "duplicate-body");
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence[0].text).toContain("export function configure(");
    // The compared body is the outer one: the nested default callback alone
    // would have matched too, but the token stream shown is the outer body's.
    expect(findings[0].evidence[0].text).toContain("kept.length === 0");
  });
});

describe("agenda evidence selection", () => {
  test("shows a direct caller and its returned count even when both methods share a changed hunk", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/worker.ts": [
        "import { createResidents } from './service';",
        "export class Worker {",
        "  async write(names: string[]): Promise<void> {",
        "    const result = await createResidents(names);",
        "    await store.save(result.users);",
        "  }",
        "  async run(names: string[]): Promise<number> {",
        "    await this.write(names);",
        "    return names.length;",
        "  }",
        "}",
      ].join("\n"),
    });
    const prior = snapshotOf({ ...files, "src/worker.ts": files["src/worker.ts"].replace("return names.length;", "return 99;") });
    const input = scenario(addedHunks({ "src/worker.ts": files["src/worker.ts"] }), files, prior);
    const contexts = buildCallContext(input.units, input.before, input.after, input.sources);
    for (const unit of input.units) unit.contextNodes = contexts.get(unit.id)?.nodes;
    const entry = entryOf(evidence(input).agenda, "agenda:partial-failure");
    const caller = entry.evidence.find(item => item.role === "caller");
    expect(caller?.text).toContain("await this.write(names);");
    expect(caller?.text).toContain("return names.length;");
    expect(caller?.text).not.toContain("return 99;");
    expect(caller?.ref).toBe("head4567");
  });

  test("prefers the count the receiver returns over a later diagnostic log", () => {
    const files = snapshotOf({
      "src/types.ts": RESPONSE_TYPES,
      "src/service.ts": PRODUCER,
      "src/sync.ts": [
        "import { createResidents } from './service';",
        "export async function sync(names: string[]) {",
        "  const result = await createResidents(names);",
        "  logger.log({ message: 'synced', total: result.users.length });",
        "  return { ok: true, count: result.users.length };",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/sync.ts", 3, [
        "-  const result = await createResidents([]);",
        "+  const result = await createResidents(names);",
      ]),
      files,
    );
    const result = evidence(input);
    const entry = entryOf(result.agenda, "agenda:partial-failure");
    const counts = entry.evidence.filter(item => item.label.includes("count"));
    expect(counts).toHaveLength(1);
    expect(counts[0].text).toContain("return { ok: true, count: result.users.length };");
    // No second card for a finding this entry already links.
    expect(result.agenda.some(candidate => candidate.id.startsWith("agenda:finding:unused-error-result"))).toBe(false);
    expect(entry.findingIds).toEqual(["unused-error-result:src/sync.ts:2:CreateResult.errors"]);
  });

  test("recognizes a write call across a camel-case modifier and a status value", () => {
    const files = snapshotOf({
      "src/types.ts": [
        "export interface LeaseUpdate { id: string; status: string; }",
        "export enum LeaseStatus { CURRENT = 'current', EXPIRED = 'expired' }",
      ].join("\n"),
      "src/lease.ts": [
        "import { LeaseStatus } from './types';",
        "export class LeaseSync {",
        "  constructor(private readonly repository: LeaseRepository) {}",
        "  async syncLease(id: string) {",
        "    return this.repository.bulkCreate([{",
        "      id,",
        "      start: '2026-01-01',",
        "      end: '2026-12-31',",
        "      status: LeaseStatus.CURRENT,",
        "    }]);",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/lease.ts", 5, [
        "-    return this.repository.save([{ id }]);",
        "+    return this.repository.bulkCreate([{",
        "+      id,",
        "+      start: '2026-01-01',",
        "+      end: '2026-12-31',",
        "+      status: LeaseStatus.CURRENT,",
        "+    }]);",
      ]),
      files,
    );
    const entry = entryOf(evidence(input).agenda, "agenda:external-write");
    expect(entry.reason).toContain("bulkCreate");
    expect(entry.reason).toContain("LeaseStatus.CURRENT");
    expect(entry.evidence.some(item => item.role === "change" && item.text.includes("status: LeaseStatus.CURRENT"))).toBe(true);
  });

  test("does not treat a routing queue name as lifecycle state", () => {
    const files = snapshotOf({
      "src/jobs.ts": [
        "export enum JobName { PROCESS_LEASE = 'lease.process' }",
        "export class Producer {",
        "  constructor(private readonly queue: Queue) {}",
        "  async schedule(id: string) {",
        "    return this.queue.add(JobName.PROCESS_LEASE, { id });",
        "  }",
        "}",
      ].join("\n"),
    });
    const input = scenario(
      hunk("src/jobs.ts", 5, [
        "-    return this.queue.add(JobName.PROCESS_LEASE);",
        "+    return this.queue.add(JobName.PROCESS_LEASE, { id });",
      ]),
      files,
    );
    // No state value is written at an external boundary here, so no question.
    expect(evidence(input).agenda.some(entry => entry.id === "agenda:external-write")).toBe(false);
  });
});

describe("honest scope", () => {
  test("a patch with no indexes returns no findings and says each check was not run", () => {
    const units = parseDiff(hunk("src/handler.ts", 1, ["+const x = compute();"]));
    const result = buildReviewEvidence(units);
    expect(result.findings).toEqual([]);
    expect(result.checks.map(check => `${check.kind}:${check.status}`)).toEqual([
      "unused-error-result:not-checked",
      "duplicate-body:not-checked",
      "broken-reference:not-checked",
    ]);
    expect(result.checks.every(check => check.detail.length > 40)).toBe(true);
    expect(result.agenda.flatMap(entry => entry.unitIds)).toEqual(units.map(unit => unit.id));
    expect(entryOf(result.agenda, "agenda:hunks:src/handler.ts").evidence[0].text).toContain("const x = compute();");
    // 0..100, higher first: the first entry carries the highest priority.
    expect(result.agenda[0].priority).toBe(100);
    expect(result.agenda.every(entry => entry.priority >= 0 && entry.priority <= 100)).toBe(true);
    expect(result.agenda.map(entry => entry.priority)).toEqual(
      result.agenda.map(entry => entry.priority).sort((left, right) => right - left),
    );
  });

  test("never claims a broken-reference result it did not compute", () => {
    const result = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "return { ok: true, count: result.users.length };",
    ]));
    const check = checkOf(result.checks, "broken-reference");
    expect(check.status).toBe("not-checked");
    expect(check.detail).toContain("not a type checker");
    expect(result.findings.every(finding => finding.kind !== "broken-reference")).toBe(true);
    expect(result.agenda.some(entry => entry.id === "agenda:check-scope")).toBe(true);
  });

  test("caps evidence and context per entry and reports one finding per receiver", () => {
    const result = evidence(receiverScenario([
      "const result = await createResidents(body.names);",
      "return { ok: true, count: result.users.length, users: result.users };",
    ]));
    for (const entry of result.agenda) {
      expect(entry.evidence.length).toBeLessThanOrEqual(5);
      expect(entry.context.length).toBeLessThanOrEqual(3);
      expect(entry.priority).toBeGreaterThanOrEqual(0);
      expect(entry.priority).toBeLessThanOrEqual(100);
    }
    const ids = result.agenda.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
