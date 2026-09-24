import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  CLI_NAMES,
  codexConfigPath,
  createNpm,
  globalEntry,
  npxEntry,
  runSetup,
  updateFile,
  windowsCliEntry,
  type Npm,
  type SetupOptions,
} from "../src/review/setup.js";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "diffninja-setup-"));
}

interface FakeNpm extends Npm {
  /** Global root `npm root -g` reports. */
  root: string;
  /** How many times a global install was requested. */
  installs: number;
}

/** npm stub over a fake global root, holding the package unless `installed` is false. */
function fakeNpm(home: string, installed = true): FakeNpm {
  const root = join(home, "fake-global-root");
  mkdirSync(join(root, "diffninja", "dist", "review"), { recursive: true });
  const npm: FakeNpm = {
    root,
    installs: 0,
    rootG: async () => root,
    installG: async () => {
      npm.installs += 1;
      writeFileSync(join(root, "diffninja", "dist", "review", "mcp-cli.js"), "placeholder\n");
      return true;
    },
  };
  if (installed) writeFileSync(join(root, "diffninja", "dist", "review", "mcp-cli.js"), "placeholder\n");
  return npm;
}

function options(home: string, extra: Partial<SetupOptions> = {}): SetupOptions {
  return { homeDir: home, pathDirs: [], quiet: true, ...extra, env: { HOME: home, CODEX_HOME: "", ...extra.env } };
}

describe("entries", () => {
  it("runs npx directly off Windows", () => {
    const expected = { command: "npx", args: ["-y", "-p", "diffninja", "diffninja-mcp"] };
    expect(npxEntry("darwin")).toEqual(expected);
    expect(npxEntry("linux")).toEqual(expected);
  });

  it("never hands Windows a bare .cmd shim", () => {
    const entry = npxEntry("win32");
    expect(entry.command).not.toBe("npx.cmd");
    expect(entry.args.slice(-4)).toEqual(["-y", "-p", "diffninja", "diffninja-mcp"]);
    // Either npm's JS entry point driven by Node, or the shim driven by cmd.exe.
    if (entry.command === process.execPath) expect(entry.args[0]).toMatch(/npx-cli\.js$/u);
    else expect(entry.args.slice(0, 4)).toEqual(["/d", "/s", "/c", "npx"]);
  });

  it("prefers npm's JS entry point on Windows, keeping paths as single arguments", () => {
    const cli = join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npx-cli.js");
    const entry = windowsCliEntry("npx", ["-y", "-p", "diffninja", "diffninja-mcp"], () => cli);
    expect(entry).toEqual({ command: process.execPath, args: [cli, "-y", "-p", "diffninja", "diffninja-mcp"] });
  });

  it("falls back to the shim through cmd.exe when npm has no JS entry", () => {
    const args = ["-y", "-p", "diffninja", "diffninja-mcp"];
    const entry = windowsCliEntry("npx", args, () => undefined);
    expect(entry.args).toEqual(["/d", "/s", "/c", "npx", ...args]);
    expect(entry.command).toBe(process.env["ComSpec"] ?? "cmd.exe");
  });

  it.skipIf(process.platform === "win32")("launches the Windows entry it built for a spaced path", () => {
    const home = fakeHome();
    try {
      const bin = join(home, "node modules", "npm", "bin");
      mkdirSync(bin, { recursive: true });
      const cli = join(bin, "npx-cli.js");
      writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))\n");
      const entry = windowsCliEntry("npx", ["-y", "-p", "diffninja", "diffninja-mcp"], () => cli);
      const received: unknown = JSON.parse(execFileSync(entry.command, entry.args, {
        encoding: "utf8",
        env: { HOME: home, CODEX_HOME: "" },
      }));
      expect(received).toEqual(["-y", "-p", "diffninja", "diffninja-mcp"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("builds the global entry from npm root -g", () => {
    expect(globalEntry("/r")).toEqual({ command: "node", args: [join("/r", "diffninja", "dist", "review", "mcp-cli.js")] });
  });

  it("resolves the Codex config from CODEX_HOME when it is set", () => {
    expect(codexConfigPath("/home/u", {})).toBe(join("/home/u", ".codex", "config.toml"));
    expect(codexConfigPath("/home/u", { CODEX_HOME: "/srv/codex" })).toBe(join("/srv/codex", "config.toml"));
    expect(codexConfigPath("/home/u", { CODEX_HOME: "  " })).toBe(join("/home/u", ".codex", "config.toml"));
  });

  it("knows the four supported CLIs", () => {
    expect([...CLI_NAMES].sort()).toEqual(["claude", "codex", "omp", "pi"]);
  });
});

describe("createNpm", () => {
  it.skipIf(process.platform === "win32")("runs exactly the npm it was pointed at, spaces and all", async () => {
    const home = fakeHome();
    try {
      const bin = join(home, "bin dir");
      mkdirSync(bin, { recursive: true });
      const root = join(home, "global root");
      const argsFile = join(home, "install-args");
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/sh\nif [ "$1" = "root" ]; then printf '%s\\n' '${root}'; fi\nif [ "$1" = "install" ]; then printf '%s\\n' "$@" > '${argsFile}'; fi\n`,
        { mode: 0o755 },
      );
      const npm = createNpm({ env: { HOME: home, CODEX_HOME: "", PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` } });
      expect(await npm.rootG()).toBe(root);
      expect(await npm.installG()).toBe(true);
      // npm 12 skips dependency install scripts unless named: tree-sitter's native
      // builds and diffninja's grammar repair must be allowed by name.
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
        "install",
        "-g",
        "--allow-scripts=diffninja,tree-sitter,tree-sitter-javascript,tree-sitter-typescript",
        "diffninja",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runSetup", () => {
  it("configures detected CLIs and skips the rest", async () => {
    const home = fakeHome();
    try {
      // codex detected by config file with existing content; omp by directory; claude by binary on PATH.
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt"\n');
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      const bin = join(home, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
      const report = await runSetup(options(home, { pathDirs: [bin] }), { npm: fakeNpm(home) });
      expect(report.viaNpx).toBe(false);
      expect(report.entry).toEqual(globalEntry(join(home, "fake-global-root")));
      const byCli = Object.fromEntries(report.clis.map((r) => [r.cli, r]));
      expect(byCli["claude"].action).toBe("configured");
      expect(byCli["codex"].action).toBe("configured");
      expect(byCli["omp"].action).toBe("configured");
      expect(byCli["pi"].action).toBe("not-detected");

      const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
      expect(claudeJson.mcpServers.diffninja).toEqual({
        type: "stdio",
        command: "node",
        args: [join(home, "fake-global-root", "diffninja", "dist", "review", "mcp-cli.js")],
      });
      const codexToml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(codexToml).toContain("[mcp_servers.diffninja]");
      expect(codexToml).toContain('model = "gpt"');
      // Reviews are local: no entry references an API key.
      expect(codexToml).not.toContain("TYPESAFE_API_KEY");
      const ompJson = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8"));
      expect(ompJson.mcpServers.diffninja.env).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rewrites entries from an older setup without the API key reference", async () => {
    const home = fakeHome();
    try {
      const mcp = join(home, "fake-global-root", "diffninja", "dist", "review", "mcp-cli.js");
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { diffninja: {
        type: "stdio", command: "node", args: [mcp], env: { TYPESAFE_API_KEY: "${TYPESAFE_API_KEY}" },
      } } }));
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"),
        `[mcp_servers.diffninja]\ncommand = "node"\nargs = ["${mcp}"]\nenv_vars = ["TYPESAFE_API_KEY"]\n`);
      const report = await runSetup(options(home), { npm: fakeNpm(home) });
      const byCli = Object.fromEntries(report.clis.map((r) => [r.cli, r]));
      expect(byCli["claude"].action).toBe("configured");
      expect(byCli["codex"].action).toBe("configured");
      expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.diffninja.env).toBeUndefined();
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("TYPESAFE_API_KEY");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs the package globally when it is missing", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      const npm = fakeNpm(home, false);
      const report = await runSetup(options(home), { npm });
      expect(npm.installs).toBe(1);
      expect(report.viaNpx).toBe(false);
      expect(report.entry).toEqual(globalEntry(npm.root));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent on a second run", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      const npm = fakeNpm(home);
      const first = await runSetup(options(home), { npm });
      expect(first.clis.find((r) => r.cli === "pi")!.action).toBe("configured");
      const second = await runSetup(options(home), { npm });
      expect(second.clis.find((r) => r.cli === "pi")!.action).toBe("already-configured");
      const piJson = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf8"));
      expect(piJson.mcpServers.diffninja.transport).toBe("stdio");
      expect(piJson.mcpServers.diffninja.lifecycle).toBe("lazy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes entries with uninstall", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "");
      const npm = fakeNpm(home);
      await runSetup(options(home), { npm });
      const removed = await runSetup(options(home, { uninstall: true }), { npm });
      expect(removed.clis.find((r) => r.cli === "codex")!.action).toBe("removed");
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("diffninja");
      const again = await runSetup(options(home, { uninstall: true }), { npm });
      expect(again.clis.find((r) => r.cli === "codex")!.action).toBe("already-configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uninstalls the whole codex table, nested tables included", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "config.toml"),
        [
          "[mcp_servers.other]",
          'command = "other"',
          "",
          "[mcp_servers.diffninja]",
          'command = "node"',
          "",
          "[mcp_servers.diffninja.env]",
          'FAKE_KEY = "value"',
          "",
        ].join("\n"),
      );
      const report = await runSetup(options(home, { uninstall: true }), { npm: fakeNpm(home) });
      expect(report.clis.find((r) => r.cli === "codex")!.action).toBe("removed");
      const text = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(text).not.toContain("diffninja");
      expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "inline parent",
      text: 'mcp_servers = { diffninja = { command = "old" }, other = { command = "keep" } }\n',
    },
    {
      name: "separated descendant",
      text: '[mcp_servers.diffninja]\ncommand = "old"\n[mcp_servers.other]\ncommand = "keep"\n[mcp_servers.diffninja.env]\nTOKEN = "old"\n',
    },
    {
      name: "interleaved dotted keys",
      text: '[mcp_servers]\ndiffninja.command = "old"\nother.command = "keep"\ndiffninja.env.TOKEN = "old"\n',
    },
  ])("fully uninstalls Codex registration with $name", async ({ text }) => {
    const home = fakeHome();
    try {
      const config = join(home, ".codex", "config.toml");
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, text);
      const report = await runSetup(options(home, { clis: ["codex"], uninstall: true }));
      expect(report.clis[0]!.action).toBe("removed");
      expect(parse(readFileSync(config, "utf8"))).toEqual({ mcp_servers: { other: { command: "keep" } } });
      const again = await runSetup(options(home, { clis: ["codex"], uninstall: true }));
      expect(again.clis[0]!.action).toBe("already-configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects, installs, and removes through CODEX_HOME", async () => {
    const home = fakeHome();
    try {
      const codexHome = join(home, "codex home");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt"\n');
      const env = { HOME: home, CODEX_HOME: codexHome };
      const npm = fakeNpm(home);

      const report = await runSetup(options(home, { clis: ["codex"], env }), { npm });
      expect(report.clis).toEqual([{ cli: "codex", detected: true, action: "configured", path: "~/codex home/config.toml" }]);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.diffninja]");
      expect(existsSync(join(home, ".codex"))).toBe(false);

      const removed = await runSetup(options(home, { clis: ["codex"], env, uninstall: true }), { npm });
      expect(removed.clis[0]!.action).toBe("removed");
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("diffninja");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to npx when the global install fails", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      const failing: Npm = {
        rootG: async () => "",
        installG: async () => false,
      };
      const report = await runSetup(options(home), { npm: failing });
      expect(report.viaNpx).toBe(true);
      expect(report.entry).toEqual(npxEntry());
      const ompJson = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8"));
      expect(ompJson.mcpServers.diffninja.command).toBe(npxEntry().command);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("neither installs nor writes on dry-run when the package is missing", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      const npm = fakeNpm(home, false);
      const report = await runSetup(options(home, { dryRun: true }), { npm });
      expect(npm.installs).toBe(0);
      expect(report.clis.find((r) => r.cli === "omp")!.action).toBe("dry-run");
      expect(existsSync(join(home, ".omp", "agent", "mcp.json"))).toBe(false);
      // The entry reported is the one the skipped install would have produced.
      expect(report.entry).toEqual(globalEntry(npm.root));
      expect(existsSync(join(npm.root, "diffninja", "dist", "review", "mcp-cli.js"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects unknown CLI names", async () => {
    const home = fakeHome();
    try {
      await expect(runSetup(options(home, { clis: ["nope"] }), { npm: fakeNpm(home) })).rejects.toThrow('Unknown CLI "nope"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects the cli filter", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      const report = await runSetup(options(home, { clis: ["omp"] }), { npm: fakeNpm(home) });
      expect(report.clis.map((r) => r.cli)).toEqual(["omp"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a config it cannot parse instead of clobbering it", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.diffninja]\ncommand =\n");
      await expect(runSetup(options(home), { npm: fakeNpm(home) })).rejects.toThrow(/not valid TOML/);
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("[mcp_servers.diffninja]\ncommand =\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("updateFile", () => {
  it("re-merges when another writer lands between the read and the commit", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"a":1}\n');
      let competing = true;
      const result = await updateFile(path, (current) => {
        if (competing) {
          competing = false;
          writeFileSync(path, '{"a":1,"b":2}\n');
        }
        const value = JSON.parse(current ?? "{}");
        value["ours"] = true;
        return { text: `${JSON.stringify(value, null, 2)}\n`, changed: true };
      });
      expect(result.changed).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1, b: 2, ours: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("aborts, untouched, when the file keeps changing", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, '{"n":0}\n');
      let writes = 0;
      await expect(
        updateFile(path, () => {
          writes += 1;
          // A different size each round, so the change is visible regardless of clock granularity.
          writeFileSync(path, `{"n":"${"x".repeat(writes)}"}\n`);
          return { text: '{"ours":true}\n', changed: true };
        }),
      ).rejects.toThrow(/config\.json: it changed while diffninja was writing/);
      expect(readFileSync(path, "utf8")).toBe(`{"n":"${"x".repeat(writes)}"}\n`);
      expect(readdirSync(home)).toEqual(["config.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || (process.getuid?.() ?? 1) === 0)(
    "leaves the file and its directory clean when the commit cannot complete",
    async () => {
      const home = fakeHome();
      try {
        const path = join(home, "config.json");
        writeFileSync(path, "original\n");
        chmodSync(home, 0o500);
        try {
          await expect(updateFile(path, () => ({ text: "replacement\n", changed: true }))).rejects.toThrow(
            /EACCES|EPERM|permission denied/u,
          );
          expect(readFileSync(path, "utf8")).toBe("original\n");
          expect(readdirSync(home)).toEqual(["config.json"]);
        } finally {
          chmodSync(home, 0o700);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("keeps the permissions of the file it replaces", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "config.json");
      writeFileSync(path, "{}\n");
      chmodSync(path, 0o640);
      await updateFile(path, () => ({ text: '{"a":1}\n', changed: true }));
      expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
      expect(statSync(path).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates a missing file and leaves it alone when nothing changes", async () => {
    const home = fakeHome();
    try {
      const path = join(home, "nested", "config.json");
      expect(await updateFile(path, () => ({ text: "{}\n", changed: true }))).toEqual({ text: "{}\n", changed: true, path });
      expect(readFileSync(path, "utf8")).toBe("{}\n");
      expect(await updateFile(path, (current) => ({ text: current ?? "", changed: false }))).toEqual({
        text: "{}\n",
        changed: false,
        path,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("writes through a symlinked config without replacing the link", async () => {
    const home = fakeHome();
    try {
      const real = join(home, "dotfiles", "config.json");
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, '{"linked":true}\n');
      const link = join(home, "config.json");
      symlinkSync(real, link);

      await updateFile(link, (current) => ({ text: `${current?.trim()}\n`, changed: true }));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe('{"linked":true}\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
