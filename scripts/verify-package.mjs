#!/usr/bin/env node
// Exercise the actual global-install layout without touching the user's prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argument = process.argv[2];
assert(argument, "Usage: node scripts/verify-package.mjs <tarball-or-directory>");
const input = resolve(argument);
const tarballs = input.endsWith(".tgz") ? [input]
  : readdirSync(input).filter(name => name.endsWith(".tgz")).map(name => join(input, name));
assert.equal(tarballs.length, 1, "Expected exactly one tarball");
const windows = process.platform === "win32";
// No spaces: ARM64 Linux rebuilds mislabeled tree-sitter prebuilds from source,
// and node-gyp generated Makefiles break on spaces in the path. Spaces in
// paths are still exercised via the grammar cache directory below.
const sandbox = mkdtempSync(join(tmpdir(), "diffninja-package-"));
const prefix = join(sandbox, "prefix");
const packageDir = join(prefix, windows ? "node_modules" : "lib/node_modules", "diffninja");
const isolatedEnv = { ...process.env, npm_config_cache: join(sandbox, "npm cache") };
const run = (file, args, options = {}) => execFileSync(file, args, {
  cwd: sandbox, env: isolatedEnv, encoding: "utf8", timeout: 180_000, ...options,
});
const filesUnder = directory => readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
const removeDir = directory => {
  // Windows often holds a handle briefly after a child exits (or while AV
  // scans), so rmSync can fail with EPERM/EBUSY/ENOTEMPTY on a first attempt.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = ["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code);
      if (!retryable || attempt >= 9) throw error;
      // Blocking sleep done right: Atomics.wait instead of a Date.now() spin
      // loop. This is a throwaway verification script, not the shipped server.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
};

try {
  // setup-node and official Node distributions keep npm's JS entry here on Windows.
  const npmCli = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const npmArgs = ["install", "--global", "--prefix", prefix, tarballs[0], "--no-audit", "--no-fund"];
  run(windows ? process.execPath : "npm", windows ? [npmCli, ...npmArgs] : npmArgs, { stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "diffninja");
  assert.deepEqual(manifest.bin, { diffninja: "dist/review/cli.js", "diffninja-mcp": "dist/review/mcp-cli.js" });
  assert.deepEqual(readdirSync(packageDir).sort(), ["LICENSE", "README.md", "dist", "node_modules", "package.json"]);

  // Each source owns exactly two emitted files. Catch stale output of any name,
  // not just the tmp-report.js leak that originally prompted this release gate.
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const expected = filesUnder(source).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap(file => [file.slice(source.length, -3) + ".js", file.slice(source.length, -3) + ".d.ts"]).sort();
  const dist = join(packageDir, "dist");
  const emitted = filesUnder(dist).map(file => file.slice(dist.length + 1)).sort();
  assert.deepEqual(emitted, expected, "Tarball must contain only current compiled sources");
  const binDir = windows ? prefix : join(prefix, "bin");
  for (const name of ["diffninja", "diffninja-mcp"]) {
    assert(existsSync(join(binDir, name + (windows ? ".cmd" : ""))), `Missing ${name} shim`);
    assert.equal(readFileSync(join(packageDir, manifest.bin[name]), "utf8").split("\n")[0], "#!/usr/bin/env node");
    if (windows) {
      assert(existsSync(join(binDir, name)), `Missing ${name} shell shim`);
      assert(existsSync(join(binDir, name + ".ps1")), `Missing ${name} PowerShell shim`);
    }
  }
  assert(!readdirSync(binDir).some(name => /^calldiff(?:\.|$)/.test(name)));
  const help = windows
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& '${join(binDir, "diffninja.cmd").replaceAll("'", "''")}' --help; exit $LASTEXITCODE`])
    : run(join(binDir, "diffninja"), ["--help"]);
  assert.match(help, /Focused local PR review/);

  // Native DLLs stay locked while loaded on Windows. Use a child that exits
  // before removing the sandbox, just like the CLI and MCP checks below.
  // On-demand grammar installation runs on every platform: on Windows it
  // exercises the npm-cli.js invocation, which cmd.exe shims cannot serve.
  run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { extractFunctions } = await import(process.argv[1]);
    assert.equal(extractFunctions("sample.ts", "export function greet() { return 42; }")[0].key, "greet");
    assert.equal(extractFunctions("sample.py", "def greet():\\n    return 42\\n")[0].key, "greet");
  `, pathToFileURL(join(packageDir, "dist/extract.js")).href], {
    env: { ...isolatedEnv, CALLDIFF_GRAMMAR_CACHE: join(sandbox, "grammar cache") },
  });

  const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
  const patchPath = join(sandbox, "input.patch");
  writeFileSync(patchPath, patch);
  const out = join(sandbox, "review.html");
  run(process.execPath, [join(packageDir, manifest.bin.diffninja), "--diff", patchPath, "--mock", "--out", out]);
  const report = JSON.parse(readFileSync(out + ".json", "utf8"));
  assert.equal(report.mode, "mock");
  assert.equal(report.items.length, 1);
  assert.match(readFileSync(out, "utf8"), /<!doctype html>/i);

  // --open is best-effort (no browser on CI): it must still exit 0 with the
  // report written. On Windows this executes the rundll32 opener path.
  const openOut = join(sandbox, "review-open.html");
  run(process.execPath, [join(packageDir, manifest.bin.diffninja), "--diff", patchPath, "--mock", "--out", openOut, "--open"]);
  assert(existsSync(openOut));
  assert(existsSync(openOut + ".json"));

  const appRequire = createRequire(join(packageDir, "package.json"));
  const { Client } = await import(pathToFileURL(appRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(appRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const client = new Client({ name: "package-verification", version: "1.0.0" });
  try {
    // Start through the installed command shim, not just its JavaScript target.
    // Name the .cmd explicitly so PATHEXT can never resolve npm's .ps1 shim,
    // which is blocked on hosts with a restricted execution policy. The SDK
    // spawns .cmd files through cmd.exe, the same path real MCP clients use.
    const command = join(binDir, windows ? "diffninja-mcp.cmd" : "diffninja-mcp");
    await client.connect(new StdioClientTransport({ command, stderr: "inherit", cwd: sandbox }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["review_diff"]);
    const result = await client.callTool({ name: "review_diff", arguments: { diff: patch, mock: true } });
    assert(!result.isError);
    assert.equal(result.structuredContent.mode, "mock");
    assert.equal(result.structuredContent.items.length, 1);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  } finally {
    await client.close();
  }
  console.log(`PASS ${process.platform}/${process.arch} Node ${process.version}: clean global install, pack layout, both command shims, CLI, --open, native TypeScript/Python, MCP stdio`);
} finally {
  removeDir(sandbox);
}
