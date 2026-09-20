#!/usr/bin/env node
// Postinstall heal for tree-sitter-typescript's native binding.
//
// Why this exists: tree-sitter-typescript@0.23.2 publishes an x86-64 ELF as its
// `prebuilds/linux-arm64/` binary, so on Linux ARM64 the addon cannot load. The
// package's own `install` script (`node-gyp-build`) notices the load failure and
// falls back to `node-gyp rebuild`, but that build aborts `npm install` outright:
// under Node 22 the generated Makefile for node-addon-api's exception support is
// malformed and node-gyp exits non-zero. Because the package is declared as an
// *optional* dependency of diffninja, npm now survives that failure and leaves
// the package's binding unusable — and diffninja's TypeScript/TSX extraction
// would fall through to the on-demand grammar cache, which needs the same
// toolchain and network. This script repairs the installed copy instead: it
// drops the wrong-architecture prebuild and compiles the grammar from source,
// which is exactly what the fix upstream (activeloopai/hivemind cd8642e) does.
//
// On every platform whose prebuild loads (Linux/Windows/macOS x64, macOS arm64)
// the probe below succeeds and this is a fast no-op that touches nothing.
//
// This is a heal, not a gate: it always exits 0, including when no C/C++ toolchain
// is present. Extraction degrades to a per-file warning in that case, and a user
// can retry later with `npm run rebuild:native`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one grammar package with a broken prebuild; see the header comment. */
const PACKAGE = "tree-sitter-typescript";
/** Parse shape used by the probe: TypeScript syntax only this grammar accepts. */
const PROBE_SOURCE = "const x: number = 1;";
/** Set for the nested npm calls below, which re-enter this package's lifecycle. */
const RECURSION_GUARD = "DIFFNINJA_NATIVE_GRAMMAR_HEAL";
/** Generous for a source compile; a hung npm must not hang the install forever. */
const NPM_TIMEOUT_MS = 900_000;

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

/**
 * Real end-to-end check: require the parser and the grammar, set the language and
 * parse. A prebuild that exists but targets another CPU fails here, which is the
 * only reliable signal — the file is present and its wrapper loads.
 */
function grammarWorks() {
  try {
    const Parser = require("tree-sitter");
    const parser = new Parser();
    parser.setLanguage(require(PACKAGE).typescript);
    parser.parse(PROBE_SOURCE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same parse, in a child process. The in-process probe above already failed once
 * in this process, and an installer's process is a poor place to judge the result
 * of an install it just performed; a fresh process is what the next `diffninja`
 * run will do. Run with `-e` and cwd at the package root, so a bare `require`
 * resolves through the same `node_modules` chain the CLI uses. Only the failure
 * reason is echoed — a child's full stack trace would bury the outcome line.
 */
function grammarWorksInFreshProcess() {
  const script = `
    const Parser = require("tree-sitter");
    const parser = new Parser();
    parser.setLanguage(require(${JSON.stringify(PACKAGE)}).typescript);
    parser.parse(${JSON.stringify(PROBE_SOURCE)});
  `;
  try {
    execFileSync(process.execPath, ["-e", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const lines = String(error.stderr ?? "").split("\n").filter(line => line.trim() !== "");
    const reason = lines.find(line => line.includes("Error")) ?? lines[0];
    if (reason) console.error(`[native-grammar] probe still fails: ${reason.trim()}`);
    return false;
  }
}

/** Parsed JSON, or null when the file is missing or unreadable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * On Windows, npm.cmd is a shell script that Node refuses to spawn directly. Run
 * npm's JS entry through the current Node executable instead — same reasoning as
 * `npmSpawnSpec` in src/languages/grammars.ts.
 */
function npmSpawnSpec(args) {
  if (process.platform !== "win32") return { file: "npm", args };
  const directories = [...(process.env.PATH ?? "").split(";"), dirname(process.execPath)];
  for (const raw of directories) {
    const directory = raw.trim().replace(/^"|"$/g, "");
    if (!isAbsolute(directory)) continue;
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] };
  }
  throw new Error("Cannot locate npm's npm-cli.js on PATH.");
}

/** CXXFLAGS with C++20, which the Node 22+ headers require and binding.gyp omits. */
function withCxx20(cxxflags) {
  const flags = (cxxflags ?? "").trim();
  if (/(?:^|\s)-std=/.test(flags)) return flags;
  return flags ? `${flags} -std=c++20` : "-std=c++20";
}

/**
 * Installed directory of PACKAGE, by walking up the same `node_modules` chain the
 * loader walks: nested in the package (global installs) or hoisted beside it
 * (local project installs), whichever npm produced.
 *
 * Deliberately not `require.resolve`: that asks the loader, whose state belongs to
 * this already-failed process. An earlier revision resolved this way and still got
 * MODULE_NOT_FOUND after the npm install below landed the package (a fresh process
 * resolved the same path fine). A filesystem check reads what is on disk now.
 */
function packageRoot() {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", PACKAGE, "package.json");
    if (readJson(manifest)?.name === PACKAGE) return dirname(manifest);
    if (dirname(dir) === dir) throw new Error(`Cannot locate the installed ${PACKAGE} directory`);
  }
}

function heal() {
  const manifest = readJson(join(root, "package.json"));
  const spec = manifest?.optionalDependencies?.[PACKAGE] ?? manifest?.dependencies?.[PACKAGE] ?? "latest";
  const env = { ...process.env, [RECURSION_GUARD]: "1" };
  if (process.platform !== "win32") env.CXXFLAGS = withCxx20(process.env.CXXFLAGS);
  const npm = args => {
    const { file, args: argv } = npmSpawnSpec(args);
    execFileSync(file, argv, { cwd: root, env, stdio: "inherit", timeout: NPM_TIMEOUT_MS });
  };

  // npm removes an optional dependency whose install script failed, so the package
  // may be absent rather than merely broken. Fetch it without running its scripts:
  // the compile below is the single source of truth for the binding.
  //
  // No `--omit=dev`: `npm install <spec>` reconciles the whole tree, so adding it
  // would delete a developer's devDependencies (measured: 54 packages removed from
  // a checkout) to save inert packages in a consumer's global install. The probe
  // above means this branch only runs where npm actually dropped the package.
  if (!existsSync(join(root, "node_modules", PACKAGE, "package.json"))) {
    console.error(`[native-grammar] ${PACKAGE} is missing; fetching ${spec}`);
    npm(["install", `${PACKAGE}@${spec}`, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"]);
  }

  // node-gyp-build loads build/Release ahead of prebuilds, and reports "already
  // built" when either exists. Removing both forces one from-source compile, with
  // the wrong-architecture prebuild that caused this gone for good.
  const installed = packageRoot();
  for (const stale of ["prebuilds", "build"]) {
    rmSync(join(installed, stale), { recursive: true, force: true });
  }
  npm(["rebuild", PACKAGE, "--no-audit", "--no-fund"]);
}

if (!process.env[RECURSION_GUARD] && !grammarWorks()) {
  console.error(
    `[native-grammar] ${PACKAGE} does not load on ${process.platform}/${process.arch}; rebuilding from source`,
  );
  try {
    heal();
  } catch (error) {
    console.error(`[native-grammar] rebuild failed: ${error.message}`);
  }
  if (grammarWorksInFreshProcess()) {
    console.error(`[native-grammar] OK — ${PACKAGE} loads after the rebuild`);
  } else {
    console.error(
      `[native-grammar] WARNING: ${PACKAGE} still does not load. Install a C/C++ toolchain ` +
        "(build-essential on Linux) and re-run `npm run rebuild:native`. TypeScript/TSX " +
        "extraction warns per file until then; nothing else is affected.",
    );
  }
}

process.exit(0);
