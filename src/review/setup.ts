/**
 * `diffninja setup`: register the diffninja MCP server on every detected
 * agent CLI (Claude Code, Codex, OMP, pi) with one command.
 *
 * The setup installs the package globally first so the registration points
 * at a permanent binary instead of the npx cache. When the global install is
 * unavailable it falls back to an npx-based entry and says so. The server
 * needs no key or environment: reviews are local, and connected reviews reuse
 * the `gh` session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
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

The server needs no API key: static reviews run locally, and pull request
reviews reuse your authenticated gh session.
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
  /** Environment to read `CODEX_HOME` from. */
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
 *
 * `cliPath` maps a shim name to npm's JS entry point (`npx` →
 * `npx-cli.js`); production searches the npm install, tests pass a stub.
 */
export function windowsCliEntry(
  name: string,
  args: readonly string[],
  cliPath: (entryName: string) => string | undefined = npmCliPath,
): McpEntry {
  const npmCli = cliPath(`${name}-cli.js`);
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
      return (await exitCode(run(["install", "-g", `--allow-scripts=${INSTALL_SCRIPT_PACKAGES.join(",")}`, "diffninja"], true))) === 0;
    },
  };
}

/**
 * Packages whose install scripts the global install needs: tree-sitter's
 * native builds and diffninja's own grammar repair. npm 12 blocks dependency
 * install scripts unless named; earlier npm accepts the flag and ignores it.
 */
export const INSTALL_SCRIPT_PACKAGES = ["diffninja", "tree-sitter", "tree-sitter-javascript", "tree-sitter-typescript"] as const;

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

interface TemporaryFile {
  writeFile(text: string): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** Filesystem operations used to stage and commit an atomic update. */
export interface UpdateFileIO {
  open(path: string, flags: string, mode: number): Promise<TemporaryFile>;
  stat(path: string): Promise<Stats>;
  rename(from: string, to: string): Promise<void>;
}

const fileIO: UpdateFileIO = { open, stat, rename };
const missingFileError = z.object({ code: z.literal("ENOENT") });

interface FileState {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
}

async function fileState(path: string, io: UpdateFileIO): Promise<FileState | undefined> {
  try {
    const info = await io.stat(path);
    return { mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
  } catch (error) {
    if (!missingFileError.safeParse(error).success) throw error;
    return undefined;
  }
}

/** A concurrent chmod is as much a change as a concurrent write. */
function sameFile(left: FileState | undefined, right: FileState | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

async function sameContents(path: string, text: string | undefined): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === text;
  } catch (error) {
    if (!missingFileError.safeParse(error).success) throw error;
    return text === undefined;
  }
}

/** Names one process has already proposed, so no two commits ask for the same temporary. */
let tempAttempts = 0;

/** Rounds of link chasing allowed before a chain is called too long. */
const MAX_LINK_HOPS = 40;

/**
 * Stage `text` beside `path` under a name no other writer can hold: `wx`
 * creates the file or fails, and a name already taken is never opened, so a
 * file belonging to someone else is never truncated. Once the name is ours a
 * failure mid-write is cleaned up here; a failure to create it means the name
 * was never ours and there is nothing of ours to remove.
 */
async function createTemp(path: string, text: string, mode: number, io: UpdateFileIO): Promise<string> {
  tempAttempts += 1;
  // The pid and the counter place the name; the random tag keeps a recycled
  // pid from inheriting one a previous process left behind.
  const tag = randomBytes(6).toString("hex");
  const temporary = join(dirname(path), `.${basename(path)}.diffninja-${process.pid}-${tempAttempts}-${tag}.tmp`);
  const handle = await io.open(temporary, "wx", mode);
  try {
    await handle.writeFile(text);
    await handle.chmod(mode);
    await handle.close();
  } catch (error) {
    // The name is ours, so the partial file is ours to remove: left behind it
    // would sit beside the user's config for good.
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return temporary;
}

/**
 * Write `text` through a temporary file beside `path` and rename it into
 * place, so a reader (or a crash) never sees a half-written config. The
 * temporary inherits the mode of the file it replaces.
 *
 * The file is checked immediately before the rename — contents first, then
 * state, so the last look before the rename covers both — because a write
 * landing between the merge and the rename would otherwise be dropped by the
 * rename without anyone noticing. A check that fails removes the temporary and
 * reports the file as changed; only the temporary this call staged is removed.
 */
async function commitFile(
  path: string,
  text: string,
  current: string | undefined,
  expected: FileState | undefined,
  io: UpdateFileIO,
): Promise<boolean> {
  const temporary = await createTemp(path, text, expected?.mode ?? 0o600, io);
  let renamed = false;
  try {
    if (!(await sameContents(path, current)) || !sameFile(expected, await fileState(path, io))) return false;
    await io.rename(temporary, path);
    renamed = true;
    return true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * The file a write should land in: a config that is symlinked (dotfile
 * managers do this) keeps its link, so the link's destination is what gets
 * replaced.
 *
 * A path that exists is canonicalized with `realpath`, which is how two
 * aliases of one file resolve together, a link reached through a symlinked
 * directory included. A destination that does not exist yet — what a dangling
 * link points at — has no canonical path to ask for, so the chain is followed
 * by hand: each link is read and its destination composed against the link's
 * own directory, and the missing name is resolved against the nearest existing
 * ancestor, so the destination is created rather than the link swapped for a
 * file. Only a missing entry counts as absent; a permission or loop error is
 * reported, never read as "nothing there".
 */
async function resolveTarget(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  const seen = new Set<string>();
  let hops = 0;
  for (;;) {
    const info = await lstat(current).catch((error) => {
      if (missingFileError.safeParse(error).success) return undefined;
      throw error;
    });
    if (info === undefined) {
      // Nothing here yet: keep the name and canonicalize the parent instead.
      tail.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      current = parent;
      continue;
    }
    if (!info.isSymbolicLink()) {
      const canonical = await realpath(current);
      return tail.length === 0 ? canonical : join(canonical, ...tail);
    }
    if (hops >= MAX_LINK_HOPS) throw new Error(`Cannot update ${path}: too many levels of symbolic links.`);
    if (seen.has(current)) throw new Error(`Cannot update ${path}: its symlinks form a cycle.`);
    seen.add(current);
    hops += 1;
    current = resolve(dirname(current), await readlink(current));
  }
}

/**
 * Updates in flight in this process, one chain per resolved file. Two of them
 * would otherwise both merge the contents they read, and the later rename
 * would drop the earlier edit with both writers reporting success.
 */
const inFlight = new Map<string, Promise<void>>();

async function withFileLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const result = previous.then(run);
  const chain = result.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, chain);
  try {
    return await result;
  } finally {
    if (inFlight.get(key) === chain) inFlight.delete(key);
  }
}

/**
 * Read `path`, apply `merge` to its contents, and commit the result. Updates
 * in this process are serialized per file, so two of them cannot drop each
 * other's edits. A writer in another process is caught by re-reading the
 * contents and state immediately before the rename, which re-runs `merge`
 * against what that writer left behind; after `attempts` the write is
 * abandoned with the file untouched. That re-read narrows the window between
 * the read and the rename but cannot close it: only another in-process update
 * is excluded by construction.
 */
export async function updateFile(
  path: string,
  merge: (current: string | undefined) => FileEdit,
  attempts = 3,
  io: UpdateFileIO = fileIO,
): Promise<FileEdit & { path: string }> {
  const target = await resolveTarget(path);
  return withFileLock(target, async () => {
    for (let attempt = 1; ; attempt++) {
      const before = await fileState(target, io);
      const current = before === undefined ? undefined : await readFile(target, "utf8");
      const edit = merge(current);
      if (!edit.changed) return { ...edit, path };
      await mkdir(dirname(target), { recursive: true });
      if (await commitFile(target, edit.text, current, before, io)) return { ...edit, path };
      if (attempt >= attempts) {
        throw new Error(`Cannot update ${path}: it changed while diffninja was writing. Re-run the command.`);
      }
    }
  });
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
  return { type: "stdio", command: entry.command, args: entry.args };
}

function ompServer(entry: McpEntry): JsonObject {
  return { command: entry.command, args: entry.args };
}

function piServer(entry: McpEntry): JsonObject {
  return { transport: "stdio", command: entry.command, args: entry.args, lifecycle: "lazy" };
}

/** Key path of the Codex MCP server table for diffninja. */
const CODEX_SERVER_PATH = ["mcp_servers", "diffninja"] as const;

function codexValues(entry: McpEntry): TomlTable {
  return { command: entry.command, args: entry.args };
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
  }

  return { entry: entry ?? npxEntry(), viaNpx, clis: reports };
}
