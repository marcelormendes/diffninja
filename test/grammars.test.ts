import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { npmSpawnSpec } from "../src/languages/grammars.js";

test("Windows npm execution preserves cache paths without shell expansion", () => {
  const directory = mkdtempSync(join(tmpdir(), "diffninja npm "));
  try {
    const bin = join(directory, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    vi.stubEnv("PATH", `;.;"${directory}"`);
    const args = ["install", "--prefix", "C:\\Users\\A & B\\%TEMP% !cache\\", "tree-sitter-python"];
    const spec = npmSpawnSpec(args, "win32");
    const received: unknown = JSON.parse(execFileSync(spec.file, spec.args, { encoding: "utf8" }));
    expect(received).toEqual(args);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
