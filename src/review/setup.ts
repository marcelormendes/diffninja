/**
 * `diffninja setup`: register the diffninja MCP server on every detected
 * agent CLI (Claude Code, Codex, OMP, pi) with one command.
 *
 * The setup installs the package globally first so the registration points
 * at a permanent binary instead of the npx cache. When the global install is
 * unavailable it falls back to an npx-based entry and says so. The TypeSafe
 * API key is only referenced from the launching environment, never written
 * into a config file.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { z } from "zod";

export const setupHelp = `diffninja setup. Register the diffninja MCP server on every detected agent CLI.

  npx -y diffninja setup [--cli claude,codex,omp,pi] [--dry-run]
  diffninja setup --uninstall [--cli codex]

Detects Claude Code, Codex, OMP, and pi from their config files or binaries
and registers the diffninja MCP server in each user config, pointing at the
globally installed package. Installs the package globally first
(\`npm install -g diffninja\`) so the registration keeps working; when that
install fails it registers an npx-based entry instead and says so.

Options:
  --cli NAMES    Only these CLIs, comma-separated: claude,codex,omp,pi.
  --uninstall    Remove the diffninja server from every detected CLI.
  --dry-run      Show what would change without writing anything.
  --no-install   Skip the global install and register npx-based entries.
  --help         Show this help.

The TypeSafe API key is never written into config files; each entry references
it from the environment that launches the CLI. Set TYPESAFE_API_KEY for live
reviews. Without it the server still answers in mock mode.
`;

export const CLI_NAMES = ["claude", "codex", "omp", "pi"] as const;
export type CliName = (typeof CLI_NAMES)[number];

export interface McpEntry {
  command: string;
  args: string[];
}

export interface SetupOptions {
  clis?: readonly string[];
  uninstall?: boolean;
  dryRun?: boolean;
  noInstall?: boolean;
  quiet?: boolean;
  homeDir?: string;
  pathDirs?: string[];
}

export interface Npm {
  rootG(): Promise<string>;
  installG(): Promise<boolean>;
}

export interface CliReport {
  cli: CliName;
  detected: boolean;
  action: "configured" | "already-configured" | "removed" | "not-detected" | "dry-run";
  path?: string;
}

export interface SetupReport {
  entry: McpEntry;
  viaNpx: boolean;
  clis: CliReport[];
}

export interface SetupDeps {
  npm?: Npm;
}

export interface TomlEdit {
  text: string;
  changed: boolean;
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const jsonObjectSchema = z.object({}).catchall(jsonValueSchema);

/** Entry that runs the published package on demand, without an install. */
export function npxEntry(): McpEntry {
  return process.platform === "win32"
    ? { command: "npx.cmd", args: ["-y", "-p", "diffninja", "diffninja-mcp"] }
    : { command: "npx", args: ["-y", "-p", "diffninja", "diffninja-mcp"] };
}

/** Entry that runs the globally installed package. `globalRoot` is `npm root -g`. */
export function globalEntry(globalRoot: string): McpEntry {
  return { command: "node", args: [join(globalRoot, "diffninja", "dist", "review", "mcp-cli.js")] };
}

export function globalEntryExists(globalRoot: string): boolean {
  return existsSync(join(globalRoot, "diffninja", "dist", "review", "mcp-cli.js"));
}

const realNpm: Npm = {
  rootG(): Promise<string> {
    return new Promise((done) => {
      const child = spawn("npm", ["root", "-g"]);
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => done(""));
      child.on("close", (code) => done(code === 0 ? out.trim() : ""));
    });
  },
  installG(): Promise<boolean> {
    return new Promise((done) => {
      const child = spawn("npm", ["install", "-g", "diffninja"], { stdio: "inherit" });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    });
  },
};

async function resolveEntry(noInstall: boolean, npm: Npm, quiet: boolean): Promise<{ entry: McpEntry; viaNpx: boolean }> {
  const installed = async (): Promise<McpEntry | undefined> => {
    const root = await npm.rootG().catch(() => undefined);
    if (root === undefined || root === "") return undefined;
    return globalEntryExists(root) ? globalEntry(root) : undefined;
  };
  let entry = await installed();
  if (entry === undefined && !noInstall) {
    if (!quiet) console.log("diffninja: installing the package globally (npm install -g diffninja)...");
    const ok = await npm.installG().catch(() => false);
    if (ok) entry = await installed();
  }
  if (entry === undefined) {
    if (!quiet) console.error("diffninja: global install unavailable; registering npx-based entries instead.");
    return { entry: npxEntry(), viaNpx: true };
  }
  return { entry, viaNpx: false };
}

function findOnPath(name: string, pathDirs: string[]): string | undefined {
  const candidates = process.platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function isDetected(cli: CliName, homeDir: string, pathDirs: string[]): boolean {
  switch (cli) {
    case "claude":
      return existsSync(join(homeDir, ".claude.json")) || findOnPath("claude", pathDirs) !== undefined;
    case "codex":
      return existsSync(join(homeDir, ".codex", "config.toml")) || findOnPath("codex", pathDirs) !== undefined;
    case "omp":
      return existsSync(join(homeDir, ".omp", "agent")) || findOnPath("omp", pathDirs) !== undefined;
    case "pi":
      return existsSync(join(homeDir, ".pi", "agent")) || findOnPath("pi", pathDirs) !== undefined;
  }
}

function toCliName(name: string): CliName | undefined {
  for (const cli of CLI_NAMES) {
    if (cli === name) return cli;
  }
  return undefined;
}

async function readJsonObject(path: string): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot use ${path}: not valid JSON.`);
  }
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Cannot use ${path}: expected a JSON object at the top level.`);
  return result.data;
}

function sameJson(a: JsonValue | undefined, b: JsonValue): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Insert, replace, or remove the diffninja server in a JSON MCP config file.
 * `entry` undefined removes it. Returns whether the file changed.
 */
async function configureJsonServer(
  path: string,
  build: (entry: McpEntry) => JsonObject,
  entry: McpEntry | undefined,
  dryRun: boolean,
): Promise<boolean> {
  const root = existsSync(path) ? await readJsonObject(path) : {};
  const tableResult = jsonObjectSchema.safeParse(root["mcpServers"] ?? {});
  if (!tableResult.success) throw new Error(`Cannot use ${path}: "mcpServers" is not an object.`);
  const table = tableResult.data;
  let changed: boolean;
  if (entry === undefined) {
    changed = Object.prototype.hasOwnProperty.call(table, "diffninja");
    if (changed) delete table["diffninja"];
  } else {
    const want = build(entry);
    changed = !sameJson(table["diffninja"], want);
    if (changed) table["diffninja"] = want;
  }
  if (changed) {
    root["mcpServers"] = table;
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return changed;
}

function claudeServer(entry: McpEntry): JsonObject {
  return { type: "stdio", command: entry.command, args: entry.args, env: { TYPESAFE_API_KEY: "${TYPESAFE_API_KEY}" } };
}

function ompServer(entry: McpEntry): JsonObject {
  // OMP resolves an env value that names a variable from the launching environment.
  return { command: entry.command, args: entry.args, env: { TYPESAFE_API_KEY: "TYPESAFE_API_KEY" } };
}

function piServer(entry: McpEntry): JsonObject {
  return { transport: "stdio", command: entry.command, args: entry.args, lifecycle: "lazy" };
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const CODEX_HEADER = "[mcp_servers.diffninja]";

function codexSection(entry: McpEntry): string {
  return (
    [
      CODEX_HEADER,
      `command = ${tomlQuote(entry.command)}`,
      `args = [${entry.args.map(tomlQuote).join(", ")}]`,
      `env_vars = ["TYPESAFE_API_KEY"]`,
      "",
    ].join("\n")
  );
}

/** Replace the named section, or append it when absent. */
export function upsertTomlSection(text: string, header: string, section: string): TomlEdit {
  const start = text.indexOf(header);
  if (start === -1) {
    const base = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
    return { text: `${base}\n${section}`, changed: true };
  }
  const next = text.indexOf("\n[", start);
  const end = next === -1 ? text.length : next + 1;
  const replaced = text.slice(0, start) + section + text.slice(end);
  return { text: replaced, changed: replaced !== text };
}

/** Remove the named section, keeping the rest of the file intact. */
export function removeTomlSection(text: string, header: string): TomlEdit {
  const start = text.indexOf(header);
  if (start === -1) return { text, changed: false };
  let from = start;
  if (from >= 2 && text[from - 1] === "\n" && text[from - 2] === "\n") from -= 1;
  const next = text.indexOf("\n[", start);
  const end = next === -1 ? text.length : next + 1;
  return { text: text.slice(0, from) + text.slice(end), changed: true };
}

async function configureCodex(homeDir: string, entry: McpEntry | undefined, dryRun: boolean): Promise<TomlEdit & { path: string }> {
  const path = join(homeDir, ".codex", "config.toml");
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const result = entry === undefined ? removeTomlSection(text, CODEX_HEADER) : upsertTomlSection(text, CODEX_HEADER, codexSection(entry));
  if (result.changed && !dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, result.text, { mode: 0o600 });
  }
  return { ...result, path };
}

function prettyPath(homeDir: string, path: string): string {
  return path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path;
}

function describeEntry(entry: McpEntry): string {
  return [entry.command, ...entry.args].join(" ");
}

export async function runSetup(options: SetupOptions = {}, deps: SetupDeps = {}): Promise<SetupReport> {
  const homeDir = options.homeDir ?? homedir();
  const pathDirs = options.pathDirs ?? (process.env["PATH"] ?? "").split(delimiter);
  const requested = options.clis === undefined ? [...CLI_NAMES] : [...new Set(options.clis.map((name) => name.trim()))];
  if (requested.length === 0) throw new Error("--cli needs at least one name: claude, codex, omp, pi.");
  const clis: CliName[] = [];
  for (const name of requested) {
    const cli = toCliName(name);
    if (cli === undefined) throw new Error(`Unknown CLI "${name}". Choose from: ${CLI_NAMES.join(", ")}.`);
    clis.push(cli);
  }
  const quiet = options.quiet === true;
  const uninstall = options.uninstall === true;
  const dryRun = options.dryRun === true;

  let entry: McpEntry | undefined;
  let viaNpx = false;
  if (!uninstall) {
    const resolved = await resolveEntry(options.noInstall === true, deps.npm ?? realNpm, quiet);
    entry = resolved.entry;
    viaNpx = resolved.viaNpx;
  }

  const reports: CliReport[] = [];
  for (const cli of clis) {
    if (!isDetected(cli, homeDir, pathDirs)) {
      reports.push({ cli, detected: false, action: "not-detected" });
      continue;
    }
    let changed = false;
    let path = "";
    if (cli === "claude") {
      path = join(homeDir, ".claude.json");
      changed = await configureJsonServer(path, claudeServer, entry, dryRun);
    } else if (cli === "codex") {
      const result = await configureCodex(homeDir, entry, dryRun);
      path = result.path;
      changed = result.changed;
    } else if (cli === "omp") {
      path = join(homeDir, ".omp", "agent", "mcp.json");
      changed = await configureJsonServer(path, ompServer, entry, dryRun);
    } else {
      path = join(homeDir, ".pi", "agent", "mcp.json");
      changed = await configureJsonServer(path, piServer, entry, dryRun);
    }
    const action = dryRun ? "dry-run" : uninstall ? (changed ? "removed" : "already-configured") : changed ? "configured" : "already-configured";
    reports.push({ cli, detected: true, action, path: prettyPath(homeDir, path) });
  }

  if (!quiet) {
    if (!uninstall) console.log(`diffninja setup: MCP server -> ${describeEntry(entry!)}${viaNpx ? " (npx, no global install)" : ""}`);
    for (const report of reports) {
      const label = `[${report.cli}]`;
      if (report.action === "not-detected") {
        console.log(`${label} not detected, skipped`);
      } else if (report.action === "dry-run") {
        console.log(`${label} would update ${report.path}`);
      } else if (report.action === "configured") {
        console.log(`${label} configured ${report.path}`);
      } else if (report.action === "removed") {
        console.log(`${label} removed from ${report.path}`);
      } else {
        console.log(`${label} already configured`);
      }
    }
    if (reports.some((report) => report.cli === "pi" && report.detected && report.action !== "not-detected")) {
      console.log("note: pi needs the pi-mcp-extension for MCP support (pi install npm:pi-mcp-extension)");
    }
    if (!uninstall && process.env["TYPESAFE_API_KEY"] === undefined) {
      console.log("note: TYPESAFE_API_KEY is not set; live reviews need it in the shell that launches each CLI");
    }
  }

  return { entry: entry ?? npxEntry(), viaNpx, clis: reports };
}
