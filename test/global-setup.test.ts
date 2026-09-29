import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GRAMMAR_PINS } from "../src/languages/grammar-lock.js";
import { grammarStatus, installPinnedGrammars } from "../src/languages/grammars.js";

/** A cache like the one a machine without a compiler ends up with: every prebuilt grammar, and Kotlin and Perl never built. */
function unbuiltCache(cacheDir: string): void {
  installPinnedGrammars({
    cacheDir,
    runNpm: (cwd, args) => {
      if (args[0] !== "ci") return;
      for (const [name, version] of Object.entries(GRAMMAR_PINS)) {
        mkdirSync(join(cwd, "node_modules", name), { recursive: true });
        writeFileSync(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
      }
    },
  });
}

let scratch = "";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the test run's grammar cache", () => {
  // Without a compiler the source build fails every time, so reinstalling downloaded about 0.7 GB on every run.
  test.skipIf(process.platform === "win32")("is kept when only the grammars a failed source build left out are missing, and nothing is downloaded", async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "diffninja-global-setup-")));
    const cacheDir = join(scratch, "diffninja-grammar-test-cache", "master");
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    unbuiltCache(cacheDir);
    const marker = readFileSync(join(cacheDir, ".diffninja-grammars.json"), "utf8");
    expect(grammarStatus(cacheDir).packages.filter((entry) => !entry.installed).map((entry) => entry.name).sort()).toEqual(["tree-sitter-kotlin", "tree-sitter-perl"]);

    vi.stubEnv("TMPDIR", scratch);
    // Any npm run would fail here instead of reaching the network.
    vi.stubEnv("PATH", join(scratch, "no-npm"));
    const notices: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => { notices.push(line); });
    vi.resetModules();
    const { default: setup, MASTER_GRAMMAR_CACHE } = await import("./global-setup.js");
    expect(MASTER_GRAMMAR_CACHE).toBe(cacheDir);

    expect(() => setup()).not.toThrow();
    expect(readFileSync(join(cacheDir, ".diffninja-grammars.json"), "utf8")).toBe(marker);
    expect(notices.join("\n")).toContain("tree-sitter-kotlin and tree-sitter-perl were not compiled");
  });
});
