import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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

/** On-disk cache of npm-installed tree-sitter grammar packages. */
export function grammarCacheDir(): string {
  const override = process.env.CALLDIFF_GRAMMAR_CACHE;
  if (override) return override;
  return join(homedir(), ".cache", "calldiff", "grammars");
}

function packageInstalled(cacheDir: string, npmPackage: string): boolean {
  return existsSync(join(cacheDir, "node_modules", npmPackage));
}

function ensureCachePackageJson(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  const pkgPath = join(cacheDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "calldiff-grammar-cache",
        private: true,
        description: "On-demand tree-sitter grammars for calldiff",
      }),
      "utf8",
    );
  }
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
  const directories = [
    ...(process.env.PATH ?? "").split(";"),
    dirname(process.execPath),
  ];
  for (const raw of directories) {
    const directory = raw.trim().replace(/^"|"$/g, "");
    // Never resolve executables from the repository being reviewed.
    if (!isAbsolute(directory)) continue;
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] };
  }
  throw new Error(
    "Cannot locate npm's npm-cli.js. Install Node.js with npm and add its directory to PATH.",
  );
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
 * Explain a native load failure in actionable terms. The caller still throws;
 * extraction treats it as a per-file warning, so the hint must name the fix.
 */
function describeNativeLoadFailure(npmPackage: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/GLIBCXX|GLIBC_/i.test(message)) {
    return (
      `${message} — the ${npmPackage} native module needs libstdc++ from GCC 13.1 ` +
      `or newer (for example Ubuntu 24.04+). Rebuild it for this host with ` +
      `\`npm rebuild ${npmPackage} --build-from-source\`, or upgrade libstdc++.`
    );
  }
  return message;
}

function isEsmTopLevelAwait(err: unknown): boolean {
  const code = err instanceof Error ? errnoCode(err) : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  return code === "ERR_REQUIRE_ASYNC_MODULE" || msg.includes("top-level await");
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
    if (isEsmTopLevelAwait(err)) {
      const binding = loadNativeBinding(packageRoot);
      if (binding) return binding;
    } else {
      // A mislabeled prebuild blocks node-gyp-build's own source-build
      // fallback. This directory is diffninja's own grammar cache, so remove
      // the bad artifact and let the load retry compile from source.
      const bad = mislabeledPrebuild(packageRoot);
      if (bad !== null) {
        rmSync(bad, { force: true });
        try {
          // SAFETY: grammar packages export a module compatible with GrammarModule.
          return require(npmPackage) as GrammarModule;
        } catch {
          const binding = loadNativeBinding(packageRoot);
          if (binding) return binding;
        }
      }
    }
    throw new Error(describeNativeLoadFailure(npmPackage, err));
  }
}

function installSpecFor(npmPackage: string): string {
  switch (npmPackage) {
    case "tree-sitter-c-sharp":
      return "tree-sitter-c-sharp@0.23.1";
    case "@tree-sitter-grammars/tree-sitter-lua":
      // 0.4+ is ESM-with-TLA; 0.2.0 is CJS and loads via createRequire.
      return "@tree-sitter-grammars/tree-sitter-lua@0.2.0";
    default:
      return npmPackage;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Why this grammar's install can fail beyond npm itself, for the error text. */
function installFailureHint(npmPackage: string): string | null {
  if (npmPackage === "tree-sitter-swift") {
    return (
      "tree-sitter-swift downloads its parser CLI from GitHub Releases during " +
      "install; a proxy or offline network fails that download. Retry with " +
      "network access to github.com, or pre-populate CALLDIFF_GRAMMAR_CACHE."
    );
  }
  if (npmPackage === "tree-sitter-perl" || npmPackage === "tree-sitter-kotlin") {
    return (
      "this grammar ships no prebuilt binary and compiles from source: Python " +
      "and a C/C++ toolchain (build-essential, Xcode command line tools, or " +
      "Visual Studio Build Tools) are required."
    );
  }
  return null;
}

/**
 * Install an on-demand grammar into the cache, retrying transient network
 * failures (the Swift parser CLI download is the known flaky one). Throws an
 * actionable error when the install cannot succeed.
 */
function installGrammarPackage(cacheDir: string, npmPackage: string): void {
  const npm = npmSpawnSpec([
    "install",
    "--prefix",
    cacheDir,
    "--no-save",
    "--no-fund",
    "--no-audit",
    "--legacy-peer-deps",
    installSpecFor(npmPackage),
  ]);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(npm.file, npm.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        timeout: 300_000,
      });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) sleepMs(2000 * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const hint = installFailureHint(npmPackage);
  throw new Error(
    `Could not install the ${npmPackage} grammar into ${cacheDir}: ${detail}` +
      (hint ? ` ${hint}` : ""),
  );
}

/**
 * Install an npm grammar package into the shared cache if missing, then require it.
 * Reuses the cache across CLI invocations.
 */
export function loadGrammarPackage(npmPackage: string): GrammarModule {
  // Prefer the app's own dependency when present (e.g. tree-sitter-typescript).
  try {
    const localRequire = createRequire(import.meta.url);
    try {
      // SAFETY: local dependency resolves to a tree-sitter grammar module.
      return localRequire(npmPackage) as GrammarModule;
    } catch (err) {
      if (isEsmTopLevelAwait(err)) {
        const entry = localRequire.resolve(npmPackage);
        const packageRoot = join(entry, "..", "..");
        const binding = loadNativeBinding(packageRoot);
        if (binding) return binding;
      }
      throw err;
    }
  } catch {
    // fall through to cache
  }

  const cacheDir = grammarCacheDir();
  if (!packageInstalled(cacheDir, npmPackage)) {
    ensureCachePackageJson(cacheDir);
    installGrammarPackage(cacheDir, npmPackage);
  }

  const require = createRequire(join(cacheDir, "package.json"));
  const packageRoot = join(cacheDir, "node_modules", npmPackage);
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
