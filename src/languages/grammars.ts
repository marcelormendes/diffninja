import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { npmEnvironment } from "./child-env.js";
import { GRAMMAR_BUILD_ONLY, GRAMMAR_PACKAGE_JSON, GRAMMAR_PACKAGE_LOCK, GRAMMAR_PINS } from "./grammar-lock.js";

/**
 * Loaded tree-sitter grammar package surface.
 * Named exports (`typescript`, `tsx`, …) are looked up by `resolveLanguage`.
 */
export type GrammarModule = {
  language?: GrammarModule;
  typescript?: GrammarModule;
  tsx?: GrammarModule;
  [exportName: string]: GrammarModule | undefined;
};

/** Runtime grammar handle passed to `parser.setLanguage`. */
export type GrammarLanguage = GrammarModule;

type NativeBinding = GrammarModule & {
  nodeTypeInfo?: object;
};

type NodeGypBuild = (root: string) => GrammarModule;

function errnoCode(err: Error): string | undefined {
  // SAFETY: Node require/fs failures are ErrnoException with optional string code.
  return (err as NodeJS.ErrnoException).code;
}

/**
 * Grammars that ship inside diffninja's own package (regular dependencies). Any
 * other grammar comes only from the cache below, never from whatever
 * `node_modules` happens to sit above the install.
 */
const BUNDLED_GRAMMARS: ReadonlySet<string> = new Set(["tree-sitter-javascript", "tree-sitter-typescript"]);

/**
 * Where `diffninja grammars install` puts the pinned grammars. Private to
 * diffninja: the shared calldiff cache holds whatever an unpinned install once
 * fetched, and is never read.
 */
export function grammarCacheDir(): string {
  const override = process.env.DIFFNINJA_GRAMMAR_CACHE;
  if (override) return override;
  return join(homedir(), ".cache", "diffninja", "grammars");
}

/**
 * Written last by the installer, so a cache without it (or with another lock's) is not trusted.
 * It is a consistency check, not authentication. It holds only public data (the lock's digest),
 * so anyone who can write the directory can write one. Ownership is what cacheDirectoryProblem checks.
 */
const CACHE_MARKER = ".diffninja-grammars.json";
const markerSchema = z.object({ format: z.literal(1), lockSha256: z.string(), installedAt: z.string(), built: z.boolean().optional() });

/**
 * Why grammars in this directory must not be loaded, or undefined when it is safe to.
 * It must belong to the user running diffninja and be writable by no one else. A missing
 * directory is no problem, since there is nothing in it to trust. Windows has no uid or mode bits,
 * so nothing is checked there.
 */
export function cacheDirectoryProblem(dir: string): string | undefined {
  const uid = process.getuid?.();
  const stats = uid === undefined ? undefined : statSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  if (stats.uid !== uid) return `${dir} belongs to another user (uid ${stats.uid})`;
  if ((stats.mode & 0o022) !== 0) return `other users can write to ${dir} (mode ${(stats.mode & 0o777).toString(8)})`;
  return undefined;
}

/** The exact version diffninja pins for a grammar package, or undefined when it is not one of them. */
export function pinnedVersion(npmPackage: string): string | undefined {
  // hasOwn: "constructor" and the like must not read as pinned through the prototype.
  // SAFETY: hasOwn just proved npmPackage is one of GRAMMAR_PINS's own keys.
  return Object.hasOwn(GRAMMAR_PINS, npmPackage) ? GRAMMAR_PINS[npmPackage as keyof typeof GRAMMAR_PINS] : undefined;
}

function needsBuild(npmPackage: string): boolean {
  // SAFETY: widening a tuple of string literals to string[] only to test membership.
  return (GRAMMAR_BUILD_ONLY as readonly string[]).includes(npmPackage);
}

let cachedDigest: string | undefined;
/** Fingerprint of the lock this build of diffninja installs from. */
export function grammarLockDigest(): string {
  cachedDigest ??= createHash("sha256").update(JSON.stringify(GRAMMAR_PACKAGE_LOCK)).digest("hex");
  return cachedDigest;
}

/** The marker of a cache this diffninja's lock installed, or undefined for anything else. */
function readCacheMarker(cacheDir: string): z.infer<typeof markerSchema> | undefined {
  if (cacheDirectoryProblem(cacheDir) !== undefined) return undefined;
  try {
    const marker = markerSchema.safeParse(JSON.parse(readFileSync(join(cacheDir, CACHE_MARKER), "utf8")));
    return marker.success && marker.data.lockSha256 === grammarLockDigest() ? marker.data : undefined;
  } catch {
    return undefined;
  }
}

const packageVersionSchema = z.object({ version: z.string() });

/** The installed directory of a pinned grammar, when the cache is one diffninja installed and holds exactly the pinned version. */
function pinnedGrammarRoot(cacheDir: string, npmPackage: string): string | undefined {
  const pinned = pinnedVersion(npmPackage);
  const marker = pinned === undefined ? undefined : readCacheMarker(cacheDir);
  if (pinned === undefined || marker === undefined) return undefined;
  // A grammar with no prebuilt binary loads only after the person asked for its source build.
  if (needsBuild(npmPackage) && marker.built !== true) return undefined;
  const root = join(cacheDir, "node_modules", npmPackage);
  try {
    const manifest = packageVersionSchema.safeParse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    return manifest.success && manifest.data.version === pinned ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A grammar this review needed is not installed. diffninja never downloads code
 * while it reviews; the person installs the pinned set once, on purpose.
 */
export class GrammarNotInstalledError extends Error {
  constructor(readonly npmPackage: string) {
    super(
      pinnedVersion(npmPackage) === undefined
        ? `${npmPackage} is not one of the grammars diffninja installs, so call flows skip its files.`
        : needsBuild(npmPackage)
          ? `The ${npmPackage} grammar ships no prebuilt binary, so call flows skip its files until it is compiled on this machine. diffninja does not download or build code while it reviews: run \`npx diffninja grammars install --build\` once (needs Python and a C/C++ compiler), then review again.`
          : `The ${npmPackage} grammar is not installed, so call flows skip its files. diffninja does not download code while it reviews: run \`npx diffninja grammars install\` once to add the pinned grammars, then review again.`,
    );
    this.name = "GrammarNotInstalledError";
  }
}

const missingGrammars = new Set<string>();

/** The grammars that were needed and absent since the last call, sorted; clears the record. */
export function takeMissingGrammars(): string[] {
  const names = [...missingGrammars].sort();
  missingGrammars.clear();
  return names;
}

/**
 * Absolute path to one of npm's JS entry points (`npm-cli.js`, `npx-cli.js`),
 * or undefined when npm is not installed beside Node.
 */
export function npmCliPath(
  cli: string,
  directories: readonly string[] = [
    ...(process.env.PATH ?? "").split(";"),
    dirname(process.execPath),
  ],
): string | undefined {
  for (const raw of directories) {
    const directory = raw.trim().replace(/^"|"$/g, "");
    // Never resolve executables from the repository being reviewed.
    if (!isAbsolute(directory)) continue;
    const path = join(directory, "node_modules", "npm", "bin", cli);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * On Windows, npm.cmd is a shell script, not an executable. Run npm's JS entry
 * with Node instead: cache paths (including spaces and percent signs) remain
 * literal argv values rather than being interpreted by cmd.exe.
 */
export function npmSpawnSpec(
  args: string[],
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "win32") return { file: "npm", args };
  const cli = npmCliPath("npm-cli.js");
  if (cli === undefined) {
    throw new Error(
      "Cannot locate npm's npm-cli.js. Install Node.js with npm and add its directory to PATH.",
    );
  }
  return { file: process.execPath, args: [cli, ...args] };
}

/**
 * Some grammar packages (e.g. tree-sitter-c-sharp ≥0.23.5) ship ESM bindings
 * with top-level await, which `require()` cannot load. Fall back to the native
 * `.node` addon via node-gyp-build — same payload the JS wrapper would return.
 */
function loadNativeBinding(packageRoot: string): GrammarModule | null {
  try {
    const require = createRequire(join(packageRoot, "package.json"));
    // SAFETY: node-gyp-build's default export is (root) => native binding.
    const gypBuild = require("node-gyp-build") as NodeGypBuild;
    const binding: NativeBinding = gypBuild(packageRoot);
    try {
      binding.nodeTypeInfo = require(
        join(packageRoot, "src", "node-types.json"),
      );
    } catch {
      // optional metadata
    }
    return binding;
  } catch {
    return null;
  }
}

/**
 * Expected native machine type for this host, for checking prebuild headers.
 * ELF e_machine (Linux), Mach-O cputype (macOS), PE COFF machine (Windows).
 */
function expectedMachine(): number | null {
  if (process.platform === "linux") {
    return process.arch === "x64" ? 62 : process.arch === "arm64" ? 183 : null;
  }
  if (process.platform === "darwin") {
    return process.arch === "x64"
      ? 0x01000007
      : process.arch === "arm64"
        ? 0x0100000c
        : null;
  }
  if (process.platform === "win32") {
    return process.arch === "x64" ? 0x8664 : process.arch === "arm64" ? 0xaa64 : null;
  }
  return null;
}

/** Machine type declared in a native prebuild's header, or null if unreadable. */
function prebuildMachine(prebuildPath: string): number | null {
  let header: Buffer;
  try {
    header = readFileSync(prebuildPath).subarray(0, 64);
  } catch {
    return null;
  }
  if (header.length < 20) return null;
  // ELF: 7f 45 4c 46, e_machine is a little-endian u16 at offset 18.
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return header.readUInt16LE(18);
  }
  // Mach-O 64-bit: FE ED FA CF (little-endian), cputype is a u32 at offset 4.
  if (
    header[0] === 0xcf &&
    header[1] === 0xfa &&
    header[2] === 0xed &&
    header[3] === 0xfe
  ) {
    return header.readUInt32LE(4);
  }
  // PE: 4D 5A ("MZ"), e_lfanew at 0x3C points at the COFF header whose first
  // u16 is the machine type.
  if (header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 2 <= header.length) return header.readUInt16LE(peOffset);
  }
  return null;
}

/**
 * Path of this platform's prebuild when the file exists but targets another
 * CPU (e.g. x86-64 bytes shipped as linux-arm64). Null when the prebuild is
 * absent, unreadable, or correct: only a confirmed mismatch is reported.
 * Exported for tests and diagnostics.
 */
export function mislabeledPrebuild(packageRoot: string): string | null {
  const expected = expectedMachine();
  if (expected === null) return null;
  let entries;
  try {
    entries = readdirSync(join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`), {
      withFileTypes: true,
    });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".node")) continue;
    const full = join(
      packageRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      entry.name,
    );
    const machine = prebuildMachine(full);
    if (machine !== null && machine !== expected) return full;
  }
  return null;
}

/**
 * Explain a native load failure in actionable terms. Extraction treats load
 * failures as per-file warnings, so the hint must name the fix.
 */
function withNativeLoadHints(npmPackage: string, err: Error): string {
  if (/GLIBCXX|GLIBC_/i.test(err.message)) {
    return (
      `${err.message} — the ${npmPackage} native module needs libstdc++ from GCC 13.1 ` +
      `or newer (for example Ubuntu 24.04+). Rebuild it for this host with ` +
      `\`npm rebuild ${npmPackage} --build-from-source\`, or upgrade libstdc++.`
    );
  }
  return err.message;
}

function requireGrammar(
  require: NodeRequire,
  npmPackage: string,
  packageRoot: string,
): GrammarModule {
  try {
    // SAFETY: grammar packages export a module compatible with GrammarModule.
    return require(npmPackage) as GrammarModule;
  } catch (err) {
    // SAFETY: catch bindings are unknown; normalize to Error at the boundary.
    const failure = err instanceof Error ? err : new Error(String(err));
    const code = errnoCode(failure);
    if (
      code === "ERR_REQUIRE_ASYNC_MODULE" ||
      failure.message.includes("top-level await")
    ) {
      const binding = loadNativeBinding(packageRoot);
      if (binding) return binding;
    } else {
      // A prebuild for another CPU cannot load, and repairing it means compiling:
      // say so instead of editing the cache.
      const bad = mislabeledPrebuild(packageRoot);
      if (bad !== null) {
        throw new Error(`${npmPackage} ships a native build for another CPU (${bad}), so it cannot load on ${process.platform}/${process.arch}.`);
      }
    }
    throw new Error(withNativeLoadHints(npmPackage, failure));
  }
}

/** Runs npm in `cwd`; replaced in tests. Throws with npm's own message when it fails. */
export type NpmRunner = (cwd: string, args: string[]) => void;

function runNpm(cwd: string, args: string[], build: boolean): void {
  const npm = npmSpawnSpec(args);
  try {
    // A minimal environment: no token of the engineer's reaches npm or any install script.
    execFileSync(npm.file, npm.args, { cwd, env: npmEnvironment(process.env, { npm_config_global: "false", npm_config_location: "project" }, { build }), stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // SAFETY: catch bindings are unknown; execFileSync errors carry the child's stderr.
    const failure = err as Error & { stderr?: Buffer | string };
    const tail = String(failure.stderr ?? "").split("\n").filter(line => line.trim() !== "").slice(-6).join("\n");
    throw new Error(`npm could not install the grammars: ${failure.message}${tail === "" ? "" : `\n${tail}`}`);
  }
}

export interface InstalledGrammars {
  cacheDir: string;
  packages: Array<{ name: string; version: string }>;
}

/**
 * Install exactly the pinned grammars, and nothing else, into the cache. This is
 * the only place diffninja downloads grammar code, and only when a person runs
 * `diffninja grammars install`. `npm ci` from the shipped lock refuses any
 * tarball whose sha512 differs, `--ignore-scripts` keeps every install script
 * (the packages' own and their dependencies') from running, and the grammars
 * load from their bundled prebuilt binaries. Reviews never call this.
 */
export function installPinnedGrammars(options: { cacheDir?: string; runNpm?: NpmRunner; build?: boolean } = {}): InstalledGrammars {
  const cacheDir = options.cacheDir ?? grammarCacheDir();
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone, so tighten one's own and refuse anyone else's.
  if (statSync(cacheDir).uid === process.getuid?.()) chmodSync(cacheDir, 0o700);
  const problem = cacheDirectoryProblem(cacheDir);
  if (problem !== undefined) throw new Error(`Refusing to install grammars: ${problem}, so its contents could not be trusted. Set DIFFNINJA_GRAMMAR_CACHE to a directory of your own.`);
  // Untrusted until the install below finishes and verifies.
  rmSync(join(cacheDir, CACHE_MARKER), { force: true });
  writeFileSync(join(cacheDir, "package.json"), JSON.stringify(GRAMMAR_PACKAGE_JSON, null, 2) + "\n", "utf8");
  writeFileSync(join(cacheDir, "package-lock.json"), JSON.stringify(GRAMMAR_PACKAGE_LOCK, null, 2) + "\n", "utf8");
  // No --prefix: `npm ci` rejects it. The working directory is the project, whatever the user's npm config says.
  const npm = options.runNpm ?? ((cwd, args) => runNpm(cwd, args, options.build === true));
  npm(cacheDir, ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]);
  // The one place an install script runs: the source build of the grammars with no prebuilt
  // binary, for exactly those packages, and only because the person asked for --build.
  if (options.build === true) npm(cacheDir, ["rebuild", "--legacy-peer-deps", "--no-audit", "--no-fund", ...GRAMMAR_BUILD_ONLY]);
  const packages: Array<{ name: string; version: string }> = [];
  for (const [name, version] of Object.entries(GRAMMAR_PINS)) {
    let installed: string | undefined;
    try {
      const manifest = packageVersionSchema.safeParse(JSON.parse(readFileSync(join(cacheDir, "node_modules", name, "package.json"), "utf8")));
      installed = manifest.success ? manifest.data.version : undefined;
    } catch {
      installed = undefined;
    }
    if (installed !== version) throw new Error(`${name}@${version} is not in ${cacheDir} after the install (found ${installed ?? "nothing"}); leaving the cache untrusted.`);
    packages.push({ name, version });
  }
  writeFileSync(join(cacheDir, CACHE_MARKER), JSON.stringify({ format: 1, lockSha256: grammarLockDigest(), installedAt: new Date().toISOString(), built: options.build === true }) + "\n", "utf8");
  return { cacheDir, packages };
}

export interface GrammarStatus {
  cacheDir: string;
  /** The cache was installed by this diffninja's lock, so its grammars are used. */
  trusted: boolean;
  packages: Array<{ name: string; version: string; installed: boolean; needsBuild: boolean }>;
}

export function grammarStatus(cacheDir: string = grammarCacheDir()): GrammarStatus {
  return {
    cacheDir,
    trusted: readCacheMarker(cacheDir) !== undefined,
    packages: Object.entries(GRAMMAR_PINS).map(([name, version]) => ({ name, version, installed: pinnedGrammarRoot(cacheDir, name) !== undefined, needsBuild: needsBuild(name) })),
  };
}

/**
 * The grammar package's module. Bundled grammars come from diffninja's own
 * dependencies; every other one from the cache `diffninja grammars install`
 * filled, and only when that cache holds the exact pinned version. Nothing is
 * ever downloaded here: a missing grammar throws GrammarNotInstalledError, which
 * call-flow analysis reports once instead of skipping silently.
 */
export function loadGrammarPackage(npmPackage: string): GrammarModule {
  if (BUNDLED_GRAMMARS.has(npmPackage)) {
    const localRequire = createRequire(import.meta.url);
    try {
      // SAFETY: local dependency resolves to a tree-sitter grammar module.
      return localRequire(npmPackage) as GrammarModule;
    } catch (err) {
      // SAFETY: catch bindings are unknown; normalize to Error at the boundary.
      const failure = err instanceof Error ? err : new Error(String(err));
      const code = errnoCode(failure);
      if (code === "ERR_REQUIRE_ASYNC_MODULE" || failure.message.includes("top-level await")) {
        const packageRoot = join(localRequire.resolve(npmPackage), "..", "..");
        const binding = loadNativeBinding(packageRoot);
        if (binding) return binding;
      }
      throw failure;
    }
  }

  const cacheDir = grammarCacheDir();
  const packageRoot = pinnedGrammarRoot(cacheDir, npmPackage);
  if (packageRoot === undefined) {
    missingGrammars.add(npmPackage);
    throw new GrammarNotInstalledError(npmPackage);
  }
  const require = createRequire(join(cacheDir, "package.json"));
  return requireGrammar(require, npmPackage, packageRoot);
}

/** Resolve the value to pass to parser.setLanguage. */
export function resolveLanguage(
  mod: GrammarModule,
  exportName?: string,
): GrammarLanguage {
  if (exportName) {
    const named = mod[exportName];
    if (named != null) return named;
  }
  // Native grammar packages export { language, nodeTypeInfo, ... } — pass the module.
  return mod;
}
