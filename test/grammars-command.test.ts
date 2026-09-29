import { describe, expect, test } from "vitest";
import { GRAMMAR_PINS } from "../src/languages/grammar-lock.js";
import { runGrammars, type GrammarsDependencies } from "../src/review/grammars-command.js";

function harness(overrides: Partial<GrammarsDependencies> = {}) {
  const lines: string[] = [];
  const installs: Array<{ build?: boolean }> = [];
  const deps: GrammarsDependencies = {
    install: (options) => { installs.push(options); return { cacheDir: "/cache", packages: Object.entries(GRAMMAR_PINS).map(([name, version]) => ({ name, version })) }; },
    status: () => ({ cacheDir: "/cache", trusted: false, packages: Object.entries(GRAMMAR_PINS).map(([name, version]) => ({ name, version, installed: false, needsBuild: name === "tree-sitter-kotlin" })) }),
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, lines, installs };
}

describe("diffninja grammars", () => {
  test("explains itself, and says that reviews never download or build anything", () => {
    const { deps, lines } = harness();
    runGrammars([], deps);
    expect(lines.join("\n")).toMatch(/only when you run it/);
    expect(lines.join("\n")).toMatch(/Reviews never download or build anything/);
  });

  test("--dry-run lists the pinned packages and installs nothing", () => {
    const { deps, lines, installs } = harness();
    runGrammars(["install", "--dry-run"], deps);
    expect(installs).toEqual([]);
    expect(lines.join("\n")).toContain(`tree-sitter-python@${GRAMMAR_PINS["tree-sitter-python"]}`);
    expect(lines[0]).toMatch(/install scripts off/);
  });

  test("install passes --build only when given, and prints what it installed", () => {
    const first = harness();
    runGrammars(["install"], first.deps);
    expect(first.installs).toEqual([{ build: false }]);
    expect(first.lines.at(-1)).toMatch(/Done/);
    const second = harness();
    runGrammars(["install", "--build"], second.deps);
    expect(second.installs).toEqual([{ build: true }]);
  });

  test("status shows what is missing and which grammars need a build", () => {
    const { deps, lines } = harness();
    runGrammars(["status"], deps);
    expect(lines[0]).toContain("nothing installed by this diffninja yet");
    expect(lines.find((line) => line.includes("tree-sitter-kotlin"))).toContain("(needs --build)");
    expect(lines.find((line) => line.includes("tree-sitter-python"))).not.toContain("needs --build");
    expect(lines.at(-1)).toContain("grammars install");
  });

  test("refuses arguments, unknown commands and unknown flags", () => {
    const { deps } = harness();
    expect(() => runGrammars(["install", "python"], deps)).toThrow(/takes no arguments/);
    expect(() => runGrammars(["remove"], deps)).toThrow(/Unknown grammars command/);
    expect(() => runGrammars(["install", "--registry=https://evil.example"], deps)).toThrow();
  });
});
