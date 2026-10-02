import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { loadRepairedGrammar, mislabeledPrebuild, npmSpawnSpec } from "../src/languages/grammars.js";

test("Windows npm execution preserves cache paths without shell expansion", () => {
  const directory = mkdtempSync(join(tmpdir(), "diffninja npm "));
  try {
    const bin = join(directory, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    vi.stubEnv("PATH", `;.;"${directory}"`);
    const args = ["install", "--prefix", "C:\\\\Users\\\\A & B\\\\%TEMP% !cache\\\\", "tree-sitter-python"];
    const spec = npmSpawnSpec(args, "win32");
    const received: unknown = JSON.parse(execFileSync(spec.file, spec.args, { encoding: "utf8" }));
    expect(received).toEqual(args);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-Windows npm execution uses the npm shim directly", () => {
  const args = ["install", "--prefix", "/tmp/cache", "tree-sitter-python"];
  expect(npmSpawnSpec(args, "linux")).toEqual({ file: "npm", args });
  expect(npmSpawnSpec(args, "darwin")).toEqual({ file: "npm", args });
});

// Skip where the host Node ships npm beside it: the fallback then finds a real
// npm-cli.js and there is nothing missing to report.
const adjacentNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const noAdjacentNpm = !existsSync(adjacentNpmCli);
test.skipIf(!noAdjacentNpm)("Windows npm execution without npm-cli.js throws an actionable error", () => {
  vi.stubEnv("PATH", ";.");
  try {
    expect(() => npmSpawnSpec(["install"], "win32")).toThrow(/npm-cli\.js/);
  } finally {
    vi.unstubAllEnvs();
  }
});

/** Minimal native header for the given platform family and machine type. */
function headerFor(machine: number): Buffer {
  const header = Buffer.alloc(64, 0);
  if (process.platform === "linux") {
    header.writeUInt8(0x7f, 0);
    header.write("ELF", 1);
    header.writeUInt16LE(machine, 18);
  } else if (process.platform === "darwin") {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(machine, 4);
  } else {
    header.write("MZ", 0);
    header.writeUInt32LE(0x20, 0x3c);
    header.writeUInt16LE(machine, 0x20);
  }
  return header;
}

function machineFor(arch: string): number {
  if (process.platform === "linux") return arch === "x64" ? 62 : 183;
  if (process.platform === "darwin") return arch === "x64" ? 0x01000007 : 0x0100000c;
  return arch === "x64" ? 0x8664 : 0xaa64;
}

function prebuildRoot(machine: number) {
  const root = mkdtempSync(join(tmpdir(), "diffninja prebuild "));
  const dir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "binding.node");
  writeFileSync(file, headerFor(machine));
  return { root, file };
}

test("mislabeledPrebuild reports a prebuild for another CPU", () => {
  const otherArch = process.arch === "x64" ? "arm64" : "x64";
  const { root, file } = prebuildRoot(machineFor(otherArch));
  try {
    expect(mislabeledPrebuild(root)).toBe(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mislabeledPrebuild ignores a prebuild for this CPU", () => {
  const { root } = prebuildRoot(machineFor(process.arch));
  try {
    expect(mislabeledPrebuild(root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mislabeledPrebuild returns null without a prebuild directory", () => {
  const root = mkdtempSync(join(tmpdir(), "diffninja prebuild "));
  try {
    expect(mislabeledPrebuild(root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mislabeledPrebuild skips unreadable prebuild files", () => {
  const root = mkdtempSync(join(tmpdir(), "diffninja prebuild "));
  const dir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "binding.node"), Buffer.from([1, 2, 3]));
    expect(mislabeledPrebuild(root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stand-in for the copy the postinstall repair keeps: a package whose entry is index.js. */
function repairedCopy(entry: string) {
  const directory = mkdtempSync(join(tmpdir(), "diffninja native grammar "));
  const packageRoot = join(directory, "tree-sitter-typescript");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "tree-sitter-typescript", main: "index.js" }));
  writeFileSync(join(packageRoot, "index.js"), entry);
  return directory;
}

test("loadRepairedGrammar loads the copy the postinstall repair kept", () => {
  const directory = repairedCopy("module.exports = { typescript: { repaired: true } };");
  try {
    expect(loadRepairedGrammar("tree-sitter-typescript", directory)).toEqual({ typescript: { repaired: true } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadRepairedGrammar returns undefined when there is no copy or it does not load", () => {
  const empty = mkdtempSync(join(tmpdir(), "diffninja native grammar "));
  const broken = repairedCopy("throw new Error('wrong CPU');");
  try {
    expect(loadRepairedGrammar("tree-sitter-typescript", empty)).toBeUndefined();
    expect(loadRepairedGrammar("tree-sitter-typescript", broken)).toBeUndefined();
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});
