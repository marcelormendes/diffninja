#!/usr/bin/env node
// Postinstall heal for the native tree-sitter bindings diffninja ships with: the
// parser and the JavaScript and TypeScript grammars.
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
// npm can still delete the package after this script ran (see keepRepairedCopy),
// so a grammar compiled on this machine is also copied into `native-grammar/`,
// which the loader falls back to.
//
// npm 12 blocks dependency install scripts unless they are allowed by name, so
// a plain `npm install -g diffninja` builds nothing: where a prebuild does not
// load (the TypeScript grammar on Linux ARM64, or a parser prebuild that needs a
// newer libstdc++ than the system has) nothing works. `diffninja setup` runs this
// script after it installs, and it rebuilds whichever of the three packages does
// not load. The rebuilds run with diffninja's own package.json as the project,
// whose `allowScripts` field names the three packages: npm 12 refuses
// `--allow-scripts` on the command line inside a project.
//
// This is a heal, not a gate: it always exits 0, including when no C/C++ toolchain
// is present. Extraction degrades to a per-file warning in that case, and a user
// can retry later by running this script again.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one grammar package with a broken prebuild; see the header comment. */
const PACKAGE = "tree-sitter-typescript";
/** The native packages this script checks and rebuilds, in build order. */
const NATIVE_PACKAGES = ["tree-sitter", "tree-sitter-javascript", PACKAGE];
/** What loads each package on its own, so a failure names the package to rebuild. */
const LOAD_PROBES = {
  "tree-sitter": 'new (require("tree-sitter"))();',
  "tree-sitter-javascript": 'require("tree-sitter-javascript");',
  [PACKAGE]: `require(${JSON.stringify(PACKAGE)});`,
};
/** Parse shape used by the probe: TypeScript syntax only this grammar accepts. */
const PROBE_SOURCE = "const x: number = 1;";
/** Set for the nested npm calls below, which re-enter this package's lifecycle. */
const RECURSION_GUARD = "DIFFNINJA_NATIVE_GRAMMAR_HEAL";
/** Generous for a source compile; a hung npm must not hang the install forever. */
const NPM_TIMEOUT_MS = 900_000;
/**
 * Where the repaired grammar is kept, relative to diffninja's package root. The
 * loader (`loadRepairedGrammar` in src/languages/grammars.ts) falls back to it.
 */
const REPAIRED_DIR = "native-grammar";
/** What the grammar needs at run time: its entry, the compiled binding and the node types. */
const RUNTIME_FILES = [
  "package.json",
  "bindings/node/index.js",
  "typescript/src/node-types.json",
  "tsx/src/node-types.json",
];

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

/**
 * Real end-to-end check: require the parser and both grammars, set each language
 * and parse. A prebuild that exists but targets another CPU, or needs a newer C++
 * library than the system has, fails here, which is the only reliable signal —
 * the file is present and its wrapper loads.
 */
function grammarWorks() {
  try {
    const Parser = require("tree-sitter");
    const parser = new Parser();
    parser.setLanguage(require("tree-sitter-javascript"));
    parser.parse("let a = 1;");
    parser.setLanguage(require(PACKAGE).typescript);
    parser.parse(PROBE_SOURCE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same parse, in a child process, of the installed package or of the directory
 * `grammar` names. The in-process probe above already failed once
 * in this process, and an installer's process is a poor place to judge the result
 * of an install it just performed; a fresh process is what the next `diffninja`
 * run will do. Run with `-e` and cwd at the package root, so a bare `require`
 * resolves through the same `node_modules` chain the CLI uses. Only the failure
 * reason is echoed — a child's full stack trace would bury the outcome line.
 */
function grammarWorksInFreshProcess(grammar = PACKAGE) {
  return worksInFreshProcess(`
    const Parser = require("tree-sitter");
    const parser = new Parser();
    parser.setLanguage(require("tree-sitter-javascript"));
    parser.parse("let a = 1;");
    parser.setLanguage(require(${JSON.stringify(grammar)}).typescript);
    parser.parse(${JSON.stringify(PROBE_SOURCE)});
  `);
}

/** Whether `script` runs without an error in a fresh Node process at the package root. */
function worksInFreshProcess(script, quiet = false) {
  try {
    execFileSync(process.execPath, ["-e", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (quiet) return false;
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
function packageRoot(name = PACKAGE) {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (readJson(manifest)?.name === name) return dirname(manifest);
    if (dirname(dir) === dir) throw new Error(`Cannot locate the installed ${name} directory`);
  }
}

/**
 * The native packages that do not load, in build order. When each loads on its
 * own and only the parse fails, all of them are rebuilt, since the probe cannot
 * tell which one is wrong.
 */
function brokenPackages() {
  const broken = NATIVE_PACKAGES.filter(name => !worksInFreshProcess(LOAD_PROBES[name], true));
  return broken.length > 0 ? broken : [...NATIVE_PACKAGES];
}

function heal(broken) {
  const manifest = readJson(join(root, "package.json"));
  const spec = manifest?.optionalDependencies?.[PACKAGE] ?? manifest?.dependencies?.[PACKAGE] ?? "latest";
  // Every npm call below runs with diffninja's own package.json as the project,
  // even when npm started this script from a global install, so the packages it
  // touches are diffninja's own and npm 12 reads the `allowScripts` field there.
  const env = { ...process.env, [RECURSION_GUARD]: "1", npm_config_global: "false", npm_config_location: "project" };
  if (process.platform !== "win32") env.CXXFLAGS = withCxx20(process.env.CXXFLAGS);
  const npm = args => {
    const { file, args: argv } = npmSpawnSpec(args);
    execFileSync(file, argv, { cwd: root, env, stdio: "inherit", timeout: NPM_TIMEOUT_MS });
  };

  // npm removes an optional dependency whose install script failed, so the package
  // may be absent rather than merely broken. Fetch it without running its scripts:
  // the compile below is the single source of truth for the binding.
  //
  // `--omit=dev` only in an installed copy: in a checkout, `npm install <spec>`
  // reconciles the whole tree and would delete a developer's devDependencies
  // (measured: 54 packages removed), while in an installed copy, which is the
  // project here, leaving it out would install diffninja's devDependencies.
  if (broken.includes(PACKAGE) && !existsSync(join(root, "node_modules", PACKAGE, "package.json"))) {
    console.error(`[native-grammar] ${PACKAGE} is missing; fetching ${spec}`);
    const installedCopy = root.split(/[\\/]/).includes("node_modules");
    npm(["install", `${PACKAGE}@${spec}`, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", ...(installedCopy ? ["--omit=dev"] : [])]);
  }

  // node-gyp-build loads build/Release ahead of prebuilds, and reports "already
  // built" when either exists. Removing both forces one from-source compile, with
  // the prebuild that did not load gone for good. One package at a time: builds
  // that npm runs side by side can fail on Linux ARM64.
  for (const name of broken) {
    try {
      const installed = packageRoot(name);
      for (const stale of ["prebuilds", "build"]) {
        rmSync(join(installed, stale), { recursive: true, force: true });
      }
      npm(["rebuild", name, "--no-audit", "--no-fund"]);
    } catch (error) {
      console.error(`[native-grammar] rebuilding ${name} failed: ${error.message}`);
    }
  }
}

/**
 * Copy the grammar compiled on this machine into `native-grammar/` at
 * diffninja's own root.
 *
 * Why: when an install script under the package failed (on Linux ARM64 a
 * node-gyp build can fail while npm runs install scripts in parallel), npm
 * marks the optional dependency failed and deletes its directory at the end of
 * the install, after this script has run, whether it repaired the package or
 * found it already working. npm does not track this
 * directory, so the copy survives, and the loader falls back to it when the
 * package itself is gone. Written beside the target and renamed into place, so
 * a half-written copy is never the one loaded.
 */
function keepRepairedCopy(announce) {
  const installed = packageRoot();
  const target = join(root, REPAIRED_DIR, PACKAGE);
  const staging = `${target}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  for (const file of RUNTIME_FILES) cpSync(join(installed, file), join(staging, file));
  // node-gyp-build loads the first binding it finds under build/Release.
  const release = join(installed, "build", "Release");
  mkdirSync(join(staging, "build", "Release"), { recursive: true });
  cpSync(release, join(staging, "build", "Release"), {
    recursive: true,
    filter: source => source === release || source.endsWith(".node"),
  });
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  if (!grammarWorksInFreshProcess(target)) throw new Error(`the copy in ${target} does not load`);
  if (announce) console.error(`[native-grammar] kept the rebuilt grammar in ${join(REPAIRED_DIR, PACKAGE)}`);
}

/**
 * The installed grammar loads from a binding compiled on this machine rather
 * than a shipped prebuild. Such a package is the one npm may still delete: its
 * own build, or that of the `tree-sitter-javascript` npm nests under it, ran in
 * an install script that can fail, and npm removes the optional dependency
 * when either does, even after the package itself built and loads.
 */
function builtOnThisMachine() {
  try {
    const release = join(packageRoot(), "build", "Release");
    return readdirSync(release).some(name => name.endsWith(".node"));
  } catch {
    return false;
  }
}

function keepCopy(announce) {
  try {
    keepRepairedCopy(announce);
  } catch (error) {
    console.error(`[native-grammar] could not keep a copy of the rebuilt grammar: ${error.message}`);
  }
}

if (!process.env[RECURSION_GUARD]) {
  const works = grammarWorks();
  if (!works) {
    const broken = brokenPackages();
    console.error(
      `[native-grammar] ${broken.join(", ")} ${broken.length === 1 ? "does" : "do"} not load on ${process.platform}/${process.arch}; rebuilding from source`,
    );
    heal(broken);
    if (grammarWorksInFreshProcess()) {
      console.error("[native-grammar] OK — the parser and the JavaScript and TypeScript grammars load after the rebuild");
    } else {
      console.error(
        "[native-grammar] WARNING: the parser or a grammar still does not load. Install a C/C++ " +
          "toolchain and Python (build-essential and python3 on Linux), then run " +
          `\`node ${JSON.stringify(fileURLToPath(import.meta.url))}\` or \`npx -y diffninja@latest setup\` again. ` +
          "Call flows skip the files they cannot parse until then.",
      );
    }
  }
  // Refreshed quietly on every run, so the copy always matches the package's build.
  if (builtOnThisMachine()) keepCopy(!works);
}

process.exit(0);
