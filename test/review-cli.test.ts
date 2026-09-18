import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const cli = resolve("src/review/cli.ts");
const patch = resolve("examples/review/checkout.patch");

describe("Prismr command", () => {
  it("includes changed calldiff call paths for a git range", () => {
    const dir = mkdtempSync(join(tmpdir(), "prismr-git-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), "export function checkout() { authorize(); charge(); }\nfunction authorize() {}\nfunction charge() {}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), "export function checkout() { charge(); }\nfunction authorize() {}\nfunction charge() {}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "head"], { cwd: dir });
      const out = join(dir, "review.html");
      execFileSync(process.execPath, ["--import", "tsx", cli, "--repo", dir, "--from", "HEAD~1", "--to", "HEAD", "--mock", "--out", out]);
      const report = JSON.parse(readFileSync(out + ".json", "utf8"));
      expect(report.callFlow.join("\n")).toContain("authorize");
      expect(report.items[0].callFlow.join("\n")).toContain("authorize");
      expect(report.items[0].file).toBe("checkout.ts");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reviews the realistic patch through file and stdin inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "prismr-cli-"));
    try {
      const out = join(dir, "report.html");
      execFileSync(process.execPath, ["--import", "tsx", cli, "--diff", patch, "--mock", "--out", out]);
      const fileReport = JSON.parse(readFileSync(out + ".json", "utf8"));
      expect(fileReport.items).toHaveLength(5);
      expect(fileReport.mode).toBe("mock");
      expect(fileReport.items.some((item: { status: string }) => item.status === "passed")).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("Prismr");
      execFileSync(process.execPath, ["--import", "tsx", cli, "--stdin", "--mock", "--out", out], { input: readFileSync(patch) });
      const stdinReport = JSON.parse(readFileSync(out + ".json", "utf8"));
      expect(stdinReport.items).toEqual(fileReport.items);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses live review without credentials", () => {
    const env = { ...process.env, TYPESAFE_API_KEY: "" };
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--diff", patch], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });
  it("rejects ambiguous input modes", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--diff", patch, "--stdin", "--mock"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one input");
  });
});
