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

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { z } from "zod";
import { npmCliPath, npmSpawnSpec } from "../languages/grammars.js";
import { removeTomlTable, upsertTomlTable, type TomlTable } from "./toml.js";

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
  --dry-run      Show what would change, without installing or writing.
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
  /** Environment to read `CODEX_HOME` and `TYPESAFE_API_KEY` from. */
  env?: NodeJS.ProcessEnv;
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

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const jsonObjectSchema = z.object({}).catchall(jsonValueSchema);

/** Entry that runs the published package on demand, without an install. */
export function npxEntry(platform: NodeJS.Platform = process.platform): McpEntry {
  const args = ["-y", "-p", "diffninja", "diffninja-mcp"];
  return platform === "win32" ? windowsCliEntry("npx", args) : { command: "npx", args };
}

/**
 * Entry for a command that Windows ships only as a `.cmd` shim, which a client
 * that spawns without a shell cannot launch. Running npm's JS entry point with
 * Node keeps every path a literal argv value, quotes and spaces included; the
 * installed npm CLI is the fallback when Node has no npm beside it.
 */
export function windowsCliEntry(name: string, args: readonly string[], npmCli = npmCliPath(`${name}-cli.js`)): McpEntry {
  if (npmCli === undefined) {
    return { command: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", name, ...args] };
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

/** Entry that runs the globally installed package. `globalRoot` is `npm root -g`. */
export function globalEntry(globalRoot: string): McpEntry {
  return { command: "node", args: [join(globalRoot, "diffninja", "dist", "review", "mcp-cli.js")] };
}

export function globalEntryExists(globalRoot: string): boolean {
  return existsSync(join(globalRoot, "diffninja", "dist", "review", "mcp-cli.js"));
}

/**
 * npm runner. Shell-free by design: on Windows npm is a `.cmd` shim, so runs
 * go through `npmSpawnSpec`, which resolves npm's JS entry point instead.
 */
export function createNpm(overrides: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Npm {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env;
  const run = (args: string[], inherit: boolean): ChildProcess => {
    const spec = npmSpawnSpec(args, platform);
    return spawn(spec.file, spec.args, inherit ? { stdio: "inherit", env } : { env });
  };
  return {
    async rootG(): Promise<string> {
      const child = run(["root", "-g"], false);
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      return (await exitCode(child)) === 0 ? out.trim() : "";
    },
    async installG(): Promise<boolean> {
      return (await exitCode(run(["install", "-g", "diffninja"], true))) === 0;
    },
  };
}

/** Wait for a child's exit code; a child that never starts counts as failure. */
async function exitCode(child: ChildProcess): Promise<number> {
  try {
    // SAFETY: the `close` handler receives [code, signal]; both may be null.
    const [code] = (await once(child, "close")) as [number | null];
    return code ?? -1;
  } catch {
    return -1;
  }
}

const realNpm = createNpm();

/** `npm root -g`, or undefined when npm is unavailable or fails. */
async function globalRoot(npm: Npm): Promise<string | undefined> {
  try {
    const root = (await npm.rootG()).trim();
    return root === "" ? undefined : root;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the registration entry. `--dry-run` never installs: it reports the
 * install it would have run and the entry that install would have produced.
 */
async function resolveEntry(
  noInstall: boolean,
  npm: Npm,
  quiet: boolean,
  dryRun: boolean,
): Promise<{ entry: McpEntry; viaNpx: boolean }> {
  const root = await globalRoot(npm);
  if (root !== undefined && globalEntryExists(root)) return { entry: globalEntry(root), viaNpx: false };

  if (dryRun) {
    if (!noInstall && root !== undefined) {
      if (!quiet) console.log("diffninja: dry run: would install the package globally (npm install -g diffninja).");
      return { entry: globalEntry(root), viaNpx: false };
    }
    if (!quiet) console.error("diffninja: dry run: global install unavailable; would register npx-based entries instead.");
    return { entry: npxEntry(), viaNpx: true };
  }

  if (!noInstall) {
    if (!quiet) console.log("diffninja: installing the package globally (npm install -g diffninja)...");
    let installed = false;
    try {
      installed = await npm.installG();
    } catch {
      installed = false;
    }
    if (installed) {
      const installedRoot = await globalRoot(npm);
      if (installedRoot !== undefined && globalEntryExists(installedRoot)) {
        return { entry: globalEntry(installedRoot), viaNpx: false };
      }
    }
  }
  if (!quiet) console.error("diffninja: global install unavailable; registering npx-based entries instead.");
  return { entry: npxEntry(), viaNpx: true };
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

function isDetected(cli: CliName, homeDir: string, pathDirs: string[], codexConfig: string): boolean {
  switch (cli) {
    case "claude":
      return existsSync(join(homeDir, ".claude.json")) || findOnPath("claude", pathDirs) !== undefined;
    case "codex":
      return existsSync(codexConfig) || findOnPath("codex", pathDirs) !== undefined;
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

/** A rewritten file and whether it differs from what was read. */
export interface FileEdit {
  text: string;
  changed: boolean;
}

interface FileState {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
}

async function fileState(path: string): Promise<FileState | undefined> {
  try {
    const info = await stat(path);
    return { mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
  } catch {
    return undefined;
  }
}

function sameFile(left: FileState | undefined, right: FileState | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

/**
 * Write `text` through a temporary file beside `path` and rename it into
 * place, so a reader (or a crash) never sees a half-written config. The
 * temporary inherits the mode of the file it replaces.
 */
async function commitFile(path: string, text: string, mode: number | undefined): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.diffninja-${process.pid}.tmp`);
  const permissions = mode ?? 0o600;
  try {
    await writeFile(temporary, text, { mode: permissions });
    await chmod(temporary, permissions);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The file a write should land in: a config that is symlinked (dotfile
 * managers do this) keeps its link, so the link target is what gets replaced.
 */
async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Read `path`, apply `merge` to its contents, and commit the result. Another
 * writer between the read and the commit is detected by re-reading the file
 * and re-running `merge` against the new contents; after `attempts` the write
 * is abandoned with the file untouched.
 */
export async function updateFile(
  path: string,
  merge: (current: string | undefined) => FileEdit,
  attempts = 3,
): Promise<FileEdit & { path: string }> {
  const target = await resolveTarget(path);
  for (let attempt = 1; ; attempt++) {
    const before = await fileState(target);
    const current = before === undefined ? undefined : await readFile(target, "utf8");
    const edit = merge(current);
    if (!edit.changed) return { ...edit, path };
    if (!sameFile(before, await fileState(target))) {
      if (attempt >= attempts) {
        throw new Error(`Cannot update ${path}: it changed while diffninja was writing. Re-run the command.`);
      }
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await commitFile(target, edit.text, before?.mode);
    return { ...edit, path };
  }
}

/** Apply an edit, or preview it under `--dry-run`, where nothing is written. */
async function editConfig(
  path: string,
  merge: (current: string | undefined) => FileEdit,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    const current = existsSync(path) ? await readFile(path, "utf8") : undefined;
    return merge(current).changed;
  }
  return (await updateFile(path, merge)).changed;
}

function parseJsonObject(path: string, text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
 * `entry` undefined removes it.
 */
function mergeJsonServer(
  path: string,
  build: (entry: McpEntry) => JsonObject,
  entry: McpEntry | undefined,
): (current: string | undefined) => FileEdit {
  return (current) => {
    const root = current === undefined ? {} : parseJsonObject(path, current);
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
    if (!changed) return { text: current ?? "", changed: false };
    root["mcpServers"] = table;
    return { text: `${JSON.stringify(root, null, 2)}\n`, changed: true };
  };
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

/** Key path of the Codex MCP server table for diffninja. */
const CODEX_SERVER_PATH = ["mcp_servers", "diffninja"] as const;

function codexValues(entry: McpEntry): TomlTable {
  // env_vars forwards a variable from the launching shell; the key never lands in the file.
  return { command: entry.command, args: entry.args, env_vars: ["TYPESAFE_API_KEY"] };
}

/**
 * Codex reads `$CODEX_HOME/config.toml`, defaulting to `~/.codex/config.toml`.
 * Detection, install, and uninstall all use this one path.
 */
export function codexConfigPath(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["CODEX_HOME"]?.trim();
  const directory = configured !== undefined && configured !== "" ? configured : join(homeDir, ".codex");
  return join(directory, "config.toml");
}

/**
 * Insert, replace, or remove the diffninja server in a Codex TOML config.
 * `entry` undefined removes it, nested tables included.
 */
function mergeCodexServer(path: string, entry: McpEntry | undefined): (current: string | undefined) => FileEdit {
  return (current) => {
    const text = current ?? "";
    return entry === undefined
      ? removeTomlTable(text, path, CODEX_SERVER_PATH)
      : upsertTomlTable(text, path, CODEX_SERVER_PATH, codexValues(entry));
  };
}

function prettyPath(homeDir: string, path: string): string {
  return path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path;
}

function describeEntry(entry: McpEntry): string {
  return [entry.command, ...entry.args].join(" ");
}

export async function runSetup(options: SetupOptions = {}, deps: SetupDeps = {}): Promise<SetupReport> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const pathDirs = options.pathDirs ?? (env["PATH"] ?? "").split(delimiter);
  const codexConfig = codexConfigPath(homeDir, env);
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
    const resolved = await resolveEntry(options.noInstall === true, deps.npm ?? realNpm, quiet, dryRun);
    entry = resolved.entry;
    viaNpx = resolved.viaNpx;
  }

  const reports: CliReport[] = [];
  for (const cli of clis) {
    if (!isDetected(cli, homeDir, pathDirs, codexConfig)) {
      reports.push({ cli, detected: false, action: "not-detected" });
      continue;
    }
    let changed = false;
    let path = "";
    if (cli === "claude") {
      path = join(homeDir, ".claude.json");
      changed = await editConfig(path, mergeJsonServer(path, claudeServer, entry), dryRun);
    } else if (cli === "codex") {
      path = codexConfig;
      changed = await editConfig(path, mergeCodexServer(path, entry), dryRun);
    } else if (cli === "omp") {
      path = join(homeDir, ".omp", "agent", "mcp.json");
      changed = await editConfig(path, mergeJsonServer(path, ompServer, entry), dryRun);
    } else {
      path = join(homeDir, ".pi", "agent", "mcp.json");
      changed = await editConfig(path, mergeJsonServer(path, piServer, entry), dryRun);
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
    if (!uninstall && env["TYPESAFE_API_KEY"] === undefined) {
      console.log("note: TYPESAFE_API_KEY is not set; live reviews need it in the shell that launches each CLI");
    }
  }

  return { entry: entry ?? npxEntry(), viaNpx, clis: reports };
}
