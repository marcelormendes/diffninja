/**
 * Project context for a git-range review, read from the local repository only.
 *
 * What a diff cannot show a reviewer is often the history and habits around it:
 * the removed lines came from a fix, a similar change was reverted before, the
 * project writes down rules for contributors, or every sibling file follows a
 * pattern this one does not. All four are read here with plain git commands on
 * the reviewed snapshots — nothing is fetched, checked out, or written — and are
 * reported as pointers for the reviewer and the agent, never as verdicts. Commit
 * subjects are repository text: data to show, not instructions to follow.
 *
 * Every selection is deterministic: the same repository and range yield the same
 * context. A shallow clone cuts history, and lines whose origin lies past the cut
 * are counted as unknown rather than attributed to the boundary commit.
 */

import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { testLikeFile } from "./file-role.js";
import type { ReviewUnit } from "./types.js";

export interface CommitRef {
  /** Abbreviated to 12 hex digits. */
  readonly commit: string;
  /** Author date, UTC, `YYYY-MM-DD`. */
  readonly date: string;
  /** First line of the commit message, verbatim; untrusted repository text. */
  readonly subject: string;
}

/** A commit that last changed some of the lines a hunk removes or rewrites. */
export interface LineOrigin extends CommitRef {
  /** How many of the hunk's removed lines it last changed. */
  readonly lines: number;
  /** The subject names a fix, workaround, regression, revert, or compatibility concern. */
  readonly notable: boolean;
}

export interface HunkHistory {
  /** At most {@link MAX_ORIGINS_PER_HUNK}, most lines first. */
  readonly origins: LineOrigin[];
  /** Removed lines whose origin is past a shallow clone's boundary or could not be read. */
  readonly unknownLines: number;
}

/** A revert commit before the base that a reviewer may want to compare this change with. */
export interface RevertRef extends CommitRef {
  /** `file` when it touched a file this diff changes; otherwise the shared word. */
  readonly reason: { readonly kind: "file"; readonly file: string } | { readonly kind: "term"; readonly term: string };
}

/** Identifiers most sibling files share that a new file does not use. */
export interface PeerConvention {
  readonly file: string;
  /** Glob-like pattern the peers match, e.g. `homeassistant/components/*\/select.py`. */
  readonly pattern: string;
  /** Peers read (at most {@link MAX_PEERS}). */
  readonly peers: number;
  readonly common: readonly { readonly name: string; readonly peers: number }[];
}

export interface ProjectContext {
  /** `shallow` when the clone's history is cut, so origins and reverts may be missing. */
  readonly history: "complete" | "shallow";
  readonly reverts: RevertRef[];
  /** Repository paths of contributor guidelines, nearest to the changed files first. */
  readonly guidelines: string[];
  readonly conventions: PeerConvention[];
}

export const MAX_ORIGINS_PER_HUNK = 3;
export const MAX_REVERTS = 5;
export const MAX_GUIDELINES = 10;
export const MAX_CONVENTIONS = 5;
export const MAX_PEERS = 300;
/** Commits scanned for reverts, newest first from the base. */
export const REVERT_SCAN_COMMITS = 5000;
/** Files blamed per review; the rest carry no history. */
export const MAX_BLAMED_FILES = 60;
const MIN_PEERS = 4;
/** A peer convention is an identifier at least this share of peers use. */
const PEER_SHARE = 0.6;
const MAX_COMMON_NAMES = 8;
const GIT_TIMEOUT_MS = 30_000;

const NOTABLE_SUBJECT =
  /\b(?:fix(?:e[sd])?|bug|workaround|work around|regression|revert(?:s|ed)?|hotfix|security|cve-\d+|vulnerab\w*|msrv|compat\w*|crash\w*|panic\w*|race|deadlock\w*|leak\w*)\b/i;
/** A revert commit: `Revert "…"`, or `area: revert …` / `[area] Revert …` after a prefix. */
const REVERT_SUBJECT = /(?:^|:\s*|\]\s*)revert(?:s|ing)?\b/i;
/** Routine fixes that do not make removed lines worth a question. */
const ROUTINE_SUBJECT = /\b(?:typos?|spelling|format(?:ting)?|fmt|rustfmt|prettier|lint(?:s|ing)?|clippy|whitespace|docs?|comments?|style|warnings?)\b/i;
/** A shared word relates two subjects only if at most this share of scanned subjects use it. */
const RARE_TERM_SHARE = 0.005;

/** Contributor guideline file names, anywhere in the tree. */
const GUIDELINE_NAME =
  /^(?:contributing|contribute|contributors?[-_ ]?guide|agents|claude|copilot-instructions|style(?:[-_ ]?guide)?|code[-_ ]?style|coding[-_ ]?(?:style|standards|guidelines)|guidelines?|reviewing|review[-_ ]?guidelines|development|developing|hacking|conventions)(?:\.(?:md|rst|txt|adoc))?$/i;
/** Policy documents under a docs directory. */
const DOCS_POLICY = /(?:^|\/)docs?\/(?:[^/]+\/)*[^/]*(?:contribut|guideline|style|convention|review|policy|versioning|preview|deprecat|compatib)[^/]*\.(?:md|rst|adoc)$/i;

/** Words too common in commit subjects and file names to relate two changes. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "when", "then", "than", "also", "only",
  "add", "adds", "added", "use", "uses", "used", "make", "update", "change", "remove", "removed", "revert",
  "reverted", "reverts", "fix", "fixes", "fixed", "test", "tests", "mod", "lib", "main", "index", "init", "src",
  "util", "utils", "more", "less", "support", "new", "allow", "instead", "related", "changes", "commit", "merge",
  "pull", "request", "branch", "file", "files", "code", "docs", "readme", "version", "bump", "move", "rename",
  "some", "type", "types", "value", "values", "error", "errors", "case", "cases", "default", "option", "options",
  "before", "after", "while", "without", "because", "through", "over", "under", "about", "again", "back", "other",
]);

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", ["--no-replace-objects", "--no-pager", ...args], {
    cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Locale-independent order, so the same repository always sorts the same way. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Old-side line numbers of the lines one hunk removes. */
export function removedLines(unit: ReviewUnit): number[] {
  const lines: number[] = [];
  let old = unit.oldStart;
  for (const line of unit.diff.split("\n").slice(1)) {
    if (line.startsWith("-")) lines.push(old++);
    else if (line.startsWith(" ")) old++;
  }
  return lines;
}

function ranges(lines: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last !== undefined && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else out.push([line, line]);
  }
  return out;
}

interface BlameCommit {
  date: string;
  subject: string;
  boundary: boolean;
}

/** One `git blame --porcelain` run: origin commit per final line, and each commit's metadata. */
export interface ParsedBlame {
  readonly byLine: Map<number, string>;
  readonly commits: Map<string, BlameCommit>;
}

/** Origin commit per final line number, from `git blame --porcelain`. */
export function parseBlame(output: string): ParsedBlame {
  const byLine = new Map<number, string>();
  const commits = new Map<string, BlameCommit>();
  let current: string | undefined;
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header !== null) {
      current = header[1];
      byLine.set(Number(header[2]), current);
      if (!commits.has(current)) commits.set(current, { date: "", subject: "", boundary: false });
      continue;
    }
    if (current === undefined || line.startsWith("\t")) continue;
    const commit = commits.get(current)!;
    if (line.startsWith("author-time ")) commit.date = utcDate(Number(line.slice(12)));
    else if (line.startsWith("summary ")) commit.subject = line.slice(8);
    else if (line === "boundary") commit.boundary = true;
  }
  return { byLine, commits };
}

/** Where the lines each hunk removes came from, keyed by unit id. */
function hunkHistories(cwd: string, base: string, units: readonly ReviewUnit[]): Map<string, HunkHistory> {
  const byFile = new Map<string, { unit: ReviewUnit; lines: number[] }[]>();
  for (const unit of units) {
    if (unit.special !== undefined) continue;
    const lines = removedLines(unit);
    if (lines.length === 0) continue;
    const list = byFile.get(unit.file) ?? [];
    list.push({ unit, lines });
    byFile.set(unit.file, list);
  }
  const out = new Map<string, HunkHistory>();
  for (const [file, hunks] of [...byFile].slice(0, MAX_BLAMED_FILES)) {
    let blame: ParsedBlame;
    try {
      const args = ranges(hunks.flatMap((hunk) => hunk.lines)).flatMap(([a, b]) => ["-L", `${a},${b}`]);
      blame = parseBlame(git(cwd, ["blame", "--porcelain", ...args, base, "--", file]));
    } catch {
      // A file absent at the base (renamed or copied) has no line history here.
      continue;
    }
    for (const { unit, lines } of hunks) {
      const counts = new Map<string, number>();
      let unknownLines = 0;
      for (const line of lines) {
        const sha = blame.byLine.get(line);
        const commit = sha === undefined ? undefined : blame.commits.get(sha);
        if (sha === undefined || commit === undefined || commit.boundary) unknownLines += 1;
        else counts.set(sha, (counts.get(sha) ?? 0) + 1);
      }
      const origins = [...counts]
        .map(([sha, count]): LineOrigin => {
          const commit = blame.commits.get(sha)!;
          const notable = NOTABLE_SUBJECT.test(commit.subject) && !ROUTINE_SUBJECT.test(commit.subject);
          return { commit: sha.slice(0, 12), date: commit.date, subject: commit.subject, lines: count, notable };
        })
        .sort((a, b) => b.lines - a.lines || byCodePoint(b.date, a.date) || byCodePoint(a.commit, b.commit))
        .slice(0, MAX_ORIGINS_PER_HUNK);
      if (origins.length > 0 || unknownLines > 0) out.set(unit.id, { origins, unknownLines });
    }
  }
  return out;
}

/** A crude, fixed stemmer: enough to relate `sharding`, `sharded`, and `shard`. */
function stem(word: string): string {
  const lower = word.toLowerCase();
  for (const suffix of ["ing", "ed"]) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 4) return lower.slice(0, -suffix.length);
  }
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length - 1 >= 4) return lower.slice(0, -1);
  return lower;
}

/** Distinctive word stems in free text or a file name, split on case and punctuation. */
export function topicStems(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  const stems = new Set<string>();
  for (const word of words) {
    if (word.length < 4 || /^\d+$/.test(word) || STOP_WORDS.has(word.toLowerCase())) continue;
    const stemmed = stem(word);
    if (!STOP_WORDS.has(stemmed)) stems.add(stemmed);
  }
  return stems;
}

/** The subject a revert names, without the revert wording, for matching. */
function revertedTopic(subject: string): string {
  const quoted = /"([^"]+)"/.exec(subject);
  return quoted?.[1] ?? subject.replace(REVERT_SUBJECT, " ");
}

function reverts(cwd: string, base: string, files: readonly string[], goal: string): RevertRef[] {
  const format = "--format=%H%x1f%at%x1f%s";
  const parse = (line: string) => {
    const [sha, time, subject] = line.split("\x1f");
    return { sha, ref: { commit: sha.slice(0, 12), date: utcDate(Number(time)), subject } };
  };
  const found: RevertRef[] = [];
  const seen = new Set<string>();
  // Reverts that touched a file this diff changes, newest first.
  if (files.length > 0) {
    const touched = git(cwd, ["log", "-n", "200", "-i", "-E", "--grep=\\brevert", format, base, "--", ...files]);
    for (const line of touched.split("\n").filter(Boolean)) {
      const { sha, ref } = parse(line);
      if (!REVERT_SUBJECT.test(ref.subject) || seen.has(sha)) continue;
      const file = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha, "--", ...files]).split("\n").filter(Boolean).sort()[0];
      seen.add(sha);
      found.push({ ...ref, reason: { kind: "file", file: file ?? files[0] } });
    }
  }
  // Reverts anywhere whose subject shares a rare word with the goal or the changed file names.
  // A word most subjects use (the project's name, a common area prefix) relates nothing.
  const topic = topicStems(`${goal} ${files.map((file) => posix.basename(file).replace(/\.[^.]*$/, "")).join(" ")}`);
  if (topic.size > 0) {
    const scanned = git(cwd, ["log", "-n", String(REVERT_SCAN_COMMITS), format, base]).split("\n").filter(Boolean).map(parse);
    const frequency = new Map<string, number>();
    for (const { ref } of scanned) for (const word of topicStems(ref.subject)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    const rare = Math.max(3, Math.floor(scanned.length * RARE_TERM_SHARE));
    for (const { sha, ref } of scanned) {
      if (seen.has(sha) || !REVERT_SUBJECT.test(ref.subject)) continue;
      // The rarest shared word names the relation best.
      const term = [...topicStems(revertedTopic(ref.subject))]
        .filter((word) => topic.has(word) && (frequency.get(word) ?? 0) <= rare)
        .sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) || byCodePoint(a, b))[0];
      if (term === undefined) continue;
      seen.add(sha);
      found.push({ ...ref, reason: { kind: "term", term } });
    }
  }
  return found.slice(0, MAX_REVERTS);
}

/** Guideline paths in the head tree, nearest to the changed files first. */
export function guidelinePaths(tree: readonly string[], changed: readonly string[]): string[] {
  const ancestors = new Map<string, number>();
  for (const file of changed) {
    const parts = file.split("/").slice(0, -1);
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const dir = parts.slice(0, depth).join("/");
      ancestors.set(dir, Math.max(ancestors.get(dir) ?? -1, depth));
    }
  }
  const rank = (path: string): number => {
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    const depth = ancestors.get(dir);
    if (depth !== undefined) return 1000 - depth; // guidelines next to the change first, the root last
    if (path.startsWith(".github/")) return 2000;
    return 3000;
  };
  // A guideline applies when it sits in a directory above a changed file, or is
  // project-wide (.github, a docs policy page); another package's guide does not.
  const applies = (path: string): boolean => {
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    if (GUIDELINE_NAME.test(posix.basename(path))) return ancestors.has(dir) || path.startsWith(".github/");
    return DOCS_POLICY.test(path);
  };
  return tree
    .filter((path) => applies(path) && !testLikeFile(path))
    .sort((a, b) => rank(a) - rank(b) || byCodePoint(a, b))
    .slice(0, MAX_GUIDELINES);
}

/** Identifier-like words: CamelCase inside, snake_case, or long names; never keywords. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
function identifiers(text: string): Set<string> {
  const names = new Set<string>();
  for (const [name] of text.matchAll(IDENTIFIER)) {
    if (name.length < 4) continue;
    if (/[a-z][A-Z]/.test(name) || (/_/.test(name) && /[A-Za-z]{2}/.test(name)) || name.length >= 12) names.add(name);
  }
  return names;
}

/** Contents of `<rev>:<path>` blobs, in one `git cat-file --batch` call. */
function readBlobs(cwd: string, rev: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const raw = execFileSync("git", ["--no-replace-objects", "cat-file", "--batch"], {
    cwd, input: paths.map((path) => `${rev}:${path}`).join("\n") + "\n", maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS,
  });
  let offset = 0;
  for (const path of paths) {
    const end = raw.indexOf(0x0a, offset);
    const header = raw.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (size === null) continue;
    out.set(path, raw.subarray(offset, offset + Number(size[1])).toString("utf8"));
    offset += Number(size[1]) + 1;
  }
  return out;
}

/**
 * For each new file, the nearest set of sibling files with the same name
 * (`<prefix>/*\/<rest>`) and the identifiers most of them use that it does not.
 */
function conventions(cwd: string, head: string, tree: readonly string[], added: readonly string[]): PeerConvention[] {
  const treeSet = new Set(tree);
  const out: PeerConvention[] = [];
  for (const file of added) {
    if (out.length >= MAX_CONVENTIONS) break;
    if (testLikeFile(file) || !treeSet.has(file)) continue;
    const parts = file.split("/");
    for (let wild = parts.length - 2; wild >= 0; wild -= 1) {
      const prefix = parts.slice(0, wild).join("/");
      const rest = parts.slice(wild + 1).join("/");
      const peers = tree
        .filter((path) => path !== file && path.endsWith(`/${rest}`) && (prefix === "" || path.startsWith(`${prefix}/`)))
        .filter((path) => path.split("/").length === parts.length && !added.includes(path))
        .sort()
        .slice(0, MAX_PEERS);
      if (peers.length < MIN_PEERS) continue;
      const blobs = readBlobs(cwd, head, [file, ...peers]);
      const own = identifiers(blobs.get(file) ?? "");
      const counts = new Map<string, number>();
      let read = 0;
      for (const peer of peers) {
        const text = blobs.get(peer);
        if (text === undefined) continue;
        read += 1;
        for (const name of identifiers(text)) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const common = [...counts]
        .filter(([name, count]) => !own.has(name) && count >= Math.max(MIN_PEERS, Math.ceil(read * PEER_SHARE)))
        .sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
        .slice(0, MAX_COMMON_NAMES)
        .map(([name, count]) => ({ name, peers: count }));
      const pattern = `${prefix === "" ? "" : `${prefix}/`}*/${rest}`;
      if (common.length > 0) out.push({ file, pattern, peers: read, common });
      break;
    }
  }
  return out;
}

/** New files: hunks that start at old line 0 and remove nothing. */
function addedFiles(units: readonly ReviewUnit[]): string[] {
  const byFile = new Map<string, boolean>();
  for (const unit of units) {
    const isNew = unit.special === undefined && unit.oldStart === 0 && unit.removed === 0;
    byFile.set(unit.file, (byFile.get(unit.file) ?? true) && isNew);
  }
  return [...byFile].filter(([, isNew]) => isNew).map(([file]) => file).sort();
}

/**
 * Read the project context for a range and attach each hunk's line history to
 * its unit. Each part fails on its own: a part that cannot be read is empty.
 */
export function readProjectContext(cwd: string, base: string, head: string, units: ReviewUnit[], goal = ""): ProjectContext {
  const shallow = (() => {
    try {
      return git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
    } catch {
      return false;
    }
  })();
  try {
    const histories = hunkHistories(cwd, base, units);
    for (const unit of units) {
      const history = histories.get(unit.id);
      if (history !== undefined) unit.history = history;
    }
  } catch {
    // Line history is a pointer; its absence is reported by `history` alone.
  }
  const files = [...new Set(units.filter((unit) => unit.special === undefined).map((unit) => unit.file))].sort();
  let revertList: RevertRef[] = [];
  try {
    revertList = reverts(cwd, base, files.filter((file) => !addedFiles(units).includes(file)), goal);
  } catch {
    revertList = [];
  }
  let tree: string[] = [];
  try {
    tree = git(cwd, ["ls-tree", "-r", "--name-only", "-z", head]).split("\0").filter(Boolean);
  } catch {
    tree = [];
  }
  let conventionList: PeerConvention[] = [];
  try {
    conventionList = conventions(cwd, head, tree, addedFiles(units));
  } catch {
    conventionList = [];
  }
  return {
    history: shallow ? "shallow" : "complete",
    reverts: revertList,
    guidelines: guidelinePaths(tree, files),
    conventions: conventionList,
  };
}
