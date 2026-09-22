/**
 * Deterministic snapshot evidence for the report: the automatic checks with
 * their stated limits, and a reading agenda whose questions come from the
 * change's own structure.
 *
 * Everything here is derived from the immutable snapshots and their indexes:
 * parsed definition bodies, the type-contract relation, the dispatch relation,
 * and the call sites the extractor resolved. Nothing runs a project command and
 * nothing is authored by a model. A check that cannot see its input says so: a
 * missing index, a missing source reader, an unreadable span, and a fragment no
 * grammar parses each end as `not-checked` or as a counted omission instead of
 * a silent pass.
 *
 * Findings state what was read, never what it means: an unread failure field is
 * not a lost failure, and a matching body is not equivalent behavior or
 * unwanted duplication. The agenda then asks fixed review questions on
 * structural triggers, so a question can be raised without a defect having been
 * proved, and every hunk the change touches stays addressable.
 */
import { posix } from "node:path";
import { buildCallSitesFromInfo } from "../calltree.js";
import { allContextDefinitions, type FunctionIndex } from "../extract.js";
import { detectLanguage } from "../languages/registry.js";
import { resolveDispatchContext } from "../languages/typescript-dispatch.js";
import { resolveTypeContracts, type TypeContractEdge } from "../languages/typescript-contracts.js";
import { formatSourceLoc } from "../loc.js";
import { collapseWs, type SyntaxNode } from "../languages/types.js";
import type { CallNode, FunctionInfo, SourceLoc } from "../types.js";
import type { ContextSources } from "./call-context.js";
import type {
  AutomaticFinding,
  CheckCoverage,
  EvidenceExcerpt,
  ReviewAgendaEntry,
} from "./evidence-types.js";
import {
  bodyTokenSignature,
  callsIn,
  countReadOf,
  countReads,
  declaredValueNames,
  definitionSyntax,
  moduleImports,
  parseFragment,
  returnedCountRead,
  returnedResponseType,
  sameNode,
  stateWritesAt,
  contractFields,
  staticStringValue,
  typedBindings,
  walkSyntax,
  type DefinitionSyntax,
  type FragmentParse,
  type ContractField,
} from "./evidence-syntax.js";
import type { ReviewContextNode, ReviewUnit } from "./types.js";
import { testLikeFile } from "./file-role.js";

/**
 * Bounds shared by every run. Each one that drops work is stated in the
 * coverage detail, so a reader can tell a clean result from a truncated scan.
 */
const MAX_EXCERPT_CHARS = 2_400;
/**
 * Excerpts that only identify a hunk, not carry its evidence. The report shows
 * every hunk's own diff in full, so a hunk-coverage entry needs the change's
 * shape and enough of it to recognize, not a second copy of the diff.
 */
const MAX_HUNK_EXCERPT_CHARS = 600;
/**
 * Hunks one coverage entry carries as an excerpt. Every remaining hunk is named
 * in the entry's reason with its header and counts, so the entry identifies the
 * file's changes without repeating a card per hunk.
 */
const MAX_HUNK_EXCERPTS = 1;
const MAX_EVIDENCE_PER_ITEM = 5;
const MAX_FINDINGS_PER_KIND = 4;
const MAX_COMPARED_DEFINITIONS = 400;
const MAX_RECEIVER_DEFINITIONS = 200;
const MAX_CONTEXT_NODES_PER_ENTRY = 3;
const MAX_FACT_SENTENCES = 2;
/** Tokens a body needs before two copies of it are worth reporting. */
const MIN_DUPLICATE_TOKENS = 12;

/** Field names that report failure in a declared response shape. */
const ERROR_FIELD_NAMES =
  /^(?:err|error|errors|exception|exceptions|failure|failures|problem|problems)$/i;
/** Field names that report how much succeeded. */
const COUNT_FIELD_NAMES = /(?:count|total|length|size|number|num)$/i;
/**
 * Leading words of a call name that write state outside this process. A call is
 * a write when its own name starts with one of these at a camel-case boundary,
 * so `updateLease`, `createOrUpdate`, and `saveAll` count while `sendEmail`
 * matches `send` and `publish*` matches `publish`.
 */
const WRITE_VERBS = {
  create: true,
  insert: true,
  save: true,
  persist: true,
  upsert: true,
  update: true,
  write: true,
  put: true,
  store: true,
  publish: true,
  emit: true,
  enqueue: true,
  dispatch: true,
  send: true,
  post: true,
  commit: true,
  delete: true,
  remove: true,
  execute: true,
  transaction: true,
} satisfies Record<string, true>;
/** Nodes that hold statements; a read's evidence stops at the one enclosing it. */
const STATEMENT_CONTAINERS = {
  statement_block: true,
  program: true,
  class_body: true,
  switch_body: true,
  interface_body: true,
  declaration_list: true,
} satisfies Record<string, true>;
/** Declaration nodes that bind a name, so the binding itself is not a use. */
const TYPED_DECLARATION_NODES = {
  required_parameter: true,
  optional_parameter: true,
  parameter: true,
  typed_parameter: true,
  variable_declarator: true,
  public_field_definition: true,
  property_declaration: true,
} satisfies Record<string, true>;
/** Node types a response value is followed through, so it is still the result. */
const TRANSPARENT_NODES = {
  await_expression: true,
  parenthesized_expression: true,
  as_expression: true,
  satisfies_expression: true,
  non_null_expression: true,
  type_assertion: true,
} satisfies Record<string, true>;
/** Languages whose declared response shapes this check reads. */
const TYPED_RESPONSE_LANGUAGES = { typescript: true, typescriptreact: true } satisfies Record<string, true>;

export interface ReviewEvidenceOptions {
  /** Prior-snapshot index; absent for patch-only input. */
  before?: FunctionIndex;
  /** Resulting-snapshot index; absent for patch-only input. */
  after?: FunctionIndex;
  /** Per-snapshot definition source readers; absent when nothing can be read. */
  sources?: ContextSources;
  /** Provenance label for prior-snapshot evidence, e.g. the base commit. */
  baseRef?: string;
  /** Provenance label for resulting-snapshot evidence, e.g. the head commit. */
  headRef?: string;
  /** Local module binding resolver over the resulting immutable snapshot. */
  resolveImport?: (importer: string, specifier: string) => string | undefined;
}

/** Subject of an entry that names no definition of its own. */
const EMPTY_SUBJECT: FindingSubject = { primary: new Set(), contracts: new Set() };

export interface ReviewEvidenceResult {
  findings: AutomaticFinding[];
  checks: CheckCoverage[];
  agenda: ReviewAgendaEntry[];
}

/* ------------------------------------------------------------------ input */

type Side = "before" | "after";

/** One definition with the snapshot text read for it, parsed when possible. */
interface DefinitionSource {
  info: FunctionInfo;
  loc: SourceLoc;
  /** Snapshot text of the whole definition; null when the reader has none. */
  text: string | null;
  fragment: FragmentParse | null;
  syntax: DefinitionSyntax | null;
}

/** Changed lines of one review unit; empty for a metadata-only change. */
interface UnitChange {
  unit: ReviewUnit;
  lines: number[];
}

interface EvidenceInput {
  /** One entry per unit, in file, line, id order: the order the agenda reads them. */
  changes: readonly UnitChange[];
  after: FunctionIndex | undefined;
  before: FunctionIndex | undefined;
  changedFiles: Set<string>;
  sources: ContextSources;
  headRef: string;
  baseRef: string;
  /** Definition source by side and location: one read and one parse each. */
  definitions: Map<string, DefinitionSource>;
  imports: Map<string, Map<string, string> | null>;
  /** Declared return type names by definition, so one contract scan parses once. */
  returnTypes: Map<FunctionInfo, string[]>;
  resolveImport: (importer: string, specifier: string) => string | undefined;
}

function location(info: FunctionInfo): SourceLoc {
  const loc: SourceLoc = { file: info.file, line: info.line ?? 1 };
  if (info.line !== undefined && info.endLine !== undefined && info.endLine !== info.line) {
    loc.endLine = info.endLine;
  }
  return loc;
}

function byLocation(left: FunctionInfo, right: FunctionInfo): number {
  return (
    left.file.localeCompare(right.file) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.key.localeCompare(right.key)
  );
}

/**
 * Lines the hunk changes on the resulting snapshot, ascending. A deletion has
 * no resulting line of its own, so the boundary it leaves is recorded instead:
 * without it a removal-only hunk would mark nothing changed and the definition
 * that lost those lines would never be inspected.
 */
function changedLinesOf(unit: ReviewUnit): number[] {
  if (unit.special || !unit.header.startsWith("@@")) return [];
  const lines = new Set<number>();
  let line = unit.newStart;
  for (const text of unit.diff.split("\n").slice(1)) {
    const prefix = text[0];
    if (prefix === "+") lines.add(line++);
    else if (prefix === " ") line++;
    else if (prefix === "-") lines.add(Math.max(1, line));
  }
  return [...lines].sort((left, right) => left - right);
}

function evidenceInput(units: readonly ReviewUnit[], options: ReviewEvidenceOptions): EvidenceInput {
  return {
    changes: units
      .map(unit => ({ unit, lines: changedLinesOf(unit) }))
      .sort(
        (left, right) =>
          left.unit.file.localeCompare(right.unit.file) ||
          left.unit.newStart - right.unit.newStart ||
          left.unit.id.localeCompare(right.unit.id),
      ),
    after: options.after,
    before: options.before,
    changedFiles: new Set(units.map(unit => unit.file)),
    sources: options.sources ?? {},
    headRef: options.headRef ?? "resulting snapshot",
    baseRef: options.baseRef ?? "prior snapshot",
    definitions: new Map(),
    imports: new Map(),
    returnTypes: new Map(),
    resolveImport: options.resolveImport ?? relativeImportTarget,
  };
}

/** Definition source for one side, read and parsed at most once per location. */
function definitionSource(input: EvidenceInput, side: Side, info: FunctionInfo): DefinitionSource {
  const loc = location(info);
  const key = `${side}\0${loc.file}\0${loc.line}\0${loc.endLine ?? loc.line}`;
  const cached = input.definitions.get(key);
  if (cached) return cached;
  const reader = input.sources[side];
  const text = reader ? reader(loc) : null;
  const fragment = text === null ? null : parseFragment(info.file, text);
  const source: DefinitionSource = {
    info,
    loc,
    text,
    fragment,
    syntax: fragment ? definitionSyntax(fragment) : null,
  };
  input.definitions.set(key, source);
  return source;
}

/** Callable definitions of the resulting snapshot that live in a changed file. */
function changedDefinitions(input: EvidenceInput): FunctionInfo[] {
  if (!input.after) return [];
  return allContextDefinitions(input.after)
    .filter(info => !info.review?.kind && info.line !== undefined && input.changedFiles.has(info.file))
    .sort(byLocation);
}

/** Declared response type of one definition, parsed at most once. */
function declaredResponseTypes(input: EvidenceInput, info: FunctionInfo): string[] {
  const cached = input.returnTypes.get(info);
  if (cached) return cached;
  const source = definitionSource(input, "after", info);
  const name = source.syntax ? returnedResponseType(source.syntax.definition) : null;
  const names = name === null ? [] : [name];
  input.returnTypes.set(info, names);
  return names;
}

function intersectsChanged(input: EvidenceInput, info: FunctionInfo): boolean {
  const start = info.line ?? 0;
  const end = info.endLine ?? start;
  return input.changes.some(
    change =>
      change.unit.file === info.file &&
      change.lines.some(line => line >= start && line <= end),
  );
}

/** Units whose changed lines fall inside one definition's span. */
function unitsTouching(input: EvidenceInput, info: FunctionInfo): string[] {
  const start = info.line ?? 0;
  const end = info.endLine ?? start;
  return input.changes
    .filter(
      change =>
        change.unit.file === info.file &&
        change.lines.some(line => line >= start && line <= end),
    )
    .map(({ unit }) => unit.id);
}

/**
 * Smallest definition containing each changed line of one hunk, so a nested
 * definition is not reported as its enclosing body.
 */
function hunkDefinitions(
  candidates: readonly FunctionInfo[],
  lines: readonly number[],
): FunctionInfo[] {
  const selected = new Set<FunctionInfo>();
  const containing: FunctionInfo[] = [];
  for (const line of lines) {
    containing.length = 0;
    let width = Infinity;
    for (const info of candidates) {
      const start = info.line ?? 0;
      const end = info.endLine ?? start;
      if (line < start || line > end) continue;
      const span = end - start;
      if (span < width) {
        width = span;
        containing.length = 0;
      }
      if (span === width) containing.push(info);
    }
    for (const info of containing) selected.add(info);
  }
  return [...selected].sort(byLocation);
}

/* --------------------------------------------------------------- excerpts */

/** Text kept for one excerpt; a cut is stated in the text, never silent. */
function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… evidence text cut at ${limit} characters`;
}

interface ExcerptInput {
  role: EvidenceExcerpt["role"];
  label: string;
  file: string;
  line: number;
  endLine?: number;
  ref: string;
  text: string;
  /** Character cap for this excerpt; whole-definition evidence is the default. */
  limit?: number;
}

function excerpt(input: ExcerptInput): EvidenceExcerpt {
  const value: EvidenceExcerpt = {
    id: `${input.role}:${input.file}:${input.line}:${input.label}`,
    label: input.label,
    file: input.file,
    line: Math.max(1, input.line),
    ref: input.ref,
    text: clip(input.text, input.limit ?? MAX_EXCERPT_CHARS),
    role: input.role,
  };
  if (input.endLine !== undefined && input.endLine !== input.line) value.endLine = input.endLine;
  return value;
}

function definitionExcerpt(
  input: EvidenceInput,
  side: Side,
  info: FunctionInfo,
  role: EvidenceExcerpt["role"],
  label: string,
): EvidenceExcerpt | null {
  const source = definitionSource(input, side, info);
  if (source.text === null) return null;
  return excerpt({
    role,
    label,
    file: source.loc.file,
    line: source.loc.line,
    endLine: source.loc.endLine,
    ref: side === "after" ? input.headRef : input.baseRef,
    text: source.text,
  });
}


/** Direct callers within the gathered context, including callers changed in the same hunk. */
function callerEvidence(
  input: EvidenceInput,
  unitIds: readonly string[],
  target: FunctionInfo,
): EvidenceExcerpt[] {
  if (!input.after) return [];
  const wanted = new Set(unitIds);
  const keys = new Set<string>();
  for (const { unit } of input.changes) {
    if (!wanted.has(unit.id)) continue;
    for (const node of unit.contextNodes ?? []) keys.add(node.key);
  }
  const found: EvidenceExcerpt[] = [];
  const candidates = allContextDefinitions(input.after)
    .filter(info => info !== target && !info.review?.kind && keys.has(`after:${info.key}`))
    .sort(byLocation);
  for (const info of candidates) {
    const source = definitionSource(input, "after", info);
    const reaches = buildCallSitesFromInfo(info, input.after).some(site =>
      site.definition?.file === target.file && site.definition.line === target.line &&
      producerCallProven(input, source, target, site),
    );
    if (!reaches) continue;
    const evidence = definitionExcerpt(input, "after", info, "caller", `direct caller ${info.key}`);
    if (evidence) found.push(evidence);
    if (found.length === 2) break;
  }
  return found;
}

/** Without configuration, only explicit relative TypeScript source modules are followed. */
function relativeImportTarget(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return /\.[cm]?tsx?$/u.test(path) ? path : `${path.replace(/\.[cm]?jsx?$/u, "")}.ts`;
}

/** Only lexical bindings, typed receivers, and resolved imports establish a producer. */
function producerCallProven(
  input: EvidenceInput,
  source: DefinitionSource,
  producer: FunctionInfo,
  site: CallNode,
): boolean {
  const callee = site.context?.callee ?? "";
  const member = producer.key.lastIndexOf(".");
  const sameFile = producer.file === source.info.file;
  if (sameFile && site.context?.target === "lexical") return true;
  let importedName = callee;
  let origin = source;
  if (member >= 0) {
    const owner = producer.key.slice(0, member);
    const sourceOwner = source.info.key.slice(0, source.info.key.lastIndexOf("."));
    if (sameFile && sourceOwner === owner && callee === `this.${producer.key.slice(member + 1)}`) return true;
    const field = /^this\.([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/u.exec(callee)?.[1];
    if (!field || !input.after) return false;
    const constructor = allContextDefinitions(input.after).find(info =>
      info.file === source.info.file && info.key === `${sourceOwner}.constructor`,
    );
    if (!constructor) return false;
    origin = definitionSource(input, "after", constructor);
    if (!origin.syntax || !typedBindings(origin.syntax.definition, owner).some(binding => binding.name === field)) return false;
    if (sameFile) return true;
    importedName = owner;
  } else if (!/^[A-Za-z_$][\w$]*$/u.test(callee)) {
    return false;
  }
  const specifier = importsOf(input, origin)?.get(importedName);
  return specifier !== undefined && input.resolveImport(origin.info.file, specifier) === producer.file;
}

function importsOf(input: EvidenceInput, source: DefinitionSource): Map<string, string> | null {
  const key = `${source.info.file}:${source.loc.line}`;
  let imports = input.imports.get(key);
  if (imports === undefined) {
    const prefix = input.sources.after?.({ file: source.info.file, line: 1, endLine: source.loc.line });
    imports = prefix === null || prefix === undefined ? null : moduleImports(source.info.file, prefix);
    input.imports.set(key, imports);
  }
  return imports;
}


/** Role a context node was selected as, read from its own detail header. */
function contextRole(node: ReviewContextNode): EvidenceExcerpt["role"] {
  const role = /role=(changed-definition|caller|callee)\b/.exec(node.detail)?.[1];
  if (role === "changed-definition") return "change";
  return role === "caller" ? "caller" : "related";
}


/** Identification-sized excerpt of one hunk, for the coverage entries. */
function unitExcerpt(input: EvidenceInput, unit: ReviewUnit): EvidenceExcerpt {
  const lead = unit.special
    ? `${unit.header}\nspecial: ${unit.special}`
    : `${unit.header} (added ${unit.added}, removed ${unit.removed})`;
  return excerpt({
    role: "change",
    label: unit.special ? `changed file metadata ${unit.file}` : `changed hunk ${unit.file}:${unit.newStart}`,
    file: unit.file,
    line: unit.special ? 1 : unit.newStart,
    ref: input.headRef,
    limit: MAX_HUNK_EXCERPT_CHARS,
    text: `${lead}\n${unit.diff.split("\n").slice(1).join("\n")}`,
  });
}

/** Roles of one entry's evidence, in the order a reader needs them. */
const EVIDENCE_ROLES = ["change", "caller", "test", "related", "contract"] as const;

/**
 * Unique excerpts for one entry, rotated across the roles so every role present
 * is represented before any role takes a second slot: a run of contract
 * declarations can then never consume the slots the changed code and its
 * callers of the same entry need. Order within a role is the caller's ranking.
 */
function selectEvidence(
  candidates: readonly EvidenceExcerpt[],
  limit = MAX_EVIDENCE_PER_ITEM,
): EvidenceExcerpt[] {
  const byRole = new Map<string, EvidenceExcerpt[]>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const list = byRole.get(candidate.role);
    if (list) list.push(candidate);
    else byRole.set(candidate.role, [candidate]);
  }
  const kept: EvidenceExcerpt[] = [];
  for (let round = 0; kept.length < limit; round += 1) {
    let added = false;
    for (const role of EVIDENCE_ROLES) {
      const candidate = byRole.get(role)?.[round];
      if (!candidate) continue;
      kept.push(candidate);
      added = true;
      if (kept.length >= limit) break;
    }
    if (!added) break;
  }
  return kept;
}

/** Ranks one context node by how directly its entry is about it. */
function contextRank(
  node: ReviewContextNode,
  primary: ReadonlySet<string>,
  contracts: ReadonlySet<string>,
): number {
  if (primary.has(node.key)) return 0;
  const role = contextRole(node);
  if (role === "change") return 1;
  // A caller has no other place in the entry; the whole-definition excerpt
  // already carries a callee's body and the declared contract.
  if (role === "caller") return 2;
  return contracts.has(node.key) ? 3 : 4;
}

/**
 * Context nodes of the entry's units, keyed uniquely and ranked by what the
 * entry is about: the definition it names first, then the changed definition,
 * then its callers, then the declared contract, then farther context. Unit
 * order, then selection order, breaks every tie.
 */
function selectContext(
  input: EvidenceInput,
  unitIds: ReadonlySet<string>,
  primary: ReadonlySet<string>,
  contracts: ReadonlySet<string>,
  callers: readonly EvidenceExcerpt[] = [],
): ReviewContextNode[] {
  const ranked: { node: ReviewContextNode; rank: number; order: number }[] = [];
  const keys = new Set<string>();
  let order = 0;
  for (const { unit } of input.changes) {
    if (!unitIds.has(unit.id)) continue;
    for (const node of unit.contextNodes ?? []) {
      if (keys.has(node.key)) continue;
      if (!primary.has(node.key) && !contracts.has(node.key) &&
        !callers.some(caller => node.key.startsWith("after:") && caller.file === node.file && caller.line === node.line)) continue;
      keys.add(node.key);
      ranked.push({ node, rank: contextRank(node, primary, contracts), order: order++ });
    }
  }
  return ranked
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .slice(0, MAX_CONTEXT_NODES_PER_ENTRY)
    .map(entry => entry.node);
}

/** Sentences capped for display; the cut is stated rather than hidden. */
function factsText(sentences: readonly string[]): string {
  if (sentences.length <= MAX_FACT_SENTENCES) return sentences.join(" ");
  return [
    ...sentences.slice(0, MAX_FACT_SENTENCES),
    `…and ${sentences.length - MAX_FACT_SENTENCES} more of the same kind.`,
  ].join(" ");
}

/* --------------------------------------------------------------- coverage */

function coverage(
  kind: CheckCoverage["kind"],
  status: CheckCoverage["status"],
  detail: string,
): CheckCoverage {
  return { kind, status, detail };
}

const PATCH_REASON =
  "Patch-only input: no repository revision was indexed, so definition bodies, declared shapes, and resolved " +
  "calls are all unavailable.";
const INDEX_REASON =
  "No resulting-snapshot index was supplied, so no definition could be read or compared.";
const SOURCE_REASON =
  "No snapshot source reader was supplied, so definition bodies and declared shapes could not be read.";

/* ------------------------------------------------------- definition bodies */

/** One definition body kept for the duplicate comparison. */
interface BodyCandidate {
  info: FunctionInfo;
  body: string;
  touched: boolean;
}

/** Outcome of the duplicate-body comparison: findings plus its own coverage. */
interface DuplicateScan {
  findings: AutomaticFinding[];
  check: CheckCoverage;
}

/**
 * Functions whose bodies are token-identical after comments and formatting are
 * removed. Literals and operators are kept, so `create(user)` and
 * `create(admin)` never match, and only definitions in changed files are
 * compared, so the scan stays bounded by the diff. A group is reported only
 * when it spans two files and at least one copy is code this change touched.
 */
function duplicateScan(input: EvidenceInput): DuplicateScan {
  if (!input.after) {
    return { findings: [], check: coverage("duplicate-body", "not-checked", INDEX_REASON) };
  }
  if (!input.sources.after) {
    return { findings: [], check: coverage("duplicate-body", "not-checked", SOURCE_REASON) };
  }
  const candidates = changedDefinitions(input);
  const compared: BodyCandidate[] = [];
  let skipped = 0;
  for (const info of candidates.slice(0, MAX_COMPARED_DEFINITIONS)) {
    const source = definitionSource(input, "after", info);
    if (!source.syntax) {
      skipped += 1;
      continue;
    }
    const body = bodyTokenSignature(source.syntax.body);
    if (body.split(" ").length < MIN_DUPLICATE_TOKENS) continue;
    compared.push({ info, body, touched: intersectsChanged(input, info) });
  }
  const groups = new Map<string, BodyCandidate[]>();
  for (const member of compared) {
    const group = groups.get(member.body);
    if (group) group.push(member);
    else groups.set(member.body, [member]);
  }
  const findings: AutomaticFinding[] = [];
  let matchedGroups = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map(member => member.info.file)).size < 2) continue;
    if (!group.some(member => member.touched)) continue;
    matchedGroups += 1;
    if (findings.length >= MAX_FINDINGS_PER_KIND) continue;
    const ordered = [...group].sort((left, right) => byLocation(left.info, right.info));
    const first = ordered[0];
    findings.push({
      id: `duplicate-body:${first.info.file}:${first.info.line ?? 1}`,
      kind: "duplicate-body",
      title:
        `Matching function bodies: ${ordered.map(member => member.info.key).join(" and ")}` +
        (ordered.length > 2 ? ` (${ordered.length} definitions)` : ""),
      scope:
        `Normalized token comparison of ${ordered.length} definitions whose files this change touches: ` +
        ordered.map(member => `${member.info.key} @ ${formatSourceLoc(location(member.info))}`).join(", ") +
        ".",
      limitation:
        "Matching bodies do not establish equivalent behavior, that this change introduced the duplication, or " +
        "that the definitions should be merged. Only the bodies are compared: declared signatures, parameter and " +
        "return types, and every call site are outside this comparison. Comments and formatting are ignored; " +
        `literals and operators are compared as written. ${compared.length} bodies in changed files were compared, ` +
        `${skipped} were skipped because their source span or fragment was unreadable.`,
      unitIds: [...new Set(ordered.flatMap(member => unitsTouching(input, member.info)))].sort(),
      evidence: selectEvidence(
        ordered.flatMap((member, index) => {
          const evidence = definitionExcerpt(
            input,
            "after",
            member.info,
            member.touched ? "change" : "related",
            `body ${index + 1}/${ordered.length} ${member.info.key}`,
          );
          return evidence ? [evidence] : [];
        }),
      ),
    });
  }
  const truncated = candidates.length > MAX_COMPARED_DEFINITIONS;
  return {
    findings,
    check: coverage(
      "duplicate-body",
      skipped > 0 || truncated ? "partial" : "checked",
      [
        `Compared ${compared.length} comment-free bodies of callable definitions in the changed files of the ` +
          `resulting snapshot (${candidates.length} candidate definitions, limit ${MAX_COMPARED_DEFINITIONS}${truncated ? ", so the rest were not compared" : ""}).`,
        `${skipped} definitions were skipped: no readable source span, or a fragment the grammar would not parse.`,
        matchedGroups > 0
          ? `${matchedGroups} token-identical body group${matchedGroups === 1 ? "" : "s"} crossed two changed files; ${findings.length} ${findings.length === 1 ? "is" : "are"} reported.`
          : "No token-identical body group crossed two changed files, so no duplicate is reported; that is a comparison result, not a claim about design.",
        "Only bodies are compared: signatures, parameter and return types, and call sites are not. Comments and " +
          "formatting are ignored; literals and operators are compared as written.",
      ].join(" "),
    ),
  };
}

/* ---------------------------------------------------------- response shapes */

interface ResponseContract {
  info: FunctionInfo;
  fields: ContractField[];
  errorField: ContractField;
}

interface ContractContext {
  contract: ResponseContract;
  /** Definitions whose declared return type names this contract. */
  producers: FunctionInfo[];
  /**
   * Definitions whose source names this very declaration, per the resolved
   * type-contract relation. A parameter typed `CreateResult` only holds this
   * response when this set contains the receiver: a same-named declaration
   * elsewhere resolves to itself, not here.
   */
  namers: Set<FunctionInfo>;
}

/**
 * One way a receiver holds a response: a named value, or the fields written in
 * a destructuring pattern. `via` is shown as evidence.
 */
type ResponseHold =
  | { kind: "name"; name: string; line: number; via: string }
  | { kind: "pattern"; fields: string[]; rest: boolean; line: number; via: string };

interface UseObservation {
  verdict: "error-read" | "error-unread" | "uncertain";
  reported: { field: string; line: number; statement: string; counted: boolean }[];
}

/** Source line of one parse row, on the snapshot both were read from. */
function absoluteLine(fragment: FragmentParse, source: DefinitionSource, row: number): number {
  return source.loc.line + row - fragment.lineOffset;
}

/**
 * Call expression on one line whose callee names the producer: the resolved
 * call site is what selects the line, and the callee segment confirms that the
 * expression belongs to the same target.
 */
function callExpressionAt(
  syntax: DefinitionSyntax,
  fragment: FragmentParse,
  source: DefinitionSource,
  line: number,
  key: string,
): SyntaxNode | null {
  const last = key.slice(key.lastIndexOf(".") + 1);
  let found: SyntaxNode | null = null;
  walkSyntax(syntax.definition, node => {
    if (found || node.type !== "call_expression") return;
    if (absoluteLine(fragment, source, node.startPosition.row) !== line) return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    if (callee.text.slice(callee.text.lastIndexOf(".") + 1) === last) found = node;
  });
  return found;
}

/**
 * How a call's own response is used at its site: bound to a name, destructured
 * by field, destructured by position, or not kept at all. Only the first two
 * can be followed; everything else is a value that leaves this code.
 */
type ResponseArrival =
  | { kind: "name"; name: string; node: SyntaxNode }
  | { kind: "pattern"; fields: string[]; rest: boolean; node: SyntaxNode }
  | { kind: "positional" }
  | null;

function responseArrival(call: SyntaxNode, requiresAwait: boolean): ResponseArrival {
  let value = call;
  let parent = value.parent;
  let awaited = false;
  while (parent && Object.hasOwn(TRANSPARENT_NODES, parent.type)) {
    if (parent.type === "await_expression") awaited = true;
    value = parent;
    parent = parent.parent;
  }
  if (!parent || (requiresAwait && !awaited)) return null;
  if (parent.type === "variable_declarator" && sameNode(parent.childForFieldName("value"), value)) {
    const name = parent.childForFieldName("name");
    if (!name) return null;
    if (name.type === "identifier") return { kind: "name", name: name.text, node: name };
    if (name.type !== "object_pattern") return { kind: "positional" };
    const fields: string[] = [];
    let rest = false;
    for (const entry of name.namedChildren) {
      if (entry.type === "rest_pattern") {
        rest = true;
        continue;
      }
      const keyNode = entry.type === "shorthand_property_identifier_pattern"
        ? entry
        : entry.childForFieldName("key") ?? entry.childForFieldName("left");
      if (!keyNode || keyNode.type === "computed_property_name") {
        rest = true;
        continue;
      }
      const key = keyNode.type === "string" ? staticStringValue(keyNode) : keyNode.text;
      if (key === null || key === undefined) rest = true;
      else fields.push(key);
    }
    return { kind: "pattern", fields, rest, node: name };
  }
  if (parent.type === "assignment_expression" && sameNode(parent.childForFieldName("right"), value)) {
    const left = parent.childForFieldName("left");
    return left?.type === "identifier" ? { kind: "name", name: left.text, node: left } : null;
  }
  return null;
}

/** Statement text one read belongs to, so its evidence carries its own context. */
function enclosingStatement(node: SyntaxNode): string {
  let current = node;
  while (current.parent && !Object.hasOwn(STATEMENT_CONTAINERS, current.parent.type)) {
    current = current.parent;
  }
  return current.text.replace(/\s+/g, " ").trim();
}

/**
 * One field read off a held response, as reported evidence. A count-named read
 * of that field is the count itself, so it is marked as counted and its line is
 * the count expression's own line, not the field read's.
 */
function reportedField(
  fragment: FragmentParse,
  source: DefinitionSource,
  access: SyntaxNode,
  field: string,
): UseObservation["reported"][number] {
  const counting = access.parent?.type === "member_expression"
    ? countReadOf(access.parent)
    : null;
  const at = counting ? counting.read : access;
  return {
    field,
    line: absoluteLine(fragment, source, at.startPosition.row),
    statement: enclosingStatement(at),
    counted: counting !== null || COUNT_FIELD_NAMES.test(field),
  };
}

/** First count usage of one destructured field, with the statement it sits in. */
function countUsageOf(
  fragment: FragmentParse,
  source: DefinitionSource,
  syntax: DefinitionSyntax,
  field: string,
): { line: number; statement: string } | null {
  for (const count of countReads(syntax.definition)) {
    if (count.value !== field) continue;
    return {
      line: absoluteLine(fragment, source, count.read.startPosition.row),
      statement: enclosingStatement(count.read),
    };
  }
  return null;
}

/**
 * What one receiver does with the response it holds. A field read on the
 * binding is either the failure field itself or a reported value; anything
 * else — the response returned, passed, spread, aliased, rebound, or reached
 * through a computed key — ends as `uncertain`, so no finding rests on it.
 */
function observeUses(
  source: DefinitionSource,
  errorField: string,
  holds: readonly ResponseHold[],
): UseObservation {
  const syntax = source.syntax;
  const fragment = source.fragment;
  const reported: UseObservation["reported"] = [];
  if (!syntax || !fragment) return { verdict: "uncertain", reported };
  const wanted = new Set(holds.filter(hold => hold.kind === "name").map(hold => hold.name));
  let errorRead = false;
  let uncertain = "";
  walkSyntax(syntax.definition, node => {
    if (errorRead || uncertain !== "" || (node.type !== "identifier" && node.type !== "shorthand_property_identifier")) return;
    if (!wanted.has(node.text)) return;
    const parent = node.parent;
    if (!parent) {
      uncertain = "the binding has no readable parent";
      return;
    }
    if (parent.type === "variable_declarator" && sameNode(parent.childForFieldName("name"), node)) return;
    if (
      Object.hasOwn(TYPED_DECLARATION_NODES, parent.type) &&
      sameNode(parent.childForFieldName("pattern") ?? parent.childForFieldName("name"), node)
    ) {
      return;
    }
    if (parent.type === "member_expression") {
      if (!sameNode(parent.childForFieldName("object"), node)) {
        uncertain = "the binding names a property rather than the response";
        return;
      }
      // `result.method()` passes the whole response as the receiver, so the
      // body being read cannot tell what that method does with it.
      if (parent.parent?.type === "call_expression" && sameNode(parent.parent.childForFieldName("function"), parent)) {
        uncertain = `the response is passed whole to ${parent.text}`;
        return;
      }
      const property = parent.childForFieldName("property");
      if (!property || property.type !== "property_identifier") {
        uncertain = "computed property access could read any field";
        return;
      }
      if (property.text === errorField) {
        errorRead = true;
        return;
      }
      reported.push(reportedField(fragment, source, parent, property.text));
      return;
    }
    if (parent.type === "subscript_expression") {
      const index = parent.childForFieldName("index");
      if (index && staticStringValue(index) === errorField) {
        errorRead = true;
        return;
      }
      uncertain = "element access with a non-literal key could read any field";
      return;
    }
    if (parent.type === "variable_declarator" && sameNode(parent.childForFieldName("value"), node)) {
      uncertain = `the response is aliased to ${parent.childForFieldName("name")?.text ?? "another name"}`;
      return;
    }
    if (parent.type === "assignment_expression" && sameNode(parent.childForFieldName("left"), node)) {
      uncertain = "the response is rebound to another name";
      return;
    }
    uncertain = `the response is used as a whole value (${parent.type})`;
  });
  if (errorRead) return { verdict: "error-read", reported };
  if (uncertain !== "") return { verdict: "uncertain", reported };
  // A destructuring pattern reads exactly the fields it writes: the failure
  // field is either named there, hidden behind a rest element, or not read.
  for (const hold of holds) {
    if (hold.kind !== "pattern") continue;
    if (hold.fields.includes(errorField)) return { verdict: "error-read", reported };
    if (hold.rest) return { verdict: "uncertain", reported };
    for (const field of hold.fields) {
      const usage = countUsageOf(fragment, source, syntax, field);
      reported.push(
        usage
          ? { field, line: usage.line, statement: usage.statement, counted: true }
          : {
              field,
              line: hold.line,
              statement: `destructured from the response: { ${hold.fields.join(", ")} }`,
              counted: COUNT_FIELD_NAMES.test(field),
            },
      );
    }
  }
  return { verdict: "error-unread", reported };
}

/**
 * Ways one receiver holds the response: the results of calls that resolved to a
 * producer, and parameters, locals, or fields whose declared type names the
 * contract. A result that is returned, passed, spread, aliased, or destructured
 * by position yields no hold and records why in `forwarded`, because the value
 * leaves the code this check can read.
 */
function responseHolds(
  input: EvidenceInput,
  source: DefinitionSource,
  context: ContractContext,
  sites: readonly CallNode[],
  forwarded: { value: string },
): ResponseHold[] {
  const holds: ResponseHold[] = [];
  const syntax = source.syntax;
  const fragment = source.fragment;
  if (!syntax || !fragment) return holds;
  for (const producer of context.producers) {
    const target = producer.line;
    if (target === undefined) continue;
    const producerSyntax = definitionSource(input, "after", producer).syntax;
    const requiresAwait = producerSyntax !== null && (
      producerSyntax.definition.children.some(child => child.type === "async") ||
      /\bPromise\s*</u.test(producerSyntax.definition.childForFieldName("return_type")?.text ?? "")
    );
    // A call whose callee name this receiver declares for itself is a call to
    // that local value, not to the producer whose bare key it shares.
    const shadowed = declaredValueNames(syntax.definition);
    const calleeName = producer.key.slice(producer.key.lastIndexOf(".") + 1);
    if (shadowed.has(calleeName)) continue;
    // A global name match is not binding evidence; check each actual call site.
    const resolved = sites.filter(
      node =>
        node.line !== undefined &&
        node.definition !== undefined &&
        node.definition.file === producer.file &&
        node.definition.line === target,
    );
    for (const site of resolved) {
      const siteLine = site.line;
      if (!producerCallProven(input, source, producer, site)) continue;
      if (siteLine === undefined) continue;
      const call = callExpressionAt(syntax, fragment, source, siteLine, producer.key);
      if (!call) continue;
      const arrival = responseArrival(call, requiresAwait);
      const via = `resolved call to ${producer.key} at line ${siteLine}`;
      if (arrival === null) {
        forwarded.value = `a call to ${producer.key} at line ${siteLine} hands the response on instead of keeping it`;
        continue;
      }
      if (arrival.kind === "positional") {
        forwarded.value = `a call to ${producer.key} at line ${siteLine} is destructured by position`;
        continue;
      }
      const line = absoluteLine(fragment, source, arrival.node.startPosition.row);
      holds.push(
        arrival.kind === "name"
          ? { kind: "name", name: arrival.name, line, via }
          : { kind: "pattern", fields: arrival.fields, rest: arrival.rest, line, via },
      );
    }
  }
  // A parameter typed by the contract is a response this check can read, but
  // only when the name written there resolves to this very declaration; a
  // same-named declaration elsewhere is a different type, not this response.
  for (const binding of typedBindings(syntax.definition, context.contract.info.key)) {
    if (!context.namers.has(source.info)) continue;
    holds.push({
      kind: "name",
      name: binding.name,
      line: absoluteLine(fragment, source, binding.row),
      via: `declared as ${context.contract.info.key}`,
    });
  }
  return holds;
}

/**
 * One interface or type-alias declaration whose fields were readable, from the
 * snapshot the fields were read in.
 */
interface ContractDeclaration {
  info: FunctionInfo;
  fields: ContractField[];
}

/** Interface/type declarations in changed files, with their declared fields. */
function changedContracts(input: EvidenceInput, side: Side): ContractDeclaration[] {
  const index = side === "after" ? input.after : input.before;
  if (!index) return [];
  const contracts: ContractDeclaration[] = [];
  for (const info of allContextDefinitions(index)) {
    const kind = info.review?.kind;
    if (kind !== "interface" && kind !== "type") continue;
    if (!input.changedFiles.has(info.file)) continue;
    const fields = readContractFields(input, side, info);
    if (fields) contracts.push({ info, fields });
  }
  return contracts.sort((left, right) => byLocation(left.info, right.info));
}

function readContractFields(input: EvidenceInput, side: Side, info: FunctionInfo): ContractField[] | null {
  const source = definitionSource(input, side, info);
  return source.fragment ? contractFields(source.fragment, info.key) : null;
}

/** Declared response contracts, and declarations whose fields stayed unreadable. */
interface ResponseContractScan {
  contracts: ResponseContract[];
  unreadable: number;
}

/** Declared fields of a contract that has a failure field and a reported one. */
function responseContracts(
  input: EvidenceInput,
  infos: readonly FunctionInfo[],
): ResponseContractScan {
  const contracts: ResponseContract[] = [];
  let unreadable = 0;
  for (const info of infos) {
    const fields = readContractFields(input, "after", info);
    if (!fields) {
      unreadable += 1;
      continue;
    }
    const errorField = fields.find(field => ERROR_FIELD_NAMES.test(field.name));
    if (!errorField || fields.length < 2) continue;
    contracts.push({ info, fields, errorField });
  }
  return { contracts, unreadable };
}

/** A test with a call bound to the actual producer, not merely the same member name. */
function supportingTest(
  input: EvidenceInput,
  candidates: readonly FunctionInfo[],
  target: FunctionInfo,
): EvidenceExcerpt | null {
  if (!input.after) return null;
  for (const info of candidates) {
    if (!testLikeFile(info.file)) continue;
    const sites = buildCallSitesFromInfo(info, input.after);
    if (!sites.some(site => site.definition?.file === target.file && site.definition.line === target.line &&
      producerCallProven(input, definitionSource(input, "after", info), target, site))) continue;
    const evidence = definitionExcerpt(input, "after", info, "test", `test reference ${info.key} (static call, not executed coverage)`);
    if (evidence) return evidence;
  }
  return null;
}

/** The other side of one dispatch site, as the syntactic relation reports it. */
function dispatchCounterpart(
  input: EvidenceInput,
  info: FunctionInfo,
  edges: readonly { owner: FunctionInfo; target: FunctionInfo }[],
  emit: boolean,
): EvidenceExcerpt | null {
  for (const edge of edges) {
    if (emit ? edge.owner !== info : edge.target !== info) continue;
    const other = emit ? edge.target : edge.owner;
    const evidence = definitionExcerpt(
      input,
      "after",
      other,
      "related",
      `${emit ? "dispatch handler" : "publisher"} ${other.key} (syntactic relation, not proof of delivery)`,
    );
    if (evidence) return evidence;
  }
  return null;
}

interface ResponseScan {
  findings: AutomaticFinding[];
  check: CheckCoverage;
  facts: FactBucket;
  /** Receiver and contract context keys per finding. */
  names: Map<string, FindingSubject>;
}

/**
 * Unused failure results, typed-response scope: a declared response shape has a
 * failure field and at least one reported field, a receiver in code this change
 * touches holds the response, and the failure field is never read from it.
 */
function responseScan(input: EvidenceInput): ResponseScan {
  const after = input.after;
  const facts = factBucket();
  if (!after) {
    return { findings: [], check: coverage("unused-error-result", "not-checked", INDEX_REASON), facts, names: new Map() };
  }
  if (!input.sources.after) {
    return { findings: [], check: coverage("unused-error-result", "not-checked", SOURCE_REASON), facts, names: new Map() };
  }
  const definitions = allContextDefinitions(after);
  const contractEdges = resolveTypeContracts(definitions);
  // A receiver is a changed definition whose readable body this check can walk;
  // its resolved calls are what put a response in the change's scope at all.
  const candidates = changedDefinitions(input);
  // Definitions this change touches come first, so a cap can never push the
  // only changed receiver out behind unchanged predecessors.
  const touchedDefinitions = candidates.filter(info => intersectsChanged(input, info));
  const receivers = [...touchedDefinitions, ...candidates.filter(info => !intersectsChanged(input, info))]
    .slice(0, MAX_RECEIVER_DEFINITIONS);
  const byLocationKey = new Map<string, FunctionInfo>();
  for (const info of definitions) {
    if (info.line === undefined) continue;
    const key = `${info.file}\0${info.line}`;
    if (!byLocationKey.has(key)) byLocationKey.set(key, info);
  }
  const changedSet = new Set(receivers);
  const scoped = new Set<FunctionInfo>();
  for (const info of receivers) {
    if (!intersectsChanged(input, info)) continue;
    for (const site of buildCallSitesFromInfo(info, after)) {
      const definition = site.definition;
      if (!definition) continue;
      const callee = byLocationKey.get(`${definition.file}\0${definition.line}`);
      if (callee) scoped.add(callee);
    }
  }
  // In scope: a shape this change declares, a shape a changed definition writes,
  // and a shape returned by a definition that changed code calls. Nothing else —
  // every contract anybody in the repository references would drown the check.
  const named = new Map<string, FunctionInfo[]>();
  for (const info of definitions) {
    const kind = info.review?.kind;
    if (kind !== "interface" && kind !== "type") continue;
    const list = named.get(info.key);
    if (list) list.push(info);
    else named.set(info.key, [info]);
  }
  const relevant = new Map<FunctionInfo, true>();
  const admit = (info: FunctionInfo): void => {
    if (info.review?.kind === "interface" || info.review?.kind === "type") relevant.set(info, true);
  };
  for (const info of definitions) if (input.changedFiles.has(info.file)) admit(info);
  for (const edge of contractEdges) if (changedSet.has(edge.owner)) admit(edge.target);
  for (const callee of scoped) {
    for (const name of declaredResponseTypes(input, callee)) {
      const candidatesNamed = named.get(name);
      if (!candidatesNamed) continue;
      admit(candidatesNamed.find(info => info.file === callee.file) ?? candidatesNamed[0]);
    }
  }
  const inScope = [...relevant.keys()].sort(byLocation);
  const { contracts, unreadable } = responseContracts(input, inScope);
  const contexts: ContractContext[] = contracts.map(contract => ({
    contract,
    producers: [
      ...new Set(
        contractEdges
          .filter(edge => edge.target === contract.info)
          .map(edge => edge.owner)
          .filter(owner => declaredResponseTypes(input, owner).includes(contract.info.key)),
      ),
    ].sort(byLocation),
    namers: new Set(contractEdges.filter(edge => edge.target === contract.info).map(edge => edge.owner)),
  }));

  const findings: AutomaticFinding[] = [];
  const names = new Map<string, FindingSubject>();
  let examined = 0;
  let skipped = 0;
  let forwardedCount = 0;
  let uncertainCount = 0;
  for (const info of receivers) {
    if (!intersectsChanged(input, info)) continue;
    const source = definitionSource(input, "after", info);
    if (source.text === null || !source.syntax || !source.fragment) {
      skipped += 1;
      continue;
    }
    examined += 1;
    const sites = buildCallSitesFromInfo(info, after);
    for (const context of contexts) {
      const forwarded = { value: "" };
      const holds = responseHolds(input, source, context, sites, forwarded);
      if (forwarded.value !== "") {
        forwardedCount += 1;
        continue;
      }
      if (holds.length === 0) continue;
      const observation = observeUses(source, context.contract.errorField.name, holds);
      if (observation.verdict === "uncertain") {
        uncertainCount += 1;
        continue;
      }
      if (observation.verdict === "error-read") continue;
      const contractEvidence = definitionExcerpt(
        input,
        "after",
        context.contract.info,
        "contract",
        `declared shape ${context.contract.info.key}`,
      );
      const receiverEvidence = definitionExcerpt(input, "after", info, "change", `receiver ${info.key}`);
      // The successful result the receiver did read, then the count it reports:
      // together with the contract, these are the values a partial-failure
      // decision has to weigh against the failure field.
      const successes = observation.reported.filter(entry => !entry.counted).slice(0, 1);
      const counts = observation.reported.filter(entry => entry.counted).slice(0, 1);
      // The count handed back to the caller is what the caller receives, so it
      // leads any count read for a log line.
      const returned = reportedCount(source);
      const unitIds = unitsTouching(input, info);
      const callers = callerEvidence(input, unitIds, info);
      const reported = [
        ...successes.map(entry => ({ label: `read result field ${entry.field} at line ${entry.line}`, entry })),
        ...(returned
          ? [{
              label: `${returned.ofReturn ? "returned" : "reported"} count at line ${returned.line}`,
              entry: returned,
            }]
          : counts.map(entry => ({ label: `reported count ${entry.field} at line ${entry.line}`, entry }))),
      ].map(entry =>
        excerpt({
          role: "related",
          label: entry.label,
          file: info.file,
          line: entry.entry.line,
          ref: input.headRef,
          text: entry.entry.statement,
        }),
      );
      const finding: AutomaticFinding = {
        id: `unused-error-result:${info.file}:${info.line ?? 1}:${context.contract.info.key}.${context.contract.errorField.name}`,
        kind: "unused-error-result",
        title: `Unread ${context.contract.errorField.name} field: ${info.label} holds ${context.contract.info.key} without reading it`,
        scope:
          `${formatSourceLoc(location(info))} in the resulting snapshot holds it as ` +
          holds
            .map(hold =>
              hold.kind === "name"
                ? `\`${hold.name}\` (${hold.via})`
                : `fields { ${hold.fields.join(", ")} } (${hold.via}${hold.rest ? ", with a rest element" : ""})`,
            )
            .join(", ") +
          `. The declared shape ${context.contract.info.key} @ ` +
          `${formatSourceLoc(location(context.contract.info))} contains ${describeFields(context.contract.fields)}.`,
        limitation:
          `This establishes that this receiver's readable body never reads ${context.contract.errorField.name} ` +
          "from that response and never hands the whole response on. It does not establish that any failure " +
          "occurred, that failures are mishandled, or that another consumer is missing. Receivers that return, " +
          "pass, spread, alias, or positionally destructure the response are excluded rather than alleged.",
        unitIds: unitsTouching(input, info),
        evidence: selectEvidence([
          ...(contractEvidence ? [contractEvidence] : []),
          ...(receiverEvidence ? [receiverEvidence] : []),
          ...callers,
          ...reported,
        ]),
      };
      findings.push(finding);
      names.set(finding.id, {
        primary: new Set([`after:${info.key}`]),
        contracts: new Set([`after:${context.contract.info.key}`]),
      });
      facts.primary.add(`after:${info.key}`);
      facts.contracts.add(`after:${context.contract.info.key}`);
      facts.findingIds.add(finding.id);
      for (const unitId of finding.unitIds) facts.unitIds.add(unitId);
      if (contractEvidence) facts.contract.push(contractEvidence);
      if (receiverEvidence) facts.change.push(receiverEvidence);
      facts.related.push(...reported);
      const readFields = observation.reported.length > 0
        ? [...new Set(observation.reported.map(entry => entry.field))].join(", ")
        : "no field of it";
      facts.sentences.push(
        `Changed definition ${info.key} holds ${context.contract.info.key} and reads ${readFields}, ` +
          `but never ${context.contract.errorField.name}.`,
      );
      // The receiver's own callers are what a reader needs beside it.
      facts.caller.push(...callers);
    }
  }

  // Even without a finding, a shape that carries failures into changed code is a
  // question: the change may add the first caller, or the first success report.
  for (const context of contexts) {
    const fields = describeFields(context.contract.fields);
    const participants = [context.contract.info, ...context.producers];
    const touched = participants.flatMap(entry => unitsTouching(input, entry).map(unitId => ({ info: entry, unitId })));
    if (touched.length === 0) continue;
    for (const { unitId } of touched) facts.unitIds.add(unitId);
    for (const info of participants) {
      const role = info === context.contract.info ? "contract" : "change";
      const evidence = definitionExcerpt(
        input,
        "after",
        info,
        role,
        info === context.contract.info ? `declared shape ${info.key}` : `producer ${info.key}`,
      );
      if (!evidence) continue;
      if (role === "contract") facts.contract.push(evidence);
      else facts.change.push(evidence);
    }
    facts.sentences.push(
      `Response shape ${context.contract.info.key} (${fields}) reaches changed code; ` +
        `${context.producers.length === 0 ? "no changed definition was resolved as its producer" : `it is produced by ${context.producers.map(producer => producer.key).join(", ")}`}.`,
    );
  }

  const untyped = [...input.changedFiles].filter(file => {
    const id = detectLanguage(file)?.id;
    return id !== undefined && !Object.hasOwn(TYPED_RESPONSE_LANGUAGES, id);
  }).length;
  return {
    findings,
    facts,
    names,
    check: coverage(
      "unused-error-result",
      skipped > 0 || unreadable > 0 || receivers.length < candidates.length ? "partial" : "checked",
      [
        `${contracts.length} declared response shapes with a failure field and another reported field were in scope ` +
          `for this change (${inScope.length} interface/type declarations: those in changed files, those named by a changed ` +
          `definition, and those returned by a definition a changed definition calls).`,
        `${examined} changed definitions were examined as receivers (the ${Math.min(receivers.length, MAX_RECEIVER_DEFINITIONS)} most relevant of ${candidates.length} callable definitions in the changed files are considered, limit ${MAX_RECEIVER_DEFINITIONS}); ${skipped} were skipped because their source span or fragment was unreadable, and ${unreadable} of those declarations could not be read at all.`,
        `${forwardedCount} receivers hand the whole response on and ${uncertainCount} use it in a way this check cannot follow; both are excluded rather than reported.`,
        `${findings.length} receivers were found holding the response without reading its failure field (report limit ${MAX_FINDINGS_PER_KIND}).`,
        `${untyped} changed files are in another language, and files with no parser at all are not counted, ` +
          "because this check reads only TypeScript interfaces and type aliases. Inside TypeScript, inline object " +
          "literals and shapes reached only through `extends` are outside it too. Calls need lexical or typed-receiver " +
          "bindings and resolved local imports. Alias resolution supports standalone JSON tsconfig files with " +
          "single-target paths; inherited/JSONC configs, package entry points and unresolved bindings remain unproven.",
      ].join(" "),
    ),
  };
}

/** One count a receiver reports, and whether the body returns it. */
interface CountEvidence {
  line: number;
  statement: string;
  ofReturn: boolean;
}

/**
 * The count a receiver reports to its own caller: the first count-named read
 * inside a `return`, and only when the body returns no count, the last
 * count-named read anywhere (a summary log). A returned count is what a caller
 * receives, so it is the number a partial-failure question weighs against the
 * failure field; the statement is carried verbatim either way.
 */
function reportedCount(source: DefinitionSource): CountEvidence | null {
  const syntax = source.syntax;
  const fragment = source.fragment;
  if (!syntax || !fragment) return null;
  const reads = countReads(syntax.definition);
  const inside = returnedCountRead(syntax.definition);
  const read = inside ?? reads[reads.length - 1];
  if (!read) return null;
  return {
    line: absoluteLine(fragment, source, read.read.startPosition.row),
    statement: enclosingStatement(read.read),
    ofReturn: inside !== null,
  };
}

function describeFields(fields: readonly ContractField[]): string {
  return fields.map(field => `${field.name}: ${field.type}`).join(", ");
}

/* ------------------------------------------------------- contract changes */

/** One declaration's declared fields, compared across the two snapshots. */
function compareContractDeclaration(
  input: EvidenceInput,
  facts: FactBucket,
  declaration: ContractDeclaration,
  prior: ContractDeclaration | null,
  edges: readonly TypeContractEdge[],
  removed: boolean,
): void {
  const sentence = removed
    ? `Response shape ${declaration.info.key}, declaring ${describeFields(declaration.fields)}, is gone from this change.`
    : prior
      ? `Response shape ${declaration.info.key} changes its declared fields: ${describeFieldChanges(declaration.fields, prior.fields)}.`
      : `Response shape ${declaration.info.key} is added by this change, declaring ${describeFields(declaration.fields)}.`;
  facts.sentences.push(sentence);
  const role: EvidenceExcerpt["role"] = removed ? "related" : "change";
  const current = definitionExcerpt(
    input,
    removed ? "before" : "after",
    declaration.info,
    role,
    removed ? `removed shape ${declaration.info.key}` : `declared shape ${declaration.info.key}`,
  );
  if (current) (removed ? facts.related : facts.change).push(current);
  if (prior && !removed) {
    const before = definitionExcerpt(input, "before", prior.info, "related", `prior declared shape ${prior.info.key}`);
    if (before) facts.related.push(before);
  }
  // The type-contract relation is a written type reference, not proof that any
  // value is constructed, assigned, or returned here, so it is reported as a
  // reference and never as a write.
  const consumers = [
    ...new Set(
      edges
        .filter(edge => edge.target === declaration.info && input.changedFiles.has(edge.owner.file))
        .map(edge => edge.owner),
    ),
  ].sort(byLocation);
  for (const unitId of unitsTouching(input, declaration.info)) facts.unitIds.add(unitId);
  if (consumers.length === 0) {
    if (declaration.info.exported) {
      facts.sentences.push(
        `No changed definition names ${declaration.info.key} in its source; consumers outside this change may still do so.`,
      );
    }
    return;
  }
  facts.sentences.push(
    `${consumers.length} changed definition${consumers.length === 1 ? "" : "s"} name ${declaration.info.key} ` +
      `(syntactic type reference, not a runtime write): ` +
      `${consumers.slice(0, 3).map(consumer => consumer.key).join(", ")}.`,
  );
  for (const consumer of consumers.slice(0, 2)) {
    const evidence = definitionExcerpt(
      input,
      "after",
      consumer,
      "caller",
      `changed definition ${consumer.key} names ${declaration.info.key}`,
    );
    if (evidence) facts.caller.push(evidence);
    for (const unitId of unitsTouching(input, consumer)) facts.unitIds.add(unitId);
  }
}

function describeFieldChanges(current: readonly ContractField[], prior: readonly ContractField[]): string {
  const added = current.filter(field => !prior.some(before => before.name === field.name)).map(field => field.name);
  const removed = prior.filter(before => !current.some(field => field.name === before.name)).map(before => before.name);
  return [
    added.length > 0 ? `added ${added.join(", ")}` : "",
    removed.length > 0 ? `removed ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Declared contracts this change adds, removes, or edits, with the changed
 * definitions that write them. A declaration whose fields did not change is not
 * listed: the question here is what a consumer must now match.
 */
function contractChangeScan(input: EvidenceInput): FactBucket {
  const facts = factBucket();
  if (!input.after || !input.before) return facts;
  const after = changedContracts(input, "after");
  const before = changedContracts(input, "before");
  const beforeByKey = new Map(before.map(declaration => [declarationKey(declaration), declaration]));
  const afterKeys = new Set(after.map(declarationKey));
  const edges = resolveTypeContracts(allContextDefinitions(input.after));
  for (const declaration of after) {
    if (!intersectsChanged(input, declaration.info)) continue;
    const prior = beforeByKey.get(declarationKey(declaration)) ?? null;
    if (prior && !declaredFieldsDiffer(declaration, prior)) continue;
    compareContractDeclaration(input, facts, declaration, prior, edges, false);
  }
  for (const declaration of before) {
    if (afterKeys.has(declarationKey(declaration))) continue;
    if (!intersectsChanged(input, declaration.info)) continue;
    compareContractDeclaration(input, facts, declaration, null, edges, true);
  }
  return facts;
}

/** Snapshot-local identity of one declaration: file plus symbol name. */
function declarationKey(declaration: ContractDeclaration): string {
  return `${declaration.info.file}\0${declaration.info.key}`;
}

/** Whether two snapshots' declarations of one symbol list different fields. */
function declaredFieldsDiffer(current: ContractDeclaration, prior: ContractDeclaration): boolean {
  return (
    current.fields.some(field => !prior.fields.some(before => before.name === field.name)) ||
    prior.fields.some(before => !current.fields.some(field => field.name === before.name))
  );
}

/* -------------------------------------------- lifecycle at external writes */

interface WriteSite {
  line: number;
  endLine: number;
  source: string;
  text: string;
  tokens: string[];
}

/**
 * Whether a call name writes state: one of the first two camel-case words of
 * its last segment is a word from {@link WRITE_VERBS}. So `updateLease`,
 * `bulkCreate`, `createOrUpdate`, and `upsertResident` write, while
 * `logger.log`, `queue.add`, and `findByTenantId` do not. The second word is
 * read because a modifier commonly leads the verb (`bulkCreate`).
 */
function isWriteCall(name: string): boolean {
  const segment = name.slice(name.lastIndexOf(".") + 1).replace(/\(.*$/, "");
  if (segment === "" || segment === "add") return false;
  const words = segment.match(/^[a-z][a-z0-9]*|[A-Z]+(?![a-z])|[A-Z][a-z0-9]*/g) ?? [segment];
  return words.slice(0, 2).some(word => Object.hasOwn(WRITE_VERBS, word.toLowerCase()));
}

/**
 * Lifecycle/state values this change writes at an external boundary: an emit
 * site, a call whose name writes state, or a state-named field written in the
 * body, together with the constants the write carries. The entry is a question,
 * so a write whose constants live behind the callee still surfaces as "the
 * values written here are not visible in this change".
 */
function lifecycleScan(input: EvidenceInput): FactBucket {
  const facts = factBucket();
  const after = input.after;
  if (!after) return facts;
  const definitions = allContextDefinitions(after);
  const enums = definitions.filter(info => info.review?.kind === "enum");
  const dispatch = resolveDispatchContext(definitions).map(edge => ({
    owner: edge.owner,
    target: edge.target,
  }));
  const tests = new Map<string, EvidenceExcerpt | null>();
  const answered = new Set<string>();
  for (const { unit, lines } of input.changes) {
    if (lines.length === 0) continue;
    const inFile = definitions.filter(info => !info.review?.kind && info.file === unit.file).sort(byLocation);
    for (const info of hunkDefinitions(inFile, lines)) {
      // A definition spanning several hunks is one question, asked once.
      if (answered.has(`${info.file}\0${info.key}\0${info.line}`)) continue;
      answered.add(`${info.file}\0${info.key}\0${info.line}`);
      const source = definitionSource(input, "after", info);
      // Without a parsed body there is no site to read state from, so this
      // definition asks no question rather than a question about nothing.
      const syntax = source.syntax;
      const fragment = source.fragment;
      if (!syntax || !fragment) continue;
      // State is read from each write call's own argument AST in the definition's
      // source, not from the capped argument text and not from a routing key: a
      // queue job name is a routing value even though it is a constant.
      const writes: WriteSite[] = callsIn(syntax.definition)
        .map(call => ({
          call,
          callee: call.childForFieldName("function")?.text ?? "",
        }))
        .filter(({ callee }) => isWriteCall(callee))
        .map(({ call, callee }) => ({
          line: absoluteLine(fragment, source, call.startPosition.row),
          endLine: absoluteLine(fragment, source, call.endPosition.row),
          source: call.text,
          text: collapseWs(callee),
          tokens: stateWritesAt(call),
        }));
      const emits = (info.review?.dispatches ?? []).filter(record => record.direction === "emit");
      if (writes.length === 0 && emits.length === 0) continue;
      // A dispatched event is a boundary write too. Its payload properties carry
      // state the same way a call's arguments do, so the emit's own AST is read.
      const emitSites: WriteSite[] = emits.map(record => {
        const call = callsIn(syntax.definition).find(
          candidate => absoluteLine(fragment, source, candidate.startPosition.row) === record.line,
        );
        return {
          line: record.line,
          endLine: call ? absoluteLine(fragment, source, call.endPosition.row) : record.line,
          source: call?.text ?? record.evidence,
          text: record.evidence,
          tokens: call ? stateWritesAt(call) : [],
        };
      });
      const sites = [...writes, ...emitSites];
      const stateSite = sites.find(entry => entry.tokens.length > 0);
      if (!stateSite) continue;
      const names = new Set(stateSite.tokens.map(token => /^[\w$]+:\s*([\w$]+)\.[\w$]+$/u.exec(token)?.[1]));
      const shadowed = declaredValueNames(syntax.definition);
      const constants = enums.find(candidate => {
        if (!names.has(candidate.key) || shadowed.has(candidate.key)) return false;
        if (candidate.file === info.file) return true;
        const specifier = importsOf(input, source)?.get(candidate.key);
        return specifier !== undefined && input.resolveImport(info.file, specifier) === candidate.file;
      });
      // The site that carries state leads: a queue routing key written earlier
      // must not hide a later status assignment, and its tokens belong to it.
      const site = stateSite;
      const tokens = site.tokens;
      facts.unitIds.add(unit.id);
      facts.primary.add(`after:${info.key}`);
      facts.change.push(excerpt({
        role: "change",
        label: `state/status call in ${info.key} at line ${site.line}`,
        file: info.file,
        line: site.line,
        endLine: site.endLine,
        ref: input.headRef,
        text: site.source,
      }));
      if (constants) {
        const evidence = definitionExcerpt(
          input,
          "after",
          constants,
          "contract",
          `lifecycle constants ${constants.key}`,
        );
        // One constants excerpt per entry; a second enum declaration adds no
        // value beside the write it belongs to.
        if (evidence && !facts.contract.some(kept => kept.id === evidence.id)) facts.contract.push(evidence);
      }
      const counterpart = dispatchCounterpart(input, info, dispatch, emits.length > 0);
      if (counterpart) facts.related.push(counterpart);
      facts.caller.push(...callerEvidence(input, [unit.id], info));
      if (!tests.has(info.key)) tests.set(info.key, supportingTest(input, definitions, info));
      const test = tests.get(info.key);
      if (test) facts.test.push(test);
      facts.sentences.push(
        `Changed definition ${info.key} passes state/status values to a write-shaped call (${site.text}); ` +
          (tokens.length > 0
            ? `lifecycle/state values written here: ${tokens.join(", ")}.`
            : `it carries the lifecycle constants of ${constants?.key ?? "a declared enum"}, none of which are written at this site.`),
      );
    }
  }
  return facts;
}

/* ------------------------------------------------------------- the agenda */

interface FactBucket {
  sentences: string[];
  unitIds: Set<string>;
  findingIds: Set<string>;
  /** Context-node keys of definitions this entry is about first, e.g. a receiver. */
  primary: Set<string>;
  /** Context-node keys of the declared contracts this entry is about. */
  contracts: Set<string>;
  contract: EvidenceExcerpt[];
  change: EvidenceExcerpt[];
  related: EvidenceExcerpt[];
  caller: EvidenceExcerpt[];
  test: EvidenceExcerpt[];
}

function factBucket(): FactBucket {
  return {
    sentences: [],
    unitIds: new Set(),
    findingIds: new Set(),
    primary: new Set(),
    contracts: new Set(),
    contract: [],
    change: [],
    related: [],
    caller: [],
    test: [],
  };
}

function agendaEntry(
  input: EvidenceInput,
  facts: FactBucket,
  title: string,
  key: string,
): ReviewAgendaEntry | null {
  if (facts.sentences.length === 0) return null;
  return {
    id: `agenda:${key}`,
    title,
    reason: factsText(facts.sentences),
    priority: 0,
    unitIds: [...facts.unitIds].sort(),
    findingIds: [...facts.findingIds].sort(),
    evidence: selectEvidence([
      ...facts.contract,
      ...facts.change,
      ...facts.related,
      ...facts.caller,
      ...facts.test,
    ]),
    context: selectContext(input, facts.unitIds, facts.primary, facts.contracts, facts.caller),
  };
}

/** The definitions one finding is about, as context-node keys. */
interface FindingSubject {
  primary: ReadonlySet<string>;
  contracts: ReadonlySet<string>;
}

/** One finding's agenda entry, with the nodes that finding is about beside it. */
function findingEntry(
  input: EvidenceInput,
  finding: AutomaticFinding,
  subject: FindingSubject,
): ReviewAgendaEntry {
  return {
    id: `agenda:finding:${finding.id}`,
    title: `Check before concluding: ${finding.title}`,
    reason: `${finding.scope} ${finding.limitation}`,
    priority: 0,
    unitIds: finding.unitIds,
    findingIds: [finding.id],
    evidence: selectEvidence(finding.evidence),
    context: selectContext(input, new Set(finding.unitIds), subject.primary, subject.contracts, finding.evidence.filter(entry => entry.role === "caller")),
  };
}

/** A late entry: which automatic checks did not run, and why not. */
function coverageEntry(checks: readonly CheckCoverage[]): ReviewAgendaEntry | null {
  const open = checks.filter(check => check.status !== "checked");
  if (open.length === 0) return null;
  return {
    id: "agenda:check-scope",
    title: "Which automatic checks did not run, and what stays unverified?",
    reason: `${open.map(check => `${check.kind}: ${check.status}`).join("; ")}. Read “Checks and their limits” for exact scope; an unrun check is not a pass.`,
    priority: 0,
    unitIds: [],
    findingIds: [],
    evidence: [],
    context: [],
  };
}

/**
 * Hunks no structural question reached, grouped per file: the agenda never
 * drops a change, so an unevaluated, metadata-only, or unremarkable hunk stays
 * addressable with its own diff.
 */
function hunkCoverageEntries(input: EvidenceInput, covered: ReadonlySet<string>): ReviewAgendaEntry[] {
  const byFile = new Map<string, UnitChange[]>();
  for (const change of input.changes) {
    if (covered.has(change.unit.id)) continue;
    const existing = byFile.get(change.unit.file);
    if (existing) existing.push(change);
    else byFile.set(change.unit.file, [change]);
  }
  const entries: ReviewAgendaEntry[] = [];
  for (const [file, changes] of byFile) {
    entries.push({
      id: `agenda:hunks:${file}`,
      title: `Read the remaining changes in ${file}`,
      reason:
        `${changes.length} changed hunk${changes.length === 1 ? "" : "s"} in this file ` +
        `${changes.length === 1 ? "is" : "are"} not covered by a structural question above: ` +
        changes
          .map(change =>
            change.unit.special
              ? `metadata-only (${change.unit.special})`
              : `${change.unit.header.split(" @@")[0]} @@ (added ${change.unit.added}, removed ${change.unit.removed})`,
          )
          .join("; ") +
        ". The report's own diff for these hunks is the full text; the excerpts here identify them.",
      priority: 0,
      unitIds: changes.map(change => change.unit.id),
      findingIds: [],
      evidence: selectEvidence(changes.map(change => unitExcerpt(input, change.unit)), MAX_HUNK_EXCERPTS),
      context: selectContext(input, new Set(changes.map(change => change.unit.id)), EMPTY_SUBJECT.primary, EMPTY_SUBJECT.contracts),
    });
  }
  return entries;
}

/** Whether the partial-failure entry's own units already carry this finding. */
function linkedByFailureEntry(scan: EvidenceScan, finding: AutomaticFinding): boolean {
  if (finding.kind === "unused-error-result") return true;
  return scan.lifecycleFacts.findingIds.has(finding.id);
}

/**
 * The reading agenda in a fixed order: failure-result accounting first, then
 * lifecycle/state mapping at external boundaries, then declared-shape changes,
 * then the automatic findings, then what was not checked, then every hunk no
 * question reached. Priorities are the resolved ranks, so the order is stable
 * and does not depend on the order the input arrived in.
 */
function buildAgenda(input: EvidenceInput, scan: EvidenceScan): ReviewAgendaEntry[] {
  const drafted = [
    agendaEntry(
      input,
      scan.failureFacts,
      "Partial failure: what does this change report when only some items succeed?",
      "partial-failure",
    ),
    agendaEntry(
      input,
      scan.lifecycleFacts,
      "Lifecycle state: which state values does this change write at its external boundaries, and do the constants match the mapping that is stored?",
      "external-write",
    ),
    agendaEntry(
      input,
      scan.contractFacts,
      "Response shapes: which consumers must change with the shapes this change adds, removes, or edits?",
      "contract-change",
    ),
    // A finding the partial-failure entry already links needs no second card:
    // that entry states its scope, limit, and evidence beside the response it is
    // about. Findings nothing else links still get their own entry.
    ...scan.findings
      .filter(finding => !linkedByFailureEntry(scan, finding))
      .map(finding =>
        findingEntry(input, finding, scan.findingNames.get(finding.id) ?? EMPTY_SUBJECT),
      ),
    coverageEntry(scan.checks),
  ].filter((entry): entry is ReviewAgendaEntry => entry !== null);
  const covered = new Set(drafted.flatMap(entry => entry.unitIds));
  // Priority is a 0..100 review priority, higher first, in the same direction as
  // `ReviewItem.priority`: the fixed order above is the ranking, and this field
  // is that rank expressed on the report's own scale. Array order stays the
  // authority for reading order, exactly as the renderer treats it.
  const entries = [...drafted, ...hunkCoverageEntries(input, covered)];
  entries.forEach((entry, index) => {
    entry.priority = Math.max(0, 100 - index);
  });
  return entries;
}

/* --------------------------------------------------------------- assembly */

interface EvidenceScan {
  findings: AutomaticFinding[];
  checks: CheckCoverage[];
  failureFacts: FactBucket;
  lifecycleFacts: FactBucket;
  contractFacts: FactBucket;
  /** Context keys each finding is about, so its entry shows those nodes first. */
  findingNames: Map<string, FindingSubject>;
}

/** Why newly broken references are not checked here, in the reader's terms. */
function brokenReferenceCheck(input: EvidenceInput): CheckCoverage {
  if (!input.after) return coverage("broken-reference", "not-checked", PATCH_REASON);
  if (!input.before) {
    return coverage(
      "broken-reference",
      "not-checked",
      "No prior-snapshot index was supplied, so a newly broken reference could not be separated from a " +
        "pre-existing one.",
    );
  }
  return coverage(
    "broken-reference",
    "not-checked",
    "No trusted project-checker result was supplied for the prior and resulting revisions, and a parser plus a " +
      "syntactic call graph is not a type checker. Newly broken imports and calls are therefore not compared here; " +
      "that safe before/after diagnostic comparison is a separate step, and until its output is available this check " +
      "reports neither breakage nor absence of breakage.",
  );
}

/**
 * Automatic findings, check coverage, and the review agenda for one diff. Main
 * calls this inside the index callback with the same snapshots it renders, so
 * every excerpt names the revision it came from; a call without indexes or
 * without source readers still returns an agenda over the hunks, with each
 * check honestly not checked.
 */
export function buildReviewEvidence(
  units: readonly ReviewUnit[],
  options: ReviewEvidenceOptions = {},
): ReviewEvidenceResult {
  const input = evidenceInput(units, options);
  const scan: EvidenceScan = {
    findings: [],
    checks: [],
    failureFacts: factBucket(),
    lifecycleFacts: factBucket(),
    contractFacts: factBucket(),
    findingNames: new Map(),
  };
  if (!input.after || !input.sources.after) {
    scan.checks.push(
      coverage("unused-error-result", "not-checked", input.after ? SOURCE_REASON : PATCH_REASON),
      coverage("duplicate-body", "not-checked", input.after ? SOURCE_REASON : PATCH_REASON),
      brokenReferenceCheck(input),
    );
    return { findings: [], checks: scan.checks, agenda: buildAgenda(input, scan) };
  }
  const responses = responseScan(input);
  const duplicates = duplicateScan(input);
  scan.findings.push(...responses.findings, ...duplicates.findings);
  scan.failureFacts = responses.facts;
  scan.findingNames = responses.names;
  scan.contractFacts = contractChangeScan(input);
  scan.lifecycleFacts = lifecycleScan(input);
  scan.checks.push(responses.check, duplicates.check, brokenReferenceCheck(input));
  scan.findings.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
  return { findings: scan.findings, checks: scan.checks, agenda: buildAgenda(input, scan) };
}
