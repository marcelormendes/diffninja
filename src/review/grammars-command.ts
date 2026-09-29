import { parseArgs } from "node:util";
import { GRAMMAR_PINS } from "../languages/grammar-lock.js";
import { grammarCacheDir, grammarStatus, installPinnedGrammars, type GrammarStatus, type InstalledGrammars } from "../languages/grammars.js";

export const grammarsHelp = `diffninja grammars. Downloads grammar code through npm, and only when you run it.

  diffninja grammars install [--build] [--dry-run]
      Install the tree-sitter grammars call flows need for languages other than
      JavaScript and TypeScript (Python, Go, Java, Rust, C, C++, C#, Ruby, PHP,
      Swift, Scala, Bash, Lua, Zig, Elixir, Haskell, OCaml, Solidity). Exact
      versions, checked against the sha512 of every tarball in the lock that ships
      with this diffninja, and no install script of any package is run.
      --build also compiles the Kotlin and Perl grammars, which ship no prebuilt
      binary: that runs their install script (node-gyp) and needs Python and a C/C++
      compiler.
  diffninja grammars status
      Show what is installed and where.

Reviews never download or build anything: without these grammars, files in those
languages are skipped by call flows and the review says so.
`;

export interface GrammarsDependencies {
  install: (options: { cacheDir?: string; build?: boolean }) => InstalledGrammars;
  status: () => GrammarStatus;
  log: (line: string) => void;
}

const real: GrammarsDependencies = { install: installPinnedGrammars, status: () => grammarStatus(), log: (line) => console.log(line) };

/** `diffninja grammars ...`; throws a message-only Error for bad usage. */
export function runGrammars(args: readonly string[], deps: GrammarsDependencies = real): void {
  const [action, ...rest] = args;
  if (action === undefined || action === "--help" || action === "-h" || action === "help") {
    deps.log(grammarsHelp);
    return;
  }
  const { values, positionals } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" }, build: { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: true });
  if (values.help) { deps.log(grammarsHelp); return; }
  if (positionals.length > 0) throw new Error(`grammars ${action} takes no arguments. Use --help.`);
  if (action === "status") {
    const status = deps.status();
    deps.log(`Cache: ${status.cacheDir}${status.trusted ? "" : " (nothing installed by this diffninja yet)"}`);
    for (const entry of status.packages) deps.log(`  ${entry.installed ? "installed" : "missing  "}  ${entry.name}@${entry.version}${entry.installed || !entry.needsBuild ? "" : "  (needs --build)"}`);
    if (status.packages.some((entry) => !entry.installed)) deps.log("Run `diffninja grammars install` (add --build for the ones marked) to add the missing ones.");
    return;
  }
  if (action !== "install") throw new Error(`Unknown grammars command "${action}". Use install or status.`);
  const names = Object.entries(GRAMMAR_PINS).map(([name, version]) => `${name}@${version}`);
  const build = values.build === true;
  if (values["dry-run"]) {
    deps.log(`Would install into ${grammarCacheDir()} (npm ci from the lock shipped with diffninja, install scripts off${build ? ", then a source build of the Kotlin and Perl grammars" : ""}):`);
    for (const name of names) deps.log(`  ${name}`);
    return;
  }
  deps.log(`Installing ${names.length} pinned grammars into ${grammarCacheDir()} (integrity-checked, install scripts off${build ? "; compiling Kotlin and Perl" : ""})...`);
  const installed = deps.install({ build });
  for (const entry of installed.packages) deps.log(`  ${entry.name}@${entry.version}`);
  deps.log("Done. The next review uses them; nothing needs restarting.");
}
