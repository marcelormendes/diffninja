import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDirectoryProblem, grammarStatus, installPinnedGrammars } from "../src/languages/grammars.js";

/**
 * Installs the pinned grammars once for the whole test run, with the same
 * explicit installer users run (`diffninja grammars install`). Reviews never
 * download anything, so every test that parses Python, Go or Java depends on
 * this cache. Workers read it in place (see setup-worker.ts).
 */
export const MASTER_GRAMMAR_CACHE = join(tmpdir(), "diffninja-grammar-test-cache", "master");

export default function setup(): void {
  mkdirSync(MASTER_GRAMMAR_CACHE, { recursive: true, mode: 0o700 });
  // The path is predictable, and on Linux the temporary directory is shared. Whoever can write
  // either level could swap in grammars of their own, and every test worker loads them.
  for (const dir of [dirname(MASTER_GRAMMAR_CACHE), MASTER_GRAMMAR_CACHE]) {
    const problem = cacheDirectoryProblem(dir);
    if (problem !== undefined) throw new Error(`grammar test cache: ${problem}. Remove it, or point TMPDIR at a directory of your own.`);
  }
  const status = grammarStatus(MASTER_GRAMMAR_CACHE);
  if (status.trusted && status.packages.every((entry) => entry.installed)) return;
  try {
    // The Kotlin and Perl grammars have no prebuilt binary: their tests need the opt-in source build.
    installPinnedGrammars({ cacheDir: MASTER_GRAMMAR_CACHE, build: true });
  } catch (error) {
    console.error(`grammar test cache: the source build failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); Kotlin and Perl tests will fail without a compiler.`);
    installPinnedGrammars({ cacheDir: MASTER_GRAMMAR_CACHE });
  }
}
