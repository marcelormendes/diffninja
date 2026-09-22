/**
 * Deterministic broken-reference check.
 *
 * Runs the TypeScript compiler that the *opted-in* project installed itself —
 * `ReviewOptions.referenceProject`, a repository-relative `tsconfig.json` — over
 * both revisions of the repository, each materialized whole into a temporary
 * directory, and reports the errors the head revision has and the base revision
 * does not. Errors are matched by content, not by line, so a pre-existing error
 * that merely shifted is not re-reported as introduced.
 *
 * Each revision's *own* `tsconfig.json` is parsed from its snapshot, and
 * `createProgram` receives TypeScript's own resolved root file list with the
 * project's own options and normal module resolution: no hand-rolled specifier
 * resolution, no partial materialization, no diagnostic suppression.
 *
 * Safety model:
 *
 * - The repository is read with git plumbing only (`rev-parse`, `ls-tree`,
 *   `cat-file`): no checkout, no index or working-tree write, no hook, no npm
 *   script, and nothing the pull request defines is executed.
 * - Files are written only into a fresh directory under the OS temp directory,
 *   only from repository-relative paths with no `..`/absolute/backslash/NUL and
 *   no `node_modules` segment, and only for regular-file blob modes. A symbolic
 *   link or submodule anywhere in the revision, an oversized file, or an
 *   exceeded budget reports not-checked: emulating a resolution the revision
 *   does not have would manufacture an error.
 * - Dependencies are the repository's *existing* installed `node_modules`,
 *   mirrored read-only into each snapshot per directory so Node's own resolution
 *   finds what the real checkout finds. Nothing is installed, no real
 *   `node_modules` entry is ever written through, no emit or build runs, and
 *   `createProgram` never loads a config `plugins` entry.
 * - Configuration that reaches outside the snapshot (an absolute or escaping
 *   `extends`, a `paths` target, an input file, or a package config whose
 *   resolution leaves the snapshot) is refused rather than followed, and a
 *   program that read any file outside the snapshot, the installed
 *   dependencies, and the compiler's own libraries is discarded before its
 *   diagnostics are published.
 * - A missing compiler, a missing or invalid configuration, unsupported project
 *   references, uninstalled dependencies, and any revision whose error count
 *   exceeds the comparison bound all report not-checked with the reason. The
 *   check never reports passed, and an empty finding list is never a claim that
 *   the project compiles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";
import { z } from "zod";
import type { AutomaticFinding, CheckCoverage, EvidenceExcerpt } from "./evidence-types.js";
import type { ReviewUnit } from "./types.js";

/**
 * The installed compiler's API surface this check uses. `typescript` is loaded
 * by name from the opted-in project at runtime, so the surface is declared here
 * instead of importing a runtime dependency this package does not have.
 */
interface CompilerApi {
  version: string;
  sys: TypeScript.System;
  ModuleResolutionKind: typeof TypeScript.ModuleResolutionKind;
  readConfigFile(
    fileName: string,
    readFile: (path: string) => string | undefined,
  ): { config?: unknown; error?: TypeScript.Diagnostic };
  parseJsonConfigFileContent(
    json: TypeScript.ParsedCommandLine["raw"],
    host: TypeScript.ParseConfigHost,
    basePath: string,
    existingOptions?: TypeScript.CompilerOptions,
    configFileName?: string,
  ): TypeScript.ParsedCommandLine;
  resolveModuleName(
    moduleName: string,
    containingFile: string,
    compilerOptions: TypeScript.CompilerOptions,
    host: TypeScript.ModuleResolutionHost,
  ): TypeScript.ResolvedModuleWithFailedLookupLocations;
  createProgram(createProgramOptions: TypeScript.CreateProgramOptions): TypeScript.Program;
  getPreEmitDiagnostics(program: TypeScript.Program): readonly TypeScript.Diagnostic[];
  flattenDiagnosticMessageText(
    diag: string | TypeScript.DiagnosticMessageChain | undefined,
    newLine: string,
  ): string;
}

export interface ReferenceCheckResult {
  findings: AutomaticFinding[];
  check: CheckCoverage;
}

/**
 * Diagnostics that state a reference does not resolve. The set is closed: type
 * mismatches, unused locals, argument counts, and syntax errors are out of
 * scope, so a negative result is a statement about these codes only.
 */
const UNRESOLVED_CODES: ReadonlySet<number> = new Set([
  2304, // Cannot find name
  2305, // Module has no exported member
  2307, // Cannot find module
  2339, // Property does not exist on type
  2503, // Cannot find namespace
  2551, // Property does not exist on type; did you mean ...
  2552, // Cannot find name; did you mean ...
  7016, // Could not find a declaration file for module
]);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** Per-revision unresolved-reference errors above which the comparison is refused. */
const MAX_DIAGNOSTICS = 500;
/** Tracked manifests whose declared dependencies are checked before comparing. */
const MAX_MANIFESTS = 200;
/** Declared dependency names beyond which the install layout is judged irreproducible. */
const MAX_DECLARED = 2_000;
const MAX_FINDINGS = 50;
const MAX_MESSAGE_CHARS = 240;
const GIT_MAX_BYTES = 64 * 1024 * 1024;

const LIMITATION =
  "Diagnostic comparison against the repository's currently installed dependencies: no emit, build, or test runs, so this bounds only these error codes in these two revisions and is not evidence that the project builds or that the change is safe.";

/** `extends` written as a single string or an array; the boundary normalizes both. */
const EXTENDS = z.union([z.string(), z.array(z.string())])
  .transform(value => (Array.isArray(value) ? value : [value]))
  .optional();
const extendsSchema = z.object({ extends: EXTENDS }).catchall(z.unknown());

interface TreeEntry {
  mode: string;
  size: number;
}

interface Snapshot {
  rev: string;
  root: string;
  tree: ReadonlyMap<string, TreeEntry>;
  /** Directories the revision tracks a file in, with ancestors; `"."` is the root. */
  dirs: ReadonlySet<string>;
}

interface Plan {
  ts: CompilerApi;
  compilerEntry: string;
  repoRoot: string;
  /** Repository-relative path of the opted-in tsconfig, identical in both revisions. */
  projectRel: string;
  headSha: string;
  /** Real directories a program may read besides snapshot content; filled as links are made. */
  trustedRoots: string[];
  unitsByFile: ReadonlyMap<string, string[]>;
  notes: Set<string>;
  truncated: boolean;
}

interface Located {
  file: string;
  line: number;
  code: number;
  message: string;
  lineText: string;
}

interface ManifestFields {
  dependencies?: TypeScript.MapLike<string>;
  devDependencies?: TypeScript.MapLike<string>;
  peerDependencies?: TypeScript.MapLike<string>;
  optionalDependencies?: TypeScript.MapLike<string>;
}

interface CompilerSelection {
  ts: CompilerApi;
  /** Absolute path the compiler module was loaded from, for coverage provenance. */
  entry: string;
}

/** A condition under which the check must report not-checked, never passed. */
class Unavailable extends Error {}

export async function checkReferences(
  repo: string,
  base: string,
  head: string,
  units: readonly ReviewUnit[],
  project: string,
): Promise<ReferenceCheckResult> {
  const repoRoot = resolve(repo);
  const projectSpec = project.trim();
  try {
    if (projectSpec === "") fail("Reference checking was requested without a reference project.");
    if (isAbsolute(projectSpec) || projectSpec.includes("\0")) {
      fail(
        `referenceProject must be a repository-relative tsconfig path; ${JSON.stringify(projectSpec)} is not, so no trusted project configuration was selected.`,
      );
    }
    const configPath = resolve(repoRoot, projectSpec);
    const projectRel = repoRelative(repoRoot, configPath);
    if (!within(repoRoot, configPath) || !isRegularFile(configPath)) {
      fail(
        `The reference project ${JSON.stringify(projectSpec)} is not a file inside the repository, so its installed checker and configuration cannot be used.`,
      );
    }
    const baseSha = resolveCommit(repoRoot, base);
    const headSha = resolveCommit(repoRoot, head);
    const compiler = loadCompiler(dirname(configPath), repoRoot);
    const plan: Plan = {
      ts: compiler.ts,
      compilerEntry: compiler.entry,
      repoRoot,
      projectRel,
      headSha,
      trustedRoots: [realpathSync(dirname(compiler.entry))],
      unitsByFile: unitsByFile(units),
      notes: new Set(),
      truncated: false,
    };

    // `realpath` keeps the isolated root on the physical path: the OS temp
    // directory is itself a symlink on macOS, and a mismatched root would make
    // every snapshot path look external and silently drop every diagnostic.
    const isolated = realpathSync(mkdtempSync(join(tmpdir(), "diffninja-reference-")));
    const links: string[] = [];
    try {
      if (within(repoRoot, isolated)) {
        fail("The operating system temporary directory is inside the reviewed repository, so an isolated snapshot cannot be guaranteed.");
      }
      const baseTree = readTree(repoRoot, baseSha);
      const headTree = readTree(repoRoot, headSha);
      if (!baseTree.has(projectRel) || !headTree.has(projectRel)) {
        fail(`The reference project ${projectRel} is not present in both compared revisions, so there is no pair of configurations to compare.`);
      }
      const baseSnapshot = materialize(plan, baseTree, baseSha, join(isolated, "base"));
      const headSnapshot = materialize(plan, headTree, headSha, join(isolated, "head"));
      const snapshots = [baseSnapshot, headSnapshot];
      for (const snapshot of snapshots) {
        const unresolved = mirrorInstalls(plan, snapshot, links);
        if (unresolved.length === 0) continue;
        fail(
          `Revision ${short(snapshot.rev)} has ${unresolved.length} declared dependenc${unresolved.length === 1 ? "y" : "ies"} that Node cannot resolve from its own directory — ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ", …" : ""}. The install layout cannot be reproduced faithfully, so an unresolved import could not be distinguished from a missing install; no findings are reported.`,
        );
      }
      const baseDiagnostics = revisionDiagnostics(plan, baseSnapshot);
      const headDiagnostics = revisionDiagnostics(plan, headSnapshot);
      const introduced = introducedOnly(baseDiagnostics, headDiagnostics);
      const reported = introduced.slice(0, MAX_FINDINGS);
      if (introduced.length > reported.length) {
        plan.truncated = true;
        plan.notes.add(`${introduced.length - reported.length} further introduced reference(s) beyond the ${MAX_FINDINGS} reported`);
      }
      const findings = reported.map((item, index) => findingFor(plan, item, index + 1));
      if (findings.some(finding => finding.unitIds.length === 0)) {
        plan.notes.add("finding(s) in files this diff does not change, so they carry no changed unit");
      }
      return {
        findings,
        check: {
          kind: "broken-reference",
          status: plan.truncated ? "partial" : "checked",
          detail: coverageDetail(plan, baseSha, headSha, baseDiagnostics, headDiagnostics, introduced.length, findings.length),
        },
      };
    } finally {
      // Unlink every mirror explicitly before removing the temp root, so no
      // walk can follow a link into the repository's real node_modules.
      for (const link of links) unlinkSync(link);
      rmSync(isolated, { recursive: true, force: true });
    }
  } catch (error) {
    // Narrowing in place: an unknown thrown value is never passed on as prose.
    const reason = error instanceof Unavailable
      ? error.message
      : `The reference check failed before it could report: ${error instanceof Error ? error.message : String(error)}`;
    return notChecked(reason);
  }
}

function fail(reason: string): never {
  throw new Unavailable(reason);
}

function notChecked(reason: string): ReferenceCheckResult {
  return {
    findings: [],
    check: { kind: "broken-reference", status: "not-checked", detail: reason },
  };
}

/**
 * The opted-in project's own installed compiler. Loading it is the trust
 * boundary the user opened by naming the project: it is the only package that
 * is required, and resolution starts at the project directory.
 */
function loadCompiler(projectDir: string, repoRoot: string): CompilerSelection {
  for (const dir of projectDir === repoRoot ? [projectDir] : [projectDir, repoRoot]) {
    const require = createRequire(join(dir, "package.json"));
    let entry: string;
    try {
      entry = require.resolve("typescript");
    } catch {
      continue;
    }
    try {
      // SAFETY: `typescript` resolved from the opted-in project is the trusted
      // compiler by contract; a package that cannot serve as one throws here
      // and the check reports not-checked instead of substituting a checker.
      const ts = require(entry) as CompilerApi;
      if (ts.version !== undefined && ts.sys !== undefined) return { ts, entry };
    } catch {
      continue;
    }
  }
  fail(
    `No installed TypeScript compiler was found for the reference project (looked from ${projectDir} and ${repoRoot}). Install it there or omit referenceProject; the check never falls back to an unverified compiler.`,
  );
}

/** Materialize one revision whole, or report not-checked and materialize nothing. */
function materialize(plan: Plan, tree: ReadonlyMap<string, TreeEntry>, rev: string, root: string): Snapshot {
  mkdirSync(root, { recursive: true });
  if (tree.size > MAX_FILES) {
    fail(`The revision ${short(rev)} tracks ${tree.size} files, exceeding the bounded whole-snapshot materialization budget of ${MAX_FILES}.`);
  }
  let bytes = 0;
  for (const [path, entry] of tree) {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      fail(
        `The revision ${short(rev)} tracks a symbolic link or submodule (${path}), which this check does not materialize. Its resolution cannot be reproduced faithfully, so no reference result is reported.`,
      );
    }
    const safe = safeRepoPath(path);
    const target = safe === null ? null : join(root, safe);
    if (target === null || !within(root, target)) {
      fail(`The revision ${short(rev)} tracks a path unsafe to materialize (${JSON.stringify(path)}), so the snapshot cannot be trusted.`);
    }
    if (entry.size > MAX_FILE_BYTES || bytes + entry.size > MAX_TOTAL_BYTES) {
      fail(`The revision ${short(rev)} exceeds the bounded whole-snapshot materialization budget (${MAX_FILE_BYTES} bytes/file, ${MAX_TOTAL_BYTES} bytes total).`);
    }
    const blob = git(plan.repoRoot, ["cat-file", "blob", `${rev}:${path}`]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blob);
    bytes += blob.length;
  }
  // Resolution follows the *importing file*, so a nested install anywhere the
  // revision tracks a file can serve an import the project directory cannot.
  const dirs = new Set<string>(["."]);
  for (const path of tree.keys()) {
    for (let dir = posix.dirname(path); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) dirs.add(dir);
  }
  return { rev, root, tree, dirs };
}

/**
 * Mirror the repository's existing installed dependencies into the snapshot,
 * one directory per tracked directory, so Node's own resolution from any
 * tracked file finds exactly what the real checkout finds. Nothing is installed,
 * nothing is copied, and no real `node_modules` is ever written through.
 *
 * Returns declared dependency names that Node cannot resolve by climbing from
 * their own manifest directory. Node would not resolve them from there in the
 * real checkout either — the install is missing or lives in a layout (such as a
 * sibling workspace) that a per-directory mirror cannot reproduce — so the
 * revision is refused instead of reporting an import this check cannot judge.
 */
function mirrorInstalls(plan: Plan, snapshot: Snapshot, links: string[]): string[] {
  const unresolved = new Set<string>();
  let manifests = 0;
  let declared = 0;
  for (const dir of [...snapshot.dirs].sort()) {
    const realDir = join(plan.repoRoot, dir);
    const names = declaredNames(snapshot, dir);
    if (names !== null) {
      manifests += 1;
      declared += names.length;
      if (manifests > MAX_MANIFESTS || declared > MAX_DECLARED) {
        fail(
          `The revision ${short(snapshot.rev)} has more than ${MAX_MANIFESTS} manifests or ${MAX_DECLARED} declared dependencies, beyond the install layout this check reproduces faithfully.`,
        );
      }
      for (const name of names) {
        if (installedFrom(plan.repoRoot, realDir, name)) continue;
        const elsewhere = findInstalled(plan, snapshot, name);
        unresolved.add(
          elsewhere === null
            ? `${name} (not installed)`
            : `${name} (installed only at ${repoRelative(plan.repoRoot, dirname(dirname(elsewhere)))})`,
        );
      }
    }
    const realModules = join(realDir, "node_modules");
    if (!existsSync(realModules)) continue;
    const target = join(snapshot.root, dir, "node_modules");
    if (existsSync(target)) continue;
    linkInto(plan, links, realModules, target);
  }
  return [...unresolved].sort();
}

/**
 * One read-only symlink, recorded for cleanup. The linked directory itself is
 * the only path this makes readable: trusting its parent would expose the whole
 * live checkout (for a repository-root install, its parent is the repository).
 */
function linkInto(plan: Plan, links: string[], source: string, target: string): void {
  const real = realpathSync(source);
  symlinkSync(real, target, "dir");
  links.push(target);
  if (!plan.trustedRoots.includes(real)) plan.trustedRoots.push(real);
}

/** Node's own upward resolution: `node_modules` in each directory up to the repository root. */
function installedFrom(repoRoot: string, dir: string, name: string): boolean {
  for (let current = dir; ; ) {
    if (existsSync(join(current, "node_modules", name, "package.json"))) return true;
    const parent = dirname(current);
    if (current === repoRoot || parent === current || !within(repoRoot, parent)) return false;
    current = parent;
  }
}

/** An installed copy anywhere in the repository, for a dependency this directory cannot reach. */
function findInstalled(plan: Plan, snapshot: Snapshot, name: string): string | null {
  for (const dir of [...snapshot.dirs].sort()) {
    const candidate = join(plan.repoRoot, dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/** Dependency names a tracked manifest at `dir` declares, or null when it has none. */
function declaredNames(snapshot: Snapshot, dir: string): string[] | null {
  const path = join(snapshot.root, dir, "package.json");
  if (!isRegularFile(path)) return null;
  let manifest: ManifestFields;
  try {
    // SAFETY: package.json is untrusted repository data; only dependency names
    // are read from it, and an unreadable shape yields no declared names.
    manifest = JSON.parse(readFileSync(path, "utf8")) as ManifestFields;
  } catch {
    return null;
  }
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
}

/** One `createProgram` for the revision's own configuration, no emit, no plugins. */
function revisionDiagnostics(plan: Plan, snapshot: Snapshot): Located[] {
  const { ts } = plan;
  const revision = short(snapshot.rev);
  const configPath = join(snapshot.root, plan.projectRel);
  const host = boundedHost(plan, snapshot);
  const read = ts.readConfigFile(configPath, host.readFile);
  if (read.error !== undefined) {
    fail(`The reference project ${plan.projectRel} could not be read at ${revision}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  }
  // The `extends` chain is validated *before* parsing, because parsing is what
  // reads an inherited configuration: a chain pointing at the live machine must
  // be refused, never followed.
  const inherited = extendsEscape(plan, snapshot, host, configPath, 0);
  if (inherited !== null) {
    fail(`The reference project ${plan.projectRel} at ${revision} resolves inputs outside the isolated snapshot (${inherited}), so it was not read and no diagnostics were reported.`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, host, dirname(configPath), undefined, configPath);
  const error = parsed.errors[0];
  if (error !== undefined) {
    fail(`The reference project ${plan.projectRel} has a configuration error at ${revision}, so its options are not trustworthy: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  }
  if ((parsed.projectReferences?.length ?? 0) > 0) {
    fail(`The reference project ${plan.projectRel} uses project references at ${revision}, which this single-configuration check does not build. Point referenceProject at the referenced project's own tsconfig.`);
  }
  const escape = outsideSnapshot(configPath, parsed, snapshot.root);
  if (escape !== null) {
    fail(`The reference project ${plan.projectRel} at ${revision} resolves inputs outside the isolated snapshot (${escape}), so its configuration was not trusted and no diagnostics were reported.`);
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const breach = confinementBreach(plan, snapshot, program);
  if (breach !== null) {
    fail(`The program for ${revision} read ${breach}, which is neither snapshot content, an installed dependency, nor a compiler library. A source file outside the revision cannot be judged against it, so no diagnostics were reported.`);
  }
  return collectDiagnostics(plan, snapshot, program);
}

/**
 * A host that answers only for snapshot content, the installed dependencies,
 * and the compiler's own libraries. Passing it to config parsing and module
 * resolution is the backstop for `extends` chains, including package-provided
 * configs: a read that would leave that boundary fails as missing rather than
 * importing live machine state into the revision.
 */
function boundedHost(plan: Plan, snapshot: Snapshot): TypeScript.ParseConfigHost {
  const allowed = (path: string): boolean => confined(plan, snapshot.root, path);
  return {
    useCaseSensitiveFileNames: plan.ts.sys.useCaseSensitiveFileNames,
    readFile: path => (allowed(path) ? plan.ts.sys.readFile(path) : undefined),
    fileExists: path => allowed(path) && plan.ts.sys.fileExists(path),
    readDirectory: (...args) => plan.ts.sys.readDirectory(...args),
    directoryExists: path => plan.ts.sys.directoryExists(path),
    getDirectories: path => plan.ts.sys.getDirectories(path),
  };
}

/**
 * Configuration that reaches outside the snapshot: an input file or a
 * resolution root. Any of these would make the program read live machine state
 * instead of the revision, so the revision is refused rather than checked
 * against files it does not contain.
 */
function outsideSnapshot(configPath: string, parsed: TypeScript.ParsedCommandLine, root: string): string | null {
  const configDir = dirname(configPath);
  const escapedFile = parsed.fileNames.find(name => !within(root, name));
  if (escapedFile !== undefined) return `file ${escapedFile}`;
  // SAFETY: `pathsBasePath` is set by parseJsonConfigFileContent but is absent
  // from the public CompilerOptions type; it decides where `paths` resolve.
  const internal = parsed.options as TypeScript.CompilerOptions & { pathsBasePath?: string };
  const roots = [parsed.options.baseUrl, internal.pathsBasePath, ...(parsed.options.typeRoots ?? []), ...(parsed.options.rootDirs ?? [])];
  for (const value of roots) {
    if (value !== undefined && !within(root, resolve(configDir, value))) return value;
  }
  const bases = [parsed.options.baseUrl, internal.pathsBasePath]
    .filter((value): value is string => value !== undefined)
    .map(value => resolve(configDir, value));
  if (bases.length === 0) bases.push(configDir);
  for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
    for (const mapping of targets) {
      for (const base of bases) {
        if (!within(root, resolve(base, mapping.replace(/\*/g, "x")))) {
          return `paths ${pattern} → ${mapping}`;
        }
      }
    }
  }
  return null;
}

/**
 * The `extends` chain. An absolute value is always refused, a relative one must
 * stay inside the snapshot, and a package-provided config is resolved through
 * the bounded host so it can only come from the installed dependencies.
 */
function extendsEscape(
  plan: Plan,
  snapshot: Snapshot,
  host: TypeScript.ParseConfigHost,
  configPath: string,
  depth: number,
): string | null {
  if (depth > 8) return `extends chain deeper than 8 levels from ${repoRelative(snapshot.root, configPath)}`;
  const read = plan.ts.readConfigFile(configPath, host.readFile);
  if (read.error !== undefined) return null;
  // Boundary parse: the raw config is untrusted text, so only a schema-checked
  // `extends` is ever used, and any other shape contributes no inherited path.
  const boundary = extendsSchema.safeParse(read.config);
  if (!boundary.success) return null;
  for (const value of boundary.data.extends ?? []) {
    if (isAbsolute(value)) return `extends ${value}`;
    let target: string;
    if (value.startsWith(".")) {
      target = resolve(dirname(configPath), value);
      if (!within(snapshot.root, target)) return `extends ${value}`;
    } else {
      const resolved = plan.ts.resolveModuleName(
        value,
        configPath,
        { moduleResolution: plan.ts.ModuleResolutionKind.NodeNext },
        host,
      ).resolvedModule?.resolvedFileName;
      if (resolved === undefined) continue;
      if (!confined(plan, snapshot.root, resolved)) return `extends ${value}`;
      target = resolved;
    }
    const nested = extendsEscape(plan, snapshot, host, isRegularFile(target) ? target : `${target}.json`, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Every file the program actually read must come from the snapshot, an
 * installed dependency, or the compiler's own libraries. TypeScript follows
 * absolute specifiers and `../..` paths wherever they lead, so a program that
 * reached any other file is discarded before its diagnostics are published.
 */
function confinementBreach(plan: Plan, snapshot: Snapshot, program: TypeScript.Program): string | null {
  for (const source of program.getSourceFiles()) {
    if (confined(plan, snapshot.root, source.fileName)) continue;
    return source.fileName;
  }
  return null;
}

/**
 * A read is confined when its *resolved* location is snapshot content or a
 * trusted installed-dependency/compiler directory. The lexical path is never
 * enough: with `preserveSymlinks` TypeScript keeps `snapshot/node_modules/...`
 * for a file that physically lives in the live checkout, and a lexical match
 * would then admit live state as if it were revision content.
 */
function confined(plan: Plan, root: string, path: string): boolean {
  const real = realpathOr(path);
  if (within(root, real)) return true;
  return plan.trustedRoots.some(allowed => within(allowed, real));
}

/**
 * Every unresolved reference the program reports in a snapshot file. Files
 * outside the snapshot — installed dependencies and compiler libraries — are
 * excluded: their errors are not this revision's, and the repository's live
 * dependency tree is deliberately not part of the comparison.
 *
 * A revision with more errors than the comparison bound is refused, never
 * truncated: capping one revision's list before subtracting it would move its
 * boundary, so a pre-existing error past the cap could enter as introduced.
 */
function collectDiagnostics(plan: Plan, snapshot: Snapshot, program: TypeScript.Program): Located[] {
  const lines = new Map<string, readonly string[]>();
  const located: Located[] = [];
  for (const diagnostic of plan.ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file;
    if (file === undefined || diagnostic.start === undefined) continue;
    if (!UNRESOLVED_CODES.has(diagnostic.code)) continue;
    if (!within(snapshot.root, file.fileName)) continue;
    // A finding must come from a file this revision tracks. Anything else the
    // program read — an installed package's own sources, or a symlinked path
    // that only looks like snapshot content under `preserveSymlinks` — is not
    // this revision's source and would otherwise be reported with head-revision
    // evidence it does not have.
    const relative = repoRelative(snapshot.root, file.fileName);
    if (!snapshot.tree.has(relative)) continue;
    if (located.length >= MAX_DIAGNOSTICS) {
      fail(
        `Revision ${short(snapshot.rev)} has more than ${MAX_DIAGNOSTICS} unresolved-reference errors, beyond what this comparison bounds. Truncating a revision's errors would move its boundary and could report a pre-existing error as introduced, so no findings are reported.`,
      );
    }
    const position = file.getLineAndCharacterOfPosition(diagnostic.start);
    const cached = lines.get(file.fileName);
    const text = cached ?? file.getFullText().split(/\r\n|\r|\n/);
    lines.set(file.fileName, text);
    located.push({
      file: relative,
      line: position.line + 1,
      code: diagnostic.code,
      // TypeScript embeds resolved file paths in some messages, and the two
      // snapshots have different roots, so every representation of the root is
      // replaced by a stable token: otherwise the same pre-existing error would
      // read as a different message in each revision and be reported as new.
      message: normalizeMessage(
        plan.ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        snapshot.root,
      ).slice(0, MAX_MESSAGE_CHARS),
      lineText: (text[position.line] ?? "").trim(),
    });
  }
  located.sort(compareLocated);
  return located;
}

/**
 * Head diagnostics that no base diagnostic explains. An exact match on (file,
 * code, message, trimmed source line) cancels first, so a pre-existing error
 * that only moved lines stays pre-existing; a second pass matches on (file,
 * code, message), so a reflowed pre-existing error does not become an
 * introduction either.
 */
function introducedOnly(base: readonly Located[], head: readonly Located[]): Located[] {
  const exact = new Map<string, number>();
  const triples = new Map<string, number>();
  for (const item of base) {
    exact.set(exactKey(item), (exact.get(exactKey(item)) ?? 0) + 1);
    triples.set(tripleKey(item), (triples.get(tripleKey(item)) ?? 0) + 1);
  }
  const unmatched: Located[] = [];
  for (const item of head) {
    const remaining = exact.get(exactKey(item)) ?? 0;
    if (remaining > 0) {
      exact.set(exactKey(item), remaining - 1);
      triples.set(tripleKey(item), (triples.get(tripleKey(item)) ?? 0) - 1);
      continue;
    }
    unmatched.push(item);
  }
  const introduced: Located[] = [];
  for (const item of unmatched) {
    const remaining = triples.get(tripleKey(item)) ?? 0;
    if (remaining > 0) triples.set(tripleKey(item), remaining - 1);
    else introduced.push(item);
  }
  return introduced;
}

function exactKey(item: Located): string {
  return `${tripleKey(item)}\u0000${item.lineText}`;
}

function tripleKey(item: Located): string {
  return `${item.file}\u0000${item.code}\u0000${item.message}`;
}

function compareLocated(left: Located, right: Located): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.code !== right.code) return left.code - right.code;
  if (left.message === right.message) return 0;
  return left.message < right.message ? -1 : 1;
}

function findingFor(plan: Plan, item: Located, index: number): AutomaticFinding {
  const excerpt: EvidenceExcerpt = {
    id: `reference-${index}-head`,
    label: `TS${item.code}`,
    file: item.file,
    line: item.line,
    ref: short(plan.headSha),
    text: item.lineText,
    role: "change",
  };
  return {
    id: `reference-${index}`,
    kind: "broken-reference",
    title: `TS${item.code}: ${item.message}`,
    scope: `${item.file}:${item.line}`,
    limitation: LIMITATION,
    unitIds: plan.unitsByFile.get(item.file) ?? [],
    evidence: [excerpt],
  };
}

function coverageDetail(
  plan: Plan,
  baseSha: string,
  headSha: string,
  base: readonly Located[],
  head: readonly Located[],
  introduced: number,
  reported: number,
): string {
  const parts = [
    `TypeScript ${plan.ts.version} at ${plan.compilerEntry}, run once per revision over whole isolated snapshots (base ${short(baseSha)} → head ${short(headSha)}) written outside the repository, each with its own ${plan.projectRel} and the repository's installed node_modules mirrored read-only.`,
    `Unresolved-reference errors: ${base.length} at base, ${head.length} at head; ${head.length - introduced} matched a pre-existing error and ${reported} are reported as introduced. Codes considered: ${[...UNRESOLVED_CODES].sort((left, right) => left - right).join(", ")}.`,
  ];
  if (plan.notes.size > 0) parts.push(`Not verified: ${[...plan.notes].join(", ")}.`);
  parts.push(LIMITATION);
  return parts.join(" ");
}

/** Changed unit ids per repository-relative path, for finding attribution. */
function unitsByFile(units: readonly ReviewUnit[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const unit of units) {
    const path = safeRepoPath(unit.file);
    if (path === null) continue;
    const ids = byFile.get(path);
    if (ids === undefined) byFile.set(path, [unit.id]);
    else ids.push(unit.id);
  }
  return byFile;
}

function readTree(repoRoot: string, rev: string): Map<string, TreeEntry> {
  let listing: string;
  try {
    listing = git(repoRoot, ["ls-tree", "-r", "-z", "-l", rev]).toString("utf8");
  } catch {
    fail(`The file list of revision ${short(rev)} is unavailable, so nothing was materialized or compared.`);
  }
  const tree = new Map<string, TreeEntry>();
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) fail(`The file list of revision ${short(rev)} could not be parsed, so nothing was compared.`);
    const fields = record.slice(0, tab).split(/\s+/);
    const size = Number(fields[3]);
    tree.set(record.slice(tab + 1), { mode: fields[0] ?? "", size: Number.isFinite(size) ? size : 0 });
  }
  return tree;
}

function resolveCommit(repoRoot: string, ref: string): string {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString("utf8").trim();
  } catch {
    fail(`The revision ${JSON.stringify(ref)} cannot be resolved in ${repoRoot}, so no immutable snapshot was available to check.`);
  }
}

function git(repoRoot: string, args: readonly string[]): Buffer {
  return execFileSync("git", ["--no-replace-objects", "--no-pager", ...args], {
    cwd: repoRoot,
    maxBuffer: GIT_MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

/**
 * A repository-relative path that is safe to join onto the snapshot root: no
 * absolute form, no NUL, no backslash, no `..` segment, and no `node_modules`
 * segment, so snapshot content can never enter a dependency tree.
 */
function safeRepoPath(path: string): string | null {
  if (path === "" || path.includes("\0") || path.includes("\\") || isAbsolute(path)) return null;
  const normalized = posix.normalize(path);
  if (normalized === "" || normalized === "." || normalized === "..") return null;
  if (normalized.startsWith("../") || normalized.startsWith("/")) return null;
  if (normalized.split("/").includes("node_modules")) return null;
  return normalized;
}

function repoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * Replace every representation of a snapshot root in a diagnostic message with
 * one stable token: the path as given, its forward-slash form, its
 * backslash form, and — on macOS, where the temp directory is reachable as both
 * `/var/...` and `/private/var/...` — the `/private`-stripped form. Without
 * this, the base and head snapshots would render the same error differently and
 * a pre-existing error would be subtracted as an introduced one.
 */
function normalizeMessage(message: string, root: string): string {
  const roots = new Set([root, root.split(sep).join("/"), root.split("/").join("\\")]);
  if (root.startsWith("/private/")) roots.add(root.slice("/private".length));
  let normalized = message;
  for (const variant of roots) normalized = normalized.split(variant).join("<snapshot>");
  return normalized;
}
