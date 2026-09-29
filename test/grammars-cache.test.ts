import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { GRAMMAR_BUILD_ONLY, GRAMMAR_PACKAGE_JSON, GRAMMAR_PACKAGE_LOCK, GRAMMAR_PINS } from "../src/languages/grammar-lock.js";
import { GrammarNotInstalledError, grammarLockDigest, grammarStatus, installPinnedGrammars, loadGrammarPackage, takeMissingGrammars } from "../src/languages/grammars.js";

const lockSchema = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional(), integrity: z.string().optional(), resolved: z.string().optional(), dependencies: z.record(z.string(), z.string()).optional() })),
});

let cache: string;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), "diffninja-grammar-cache-")); vi.stubEnv("DIFFNINJA_GRAMMAR_CACHE", cache); takeMissingGrammars(); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); });

/** What `npm ci` leaves behind, without a network: each pinned package as a directory with its manifest. */
function fakeNpm(options: { versions?: Record<string, string>; calls?: string[][] } = {}) {
  return (cwd: string, args: string[]) => {
    options.calls?.push(args);
    if (args[0] !== "ci") return;
    for (const [name, version] of Object.entries(GRAMMAR_PINS)) {
      const dir = join(cwd, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: options.versions?.[name] ?? version, main: "index.js" }));
      writeFileSync(join(dir, "index.js"), "module.exports = { fake: true };");
    }
  };
}

describe("the pinned grammar lock", () => {
  test("pins exact versions, and every tarball in the lock has a sha512 and comes from the public registry", () => {
    for (const [name, version] of Object.entries(GRAMMAR_PINS)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GRAMMAR_PACKAGE_JSON.dependencies).toEqual(GRAMMAR_PINS);
    const { packages } = lockSchema.parse(GRAMMAR_PACKAGE_LOCK);
    expect(packages[""]?.dependencies).toEqual(GRAMMAR_PINS);
    for (const [path, entry] of Object.entries(packages)) {
      if (path === "") continue;
      expect(entry.integrity, path).toMatch(/^sha512-/);
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    for (const [name, version] of Object.entries(GRAMMAR_PINS)) expect(packages[`node_modules/${name}`]?.version, name).toBe(version);
  });

  test("names the grammars that need a source build, and they are pinned like the rest", () => {
    expect([...GRAMMAR_BUILD_ONLY].sort()).toEqual(["tree-sitter-kotlin", "tree-sitter-perl"]);
    for (const name of GRAMMAR_BUILD_ONLY) expect(GRAMMAR_PINS).toHaveProperty(name);
  });
});

describe("a review never downloads a grammar", () => {
  test("without an installed cache the grammar is reported missing, not fetched", () => {
    expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(GrammarNotInstalledError);
    expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(/npx diffninja grammars install/);
    expect(takeMissingGrammars()).toEqual(["tree-sitter-python"]);
    expect(takeMissingGrammars()).toEqual([]);
  });

  test("a package that is not one of the pinned grammars is refused even if it sits in the cache", () => {
    mkdirSync(join(cache, "node_modules", "tree-sitter-cobol"), { recursive: true });
    writeFileSync(join(cache, "node_modules", "tree-sitter-cobol", "package.json"), JSON.stringify({ name: "tree-sitter-cobol", version: "1.0.0" }));
    expect(() => loadGrammarPackage("tree-sitter-cobol")).toThrow(/not one of the grammars diffninja installs/);
  });

  test("a cache nobody installed with this lock is not trusted: no marker, another lock's marker, or a wrong version", () => {
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    expect(grammarStatus(cache).trusted).toBe(true);
    expect(loadGrammarPackage("tree-sitter-python")).toEqual({ fake: true });

    const marker = join(cache, ".diffninja-grammars.json");
    const good = readFileSync(marker, "utf8");
    writeFileSync(marker, good.replace(grammarLockDigest(), "0".repeat(64)));
    expect(grammarStatus(cache).trusted).toBe(false);
    expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(GrammarNotInstalledError);

    writeFileSync(marker, good);
    writeFileSync(join(cache, "node_modules", "tree-sitter-python", "package.json"), JSON.stringify({ name: "tree-sitter-python", version: "9.9.9" }));
    expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(GrammarNotInstalledError);

    rmSync(marker);
    writeFileSync(join(cache, "node_modules", "tree-sitter-python", "package.json"), JSON.stringify({ name: "tree-sitter-python", version: GRAMMAR_PINS["tree-sitter-python"] }));
    expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(GrammarNotInstalledError);
    expect(grammarStatus(cache).packages.every((entry) => !entry.installed)).toBe(true);
  });

  // The marker holds only public data, so the directory's owner and mode are what make it trustworthy.
  test.skipIf(process.platform === "win32")("a cache other users can write is not trusted, whatever its marker says", () => {
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    for (const mode of [0o777, 0o775, 0o757]) {
      chmodSync(cache, mode);
      expect(grammarStatus(cache).trusted, mode.toString(8)).toBe(false);
      expect(() => loadGrammarPackage("tree-sitter-python"), mode.toString(8)).toThrow(GrammarNotInstalledError);
    }
    chmodSync(cache, 0o755);
    expect(loadGrammarPackage("tree-sitter-python")).toEqual({ fake: true });
  });

  test.skipIf(process.platform === "win32")("a cache that belongs to another user is not trusted, and install refuses to write into it", () => {
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    const owner = statSync(cache).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    try {
      expect(grammarStatus(cache).trusted).toBe(false);
      expect(() => loadGrammarPackage("tree-sitter-python")).toThrow(GrammarNotInstalledError);
      const calls: string[][] = [];
      expect(() => installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm({ calls }) })).toThrow(`Refusing to install grammars: ${cache} belongs to another user (uid ${owner})`);
      expect(calls).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("the grammars diffninja ships itself load from its own dependencies, not from the cache", () => {
    expect(loadGrammarPackage("tree-sitter-typescript")).toBeTruthy();
    expect(loadGrammarPackage("tree-sitter-javascript")).toBeTruthy();
    expect(takeMissingGrammars()).toEqual([]);
  });

  test("Kotlin and Perl stay unavailable until their source build was asked for", () => {
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    expect(() => loadGrammarPackage("tree-sitter-kotlin")).toThrow(/npx diffninja grammars install --build/);
    expect(loadGrammarPackage("tree-sitter-go")).toEqual({ fake: true });
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm(), build: true });
    expect(loadGrammarPackage("tree-sitter-kotlin")).toEqual({ fake: true });
  });
});

describe("installPinnedGrammars", () => {
  test("installs from the shipped lock with install scripts off, in a private directory, and marks the cache only at the end", () => {
    const calls: string[][] = [];
    const target = join(cache, "fresh");
    const result = installPinnedGrammars({ cacheDir: target, runNpm: fakeNpm({ calls }) });
    expect(calls).toEqual([["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]]);
    expect(JSON.parse(readFileSync(join(target, "package-lock.json"), "utf8"))).toEqual(GRAMMAR_PACKAGE_LOCK);
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toEqual(GRAMMAR_PACKAGE_JSON);
    expect(result.packages.map((entry) => entry.name)).toEqual(Object.keys(GRAMMAR_PINS));
    expect(JSON.parse(readFileSync(join(target, ".diffninja-grammars.json"), "utf8"))).toMatchObject({ format: 1, lockSha256: grammarLockDigest(), built: false });
    if (process.platform !== "win32") expect(statMode(target)).toBe(0o700);
  });

  test.skipIf(process.platform === "win32")("install makes an existing directory of one's own private, so the cache it fills is trusted", () => {
    chmodSync(cache, 0o775);
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    expect(statMode(cache)).toBe(0o700);
    expect(grammarStatus(cache).trusted).toBe(true);
  });

  test("runs an install script only for the two build-only grammars, and only when asked", () => {
    const calls: string[][] = [];
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm({ calls }), build: true });
    expect(calls.map((args) => args[0])).toEqual(["ci", "rebuild"]);
    expect(calls[1]!.filter((arg) => arg.startsWith("tree-sitter-"))).toEqual([...GRAMMAR_BUILD_ONLY]);
    expect(calls[0]).toContain("--ignore-scripts");
    expect(JSON.parse(readFileSync(join(cache, ".diffninja-grammars.json"), "utf8")).built).toBe(true);
  });

  test("a failed or mismatched install leaves the cache untrusted, and an earlier trusted one is not left trusted", () => {
    installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm() });
    expect(grammarStatus(cache).trusted).toBe(true);
    expect(() => installPinnedGrammars({ cacheDir: cache, runNpm: () => { throw new Error("npm could not install the grammars: offline"); } })).toThrow(/offline/);
    expect(grammarStatus(cache).trusted).toBe(false);
    expect(() => installPinnedGrammars({ cacheDir: cache, runNpm: fakeNpm({ versions: { "tree-sitter-go": "0.0.1" } }) })).toThrow(/tree-sitter-go@.* is not in .* after the install \(found 0\.0\.1\)/);
    expect(grammarStatus(cache).trusted).toBe(false);
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
