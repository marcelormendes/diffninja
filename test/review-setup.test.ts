import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_NAMES,
  globalEntry,
  npxEntry,
  removeTomlSection,
  runSetup,
  upsertTomlSection,
  type Npm,
  type SetupOptions,
} from "../src/review/setup.js";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "diffninja-setup-"));
}

function fakeNpm(home: string): Npm {
  const root = join(home, "fake-global-root");
  mkdirSync(join(root, "diffninja", "dist", "review"), { recursive: true });
  writeFileSync(join(root, "diffninja", "dist", "review", "mcp-cli.js"), "placeholder\n");
  return {
    rootG: async () => root,
    installG: async () => true,
  };
}

function expectedEntry(home: string) {
  return { command: "node", args: [join(home, "fake-global-root", "diffninja", "dist", "review", "mcp-cli.js")] };
}

function options(home: string, extra: Partial<SetupOptions> = {}): SetupOptions {
  return { homeDir: home, pathDirs: [], quiet: true, ...extra };
}

describe("toml section helpers", () => {
  const section = '[mcp_servers.diffninja]\ncommand = "node"\nargs = []\n';
  it("appends a missing section", () => {
    const { text, changed } = upsertTomlSection("", "[mcp_servers.diffninja]", section);
    expect(changed).toBe(true);
    expect(text).toBe(`\n${section}`);
  });
  it("appends after existing content with one blank line", () => {
    const { text } = upsertTomlSection('model = "x"\n', "[mcp_servers.diffninja]", section);
    expect(text).toBe(`model = "x"\n\n${section}`);
  });
  it("replaces an existing section and keeps neighbors", () => {
    const before = 'model = "x"\n\n[mcp_servers.diffninja]\ncommand = "old"\n\n[other]\nkey = 1\n';
    const { text, changed } = upsertTomlSection(before, "[mcp_servers.diffninja]", section);
    expect(changed).toBe(true);
    expect(text).toContain(section);
    expect(text).toContain("[other]\nkey = 1");
    expect(text).not.toContain('command = "old"');
  });
  it("reports unchanged when the section already matches", () => {
    const before = `model = "x"\n\n${section}`;
    const { changed } = upsertTomlSection(before, "[mcp_servers.diffninja]", section);
    expect(changed).toBe(false);
  });
  it("removes a section and keeps the rest", () => {
    const before = `model = "x"\n\n${section}\n[other]\nkey = 1\n`;
    const { text, changed } = removeTomlSection(before, "[mcp_servers.diffninja]");
    expect(changed).toBe(true);
    expect(text).not.toContain("diffninja");
    expect(text).toContain('model = "x"');
    expect(text).toContain("[other]");
  });
  it("reports unchanged when removing an absent section", () => {
    const { changed } = removeTomlSection('model = "x"\n', "[mcp_servers.diffninja]");
    expect(changed).toBe(false);
  });
});

describe("entries", () => {
  it("builds the npx entry for the current platform", () => {
    const e = npxEntry();
    expect(e.args).toEqual(["-y", "-p", "diffninja", "diffninja-mcp"]);
    expect(e.command).toBe(process.platform === "win32" ? "npx.cmd" : "npx");
  });
  it("builds the global entry from npm root -g", () => {
    expect(globalEntry("/r")).toEqual({ command: "node", args: [join("/r", "diffninja", "dist", "review", "mcp-cli.js")] });
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
      expect(report.entry).toEqual(expectedEntry(home));
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
        env: { TYPESAFE_API_KEY: "${TYPESAFE_API_KEY}" },
      });
      const codexToml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(codexToml).toContain("[mcp_servers.diffninja]");
      expect(codexToml).toContain('model = "gpt"');
      expect(codexToml).toContain('env_vars = ["TYPESAFE_API_KEY"]');
      const ompJson = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8"));
      expect(ompJson.mcpServers.diffninja.env).toEqual({ TYPESAFE_API_KEY: "TYPESAFE_API_KEY" });
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

  it("writes nothing on dry-run", async () => {
    const home = fakeHome();
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      const report = await runSetup(options(home, { dryRun: true }), { npm: fakeNpm(home) });
      expect(report.clis.find((r) => r.cli === "omp")!.action).toBe("dry-run");
      expect(existsSync(join(home, ".omp", "agent", "mcp.json"))).toBe(false);
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

  it("knows the four supported CLIs", () => {
    expect([...CLI_NAMES].sort()).toEqual(["claude", "codex", "omp", "pi"]);
  });
});
