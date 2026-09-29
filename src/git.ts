import { resolveExecutable } from "./executables.js";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listSupportedExtensions } from "./languages/registry.js";
import type {
  Snapshot,
  SnapshotPair,
  SnapshotPairWithPaths,
  SnapshotWithPaths,
} from "./types.js";

/** A git command that has not answered in this long (a dead network share) is stopped, not waited for forever. */
const GIT_TIMEOUT_MS = 120_000;

function gitBuffer(
  cwd: string,
  args: string[],
  input?: Buffer,
  maxBuffer = 64 * 1024 * 1024,
): Buffer {
  return execFileSync(resolveExecutable("git"), ["--no-replace-objects", ...args], {
    cwd,
    input,
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function git(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString("utf8");
}

export function assertGitRepo(cwd: string): void {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}

export function resolveSnapshots(
  from: string | undefined,
  to: string | undefined,
): SnapshotPair {
  // git-diff defaults: no args → HEAD vs worktree; one arg → that vs worktree
  const left: Snapshot = {
    kind: "commit",
    ref: from ?? "HEAD",
  };
  const right: Snapshot =
    to === undefined
      ? { kind: "worktree", ref: "WORKTREE" }
      : { kind: "commit", ref: to };
  return { from: left, to: right };
}

function isCommitRef(cwd: string, ref: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isPathOnDisk(cwd: string, value: string): boolean {
  return existsSync(resolve(cwd, value));
}

/**
 * Resolve diff from/to/paths with git-diff defaults, treating on-disk path
 * positionals as path filters when they are not valid git refs.
 *
 * Examples:
 * - `diff main src` → main vs worktree, paths=[src]
 * - `diff main feature src` → main vs feature, paths=[src]
 * - `diff src` → HEAD vs worktree, paths=[src]
 */
export function resolveDiffSnapshotsAndPaths(
  cwd: string,
  from: string | undefined,
  to: string | undefined,
  paths: string[],
): SnapshotPairWithPaths {
  if (from === undefined && to === undefined) {
    return { ...resolveSnapshots(undefined, undefined), paths };
  }

  if (from !== undefined && to === undefined) {
    if (isCommitRef(cwd, from)) {
      return { ...resolveSnapshots(from, undefined), paths };
    }
    if (isPathOnDisk(cwd, from)) {
      return { ...resolveSnapshots(undefined, undefined), paths: [from, ...paths] };
    }
    throw new Error(`Unknown git ref: ${from}`);
  }

  if (from !== undefined && to !== undefined) {
    if (!isCommitRef(cwd, from)) {
      throw new Error(`Unknown git ref: ${from}`);
    }
    if (isCommitRef(cwd, to)) {
      return { ...resolveSnapshots(from, to), paths };
    }
    if (isPathOnDisk(cwd, to)) {
      return {
        ...resolveSnapshots(from, undefined),
        paths: [to, ...paths],
      };
    }
    throw new Error(`Unknown git ref: ${to}`);
  }

  // to without from shouldn't happen via CLI positionals, but honor options.
  return { ...resolveSnapshots(from, to), paths };
}

/** Single snapshot for `calldiff tree` / `reach` — no ref → working tree. */
export function resolveSnapshot(ref: string | undefined): Snapshot {
  if (ref === undefined) {
    return { kind: "worktree", ref: "WORKTREE" };
  }
  return { kind: "commit", ref };
}

/**
 * Resolve optional ref + path filters for tree/reach.
 * A lone positional that isn't a git ref but exists on disk is treated as a
 * path filter on the working tree (`calldiff tree -e foo src/lib`).
 */
export function resolveSnapshotAndPaths(
  cwd: string,
  ref: string | undefined,
  paths: string[],
): SnapshotWithPaths {
  if (ref === undefined) {
    return { snapshot: resolveSnapshot(undefined), paths };
  }

  if (isCommitRef(cwd, ref)) {
    return { snapshot: resolveSnapshot(ref), paths };
  }
  if (isPathOnDisk(cwd, ref)) {
    return {
      snapshot: resolveSnapshot(undefined),
      paths: [ref, ...paths],
    };
  }
  throw new Error(`Unknown git ref: ${ref}`);
}

export function verifyCommit(cwd: string, ref: string): void {
  if (!isCommitRef(cwd, ref)) {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

const SOURCE_EXT = new Set(listSupportedExtensions());

function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXT.has(lower.slice(dot));
}

export interface SnapshotFile {
  path: string;
  /** Git blob metadata. Worktree files do not have it. */
  oid?: string;
  size?: number;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function listWorktreeFiles(cwd: string): SnapshotFile[] {
  const output = git(cwd, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);

  return output
    .split("\0")
    .filter(
      (path) =>
        path && isSourceFile(path) && isRegularFile(resolve(cwd, path)),
    )
    .map((path) => ({ path }));
}

function listCommitFiles(cwd: string, ref: string): SnapshotFile[] {
  const output = git(cwd, ["ls-tree", "-r", "-z", "-l", ref]);
  const files: SnapshotFile[] = [];

  for (const record of output.split("\0")) {
    if (!record) continue;

    const tab = record.indexOf("\t");
    if (tab < 0) continue;

    const [mode, type, oid, sizeText] = record
      .slice(0, tab)
      .trim()
      .split(/\s+/);
    const path = record.slice(tab + 1);
    const regular = mode === "100644" || mode === "100755";
    const size = Number(sizeText);
    if (
      regular &&
      type === "blob" &&
      oid &&
      Number.isInteger(size) &&
      isSourceFile(path)
    ) {
      files.push({ path, oid, size });
    }
  }

  return files;
}

function pathAllowed(file: string, pathFilters: string[]): boolean {
  if (pathFilters.length === 0) return true;
  return pathFilters.some((filter) => {
    const normalized = filter.replace(/^\.\//, "").replace(/\/$/, "");
    return (
      file === normalized ||
      file.startsWith(`${normalized}/`) ||
      file.endsWith(normalized)
    );
  });
}

/**
 * Bounds on what call-flow analysis parses from one revision: a source file over
 * this size is generated or minified code, not something a person reads, and the
 * files beyond the limit are left out (in path order, so the same repository
 * always leaves out the same ones). The review names what was skipped.
 */
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
export const MAX_INDEXED_FILES = 15_000;

export interface SkippedSources {
  /** Source files over the size bound. */
  oversized: number;
  /** Files past the count bound. */
  beyondLimit: number;
}

const skipped: SkippedSources = { oversized: 0, beyondLimit: 0 };

/** What was left out of call-flow analysis since the last call; clears the count. */
export function takeSkippedSources(): SkippedSources {
  const counts = { ...skipped };
  skipped.oversized = 0;
  skipped.beyondLimit = 0;
  return counts;
}

export function listSnapshotFiles(
  cwd: string,
  snapshot: Snapshot,
  pathFilters: string[] = [],
  limits: { readonly maxFiles: number; readonly maxFileBytes: number } = { maxFiles: MAX_INDEXED_FILES, maxFileBytes: MAX_INDEXED_FILE_BYTES },
): SnapshotFile[] {
  const files =
    snapshot.kind === "worktree"
      ? listWorktreeFiles(cwd)
      : listCommitFiles(cwd, snapshot.ref);

  const wanted = files
    .filter((file) => pathAllowed(file.path, pathFilters))
    .sort((a, b) => a.path.localeCompare(b.path));
  const small = wanted.filter((file) => file.size === undefined || file.size <= limits.maxFileBytes);
  skipped.oversized += wanted.length - small.length;
  skipped.beyondLimit += Math.max(0, small.length - limits.maxFiles);
  return small.slice(0, limits.maxFiles);
}

const BATCH_BYTES = 32 * 1024 * 1024;

type Blob = { oid: string; size: number };

function chunkBlobs(files: SnapshotFile[]): Blob[][] {
  const unique = new Map<string, number>();
  for (const file of files) {
    if (file.oid && file.size !== undefined && !unique.has(file.oid)) {
      unique.set(file.oid, file.size);
    }
  }

  const chunks: Blob[][] = [];
  let chunk: Blob[] = [];
  let bytes = 0;
  for (const [oid, size] of unique) {
    if (chunk.length > 0 && bytes + size > BATCH_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push({ oid, size });
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function readBlobBatch(cwd: string, batch: Blob[]): Map<string, string> {
  const input = Buffer.from(`${batch.map((blob) => blob.oid).join("\n")}\n`);
  const bytes = batch.reduce((total, blob) => total + blob.size, 0);
  const maxBuffer = bytes + batch.length * 128 + 1024;
  const output = gitBuffer(cwd, ["cat-file", "--batch"], input, maxBuffer);
  const blobs = new Map<string, string>();
  let offset = 0;

  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("Invalid git cat-file response");

    const header = output.subarray(offset, headerEnd).toString("ascii");
    const [oid, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (!oid || type !== "blob" || !Number.isInteger(size)) {
      throw new Error(`Invalid git cat-file header: ${header}`);
    }

    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length) {
      throw new Error(`Truncated git blob: ${oid}`);
    }

    blobs.set(oid, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }

  return blobs;
}

export function visitCommitBlobs(
  cwd: string,
  files: SnapshotFile[],
  visit: (oid: string, source: string) => void,
): void {
  for (const batch of chunkBlobs(files)) {
    for (const [oid, source] of readBlobBatch(cwd, batch)) {
      visit(oid, source);
    }
  }
}

export function visitWorktreeFiles(
  cwd: string,
  files: SnapshotFile[],
  visit: (file: SnapshotFile, source: string) => void,
): void {
  for (const file of files) {
    const full = resolve(cwd, file.path);
    if (!isRegularFile(full)) continue;
    visit(file, readFileSync(full, "utf8"));
  }
}

export function describeSnapshot(snapshot: Snapshot): string {
  return snapshot.kind === "worktree" ? "working tree" : snapshot.ref;
}

/**
 * Read one file from a snapshot, or null when it does not exist there.
 *
 * A commit is read through git, so the text is the immutable blob the revision
 * recorded even when the worktree has moved on. A worktree snapshot reads the
 * file on disk.
 */
export function readSnapshotFile(
  cwd: string,
  snapshot: Snapshot,
  path: string,
): string | null {
  if (snapshot.kind === "worktree") {
    const full = resolve(cwd, path);
    if (!isRegularFile(full)) return null;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }
  try {
    return git(cwd, ["show", `${snapshot.ref}:${path}`]);
  } catch {
    return null;
  }
}
