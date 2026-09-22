import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve("src/review/cli.ts");
const patch = resolve("examples/review/checkout.patch");
const tsx = import.meta.resolve("tsx");

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsx, cli, ...args], { encoding: "utf8" });
}

describe("diffninja command", () => {
  it("prints setup-only help with no arguments or --help", () => {
    for (const args of [[], ["--help"]]) {
      const result = run(...args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("diffninja setup");
      expect(result.stdout).toContain("review_diff");
      expect(result.stdout).not.toContain("--diff PATH");
    }
  });

  it("routes setup --help to the setup help", () => {
    const result = run("setup", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--uninstall");
  });

  it("has no terminal review mode and points to the agent instead of reviewing anything", () => {
    for (const args of [
      ["--diff", patch, "--mock"],
      ["https://github.com/owner/repo/pull/1"],
      ["serve"],
      ["--stdin"],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("run inside an agent CLI");
      expect(result.stderr).toContain("diffninja setup");
      // Nothing is echoed back: pasted arguments may hold anything.
      expect(result.stderr).not.toContain("owner/repo");
      expect(result.stdout).toBe("");
    }
  });

  it("rejects positional arguments to setup", () => {
    const result = run("setup", "extra");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no positional arguments");
  });
});
