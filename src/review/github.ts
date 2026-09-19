/**
 * Connected GitHub review.
 *
 * One explicit github.com pull request URL in, one canonical diff out, one
 * human-authored review back. `gh` is the only GitHub client: it runs with an
 * explicit argument array, no shell, no prompts, bounded time and output, and
 * the credential the environment already gave it is the identity that is read.
 *
 * Safety invariants:
 * - A snapshot (and therefore every anchor a review may use) is built solely
 *   from the canonical pull request diff, and only after that diff was checked
 *   against the paginated file list GitHub returns for the same pull request.
 *   An added line anchors RIGHT, a deleted line anchors LEFT, a context line
 *   anchors either side. Nothing else is commentable.
 * - A review is submitted only for the same snapshot the caller previewed, with
 *   the previewed payload byte for byte (including the explicit `commit_id`),
 *   after re-reading the metadata and the raw diff and finding them unchanged,
 *   and after the effective gh account was re-checked.
 * - One review per session. An ambiguous write marks the session `unknown`,
 *   never retried; only an exact match found on GitHub resolves it.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ contract */

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type DiffSide = "LEFT" | "RIGHT";

/** One anchor the reviewer wrote by hand; never generated prose. */
export interface ReviewComment {
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

/** What the UI sends for preview and submit; it owns all draft text. */
export interface ReviewInput {
  snapshotId: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

/** Exactly the body POSTed to the GitHub reviews endpoint. */
export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export interface ConnectedIdentity {
  login: string;
  id: number;
}

/** One line of the canonical diff, in new-side order for context and additions. */
export interface SnapshotLine {
  path: string;
  line: number;
  side: DiffSide;
  text: string;
  kind: "add" | "delete" | "context";
}

export interface ConnectedSnapshot {
  id: string;
  url: string;
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  state: string;
  lines: SnapshotLine[];
  /** Set when the pull request exists but cannot be reviewed; `lines` may still be empty. */
  unavailableReason?: string;
}

export interface ConnectedReceipt {
  id: number;
  url: string;
  state: string;
  commitId: string;
}

/**
 * `empty` also covers a loaded pull request that cannot be reviewed
 * (`snapshot.unavailableReason` says why); `ready` means the snapshot is bound
 * and submittable; `unknown` means a write may or may not have landed and only
 * reconciliation may resolve it.
 */
export type ConnectedStatus = "empty" | "ready" | "submitting" | "unknown" | "submitted";

export interface ConnectedState {
  identity?: ConnectedIdentity;
  snapshot?: ConnectedSnapshot;
  status: ConnectedStatus;
  receipt?: ConnectedReceipt;
  message?: string;
}

/* ---------------------------------------------------------------- gh process */

/** Lowest `gh` release whose `pr view --json` fields and `api --input -` this code needs. */
export const MIN_GH_VERSION = "2.45.0";

const GH_TIMEOUT_MS = 15_000;
const GH_OUTPUT_LIMIT = 32 * 1024 * 1024;
const GITHUB_HOST = "github.com";

export interface GhResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GhInvocation {
  readonly args: string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
}

/** Injectable `gh` transport; tests supply a fake, the app uses {@link ghCliRunner}. */
export interface GhRunner {
  run(invocation: GhInvocation): Promise<GhResult>;
}

/**
 * A failed `gh` run. `gh api` prints GitHub's JSON error body to stdout and the
 * HTTP status line to stderr, so both are carried for safe message extraction;
 * neither is ever shown to the user verbatim.
 */
export class GhCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = "GhCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface ConnectedReviewDeps {
  runner?: GhRunner;
  timeoutMs?: number;
}

/** No prompt, no pager, no update notice, and never a host other than github.com. */
function ghEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GH_HOST: GITHUB_HOST, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" };
}

/** Runs the real `gh` with an explicit argv (never a shell) and a hard deadline. */
export function ghCliRunner(): GhRunner {
  return {
    run: (invocation) =>
      new Promise<GhResult>((resolve, reject) => {
        const settle = (error: ExecFileException | null, stdout: string, stderr: string): void => {
          if (error === null) {
            resolve({ stdout, stderr });
            return;
          }
          if (error.code === "ENOENT") {
            reject(new GhCommandError("gh was not found", stdout, stderr));
            return;
          }
          if (error.killed === true || error.code === "ETIMEDOUT") {
            reject(new GhCommandError("gh timed out", stdout, stderr));
            return;
          }
          reject(new GhCommandError(firstLine(stderr) || firstLine(stdout) || "gh failed", stdout, stderr));
        };
        const child = execFile("gh", [...invocation.args], {
          timeout: invocation.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: GH_OUTPUT_LIMIT,
          encoding: "utf8",
          windowsHide: true,
          env: ghEnvironment(),
        }, settle);
        child.stdin?.end(invocation.stdin ?? "");
      }),
  };
}

function firstLine(text: string): string {
  const [line] = text.trim().split("\n");
  return (line ?? "").trim().slice(0, 200);
}

const AUTH_FAILURE = "gh is not authenticated for github.com. Run `gh auth login --hostname github.com` and try again.";
const AUTHORIZATION_FAILURE = "The gh account is not authorized for that repository. Check its access and token scopes.";
const NOT_FOUND_FAILURE = "GitHub did not return that pull request. Check the URL, or confirm the gh account can read the repository.";

/** What the caller was attempting, so a rejection says which thing GitHub refused. */
type RejectionSubject = "request" | "review";

/** Drop control characters and cap length; GitHub error text is data, not a channel. */
function sanitizeText(text: string): string {
  const cleaned = text.replace(/[\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned;
}

/**
 * GitHub's own explanation from a JSON error body: its `message` plus every
 * `errors[]` entry (a plain string, or an object with a `message`). Only these
 * named fields are read, so process output, tokens, and headers cannot leak.
 */
function githubErrorText(stdout: string): string | null {
  const decoded = tryParseJson(stdout);
  if (!isGhObject(decoded)) return null;
  const parts: string[] = [];
  const message = textField(decoded, "message");
  if (message !== null && sanitizeText(message) !== "") parts.push(sanitizeText(message));
  const errors = decoded["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const text = isGhObject(entry) ? textField(entry, "message") : isGhText(entry) ? entry : null;
      const cleaned = text === null ? "" : sanitizeText(text);
      if (cleaned !== "" && !parts.includes(cleaned)) parts.push(cleaned);
    }
  }
  return parts.length === 0 ? null : parts.join(" — ");
}

function httpStatus(error: GhCommandError): number | null {
  const match = /\bHTTP (\d{3})\b/.exec(`${error.message}\n${error.stderr}`);
  return match === null ? null : Number(match[1]);
}

/** Normalize anything a runner threw, so every failure carries the same shape. */
function asGhCommandError(error: Error): GhCommandError {
  return error instanceof GhCommandError ? error : new GhCommandError(error.message, "", "");
}

function githubBodyError(message: string): Error {
  const cleaned = sanitizeText(message);
  if (/not found/i.test(cleaned)) return new Error(NOT_FOUND_FAILURE);
  if (/bad credentials|requires authentication/i.test(cleaned)) return new Error(AUTH_FAILURE);
  if (/forbidden|not accessible|not authorized/i.test(cleaned)) return new Error(AUTHORIZATION_FAILURE);
  return new Error(`GitHub rejected the request: ${cleaned}`);
}

/**
 * Map a raw `gh` failure to a safe, user-facing error. Read failures stay
 * neutral — no failure text claims the pull request was untouched, because when
 * a submission is unresolved a later read failing proves nothing about it. The
 * one place that may say "nothing was submitted" is the definite rejection path
 * of {@link ConnectedReview.submit}, where GitHub itself answered the write.
 */
function classifyGhFailure(rawError: Error, subject: RejectionSubject): Error {
  const error = asGhCommandError(rawError);
  const detail = error.message;
  const status = httpStatus(error);
  const github = githubErrorText(error.stdout);
  if (status === 408 || /timed out|timeout/i.test(detail)) {
    return new Error("gh did not answer in time; the request did not complete. Check the network, then try again.");
  }
  if (/was not found/i.test(detail) && status === null) return new Error("The GitHub CLI (gh) was not found on PATH. Install gh 2.45.0 or newer and try again.");
  if (/unknown json field|unknown flag|unknown shorthand|unknown command/i.test(detail)) {
    return new Error(`The installed gh does not support the flags diffninja needs. Update gh to ${MIN_GH_VERSION} or newer.`);
  }
  if (status === 401 || /bad credentials|not logged in|gh auth login|authentication required/i.test(detail)) return new Error(AUTH_FAILURE);
  if (status === 403 || /resource not accessible|forbidden|must have push|not authorized|insufficient/i.test(detail)) {
    // A 403 has many causes; GitHub's own text is what tells them apart.
    return new Error(github === null ? AUTHORIZATION_FAILURE : `${AUTHORIZATION_FAILURE} GitHub said: ${github}.`);
  }
  if (status === 404 || /could not resolve to a pull ?request|pull request was not found/i.test(detail)) return new Error(NOT_FOUND_FAILURE);
  if (status !== null && status >= 400 && status < 500) {
    const what = subject === "review" ? "GitHub rejected the review" : "The request was rejected";
    return new Error(github === null ? `${what}: ${sanitizeText(detail)}` : `${what}: ${github}`);
  }
  if (github !== null) {
    return new Error(`GitHub returned a server error; the request did not complete: ${github}. Try again in a moment.`);
  }
  if (status !== null && status >= 500) return new Error("GitHub returned a server error; the request did not complete. Try again in a moment.");
  if (/connection refused|no such host|name resolution|network is unreachable|unexpected EOF|TLS handshake|proxyconnect/i.test(detail)) {
    return new Error("diffninja could not reach GitHub; the request did not complete. Check the network and try again.");
  }
  return new Error("The gh command failed; the request did not complete.");
}

/* ------------------------------------------------------------- JSON boundary */

/** The JSON data model, used to validate each `gh` payload field by field. */
export type GhJson = string | number | boolean | null | GhJson[] | GhObject;

export interface GhObject {
  readonly [key: string]: GhJson;
}

function isGhObject(value: GhJson | null | undefined): value is GhObject {
  // JSON.parse only produces plain objects, arrays, and primitives, so plain
  // objects are exactly the values whose prototype is Object.prototype.
  return value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;
}

function isGhText(value: GhJson | null | undefined): value is string {
  // Number, boolean, array, and object values all stringify to something other
  // than themselves, so a value that survives String() is a text primitive.
  return value !== null && value !== undefined && String(value) === value;
}

function isGhNumber(value: GhJson | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function isGhBoolean(value: GhJson | null | undefined): value is boolean {
  return value === true || value === false;
}

function textField(object: GhObject | null, key: string): string | null {
  if (object === null) return null;
  const value = object[key];
  return isGhText(value) ? value : null;
}

function numberField(object: GhObject | null, key: string): number | null {
  if (object === null) return null;
  const value = object[key];
  return isGhNumber(value) ? value : null;
}

function booleanField(object: GhObject | null, key: string): boolean | null {
  if (object === null) return null;
  const value = object[key];
  return isGhBoolean(value) ? value : null;
}

function objectField(object: GhObject | null, key: string): GhObject | null {
  if (object === null) return null;
  const value = object[key];
  return isGhObject(value) ? value : null;
}

/** Decode a `gh` stdout body into the JSON data model. */
function parseJson(text: string, what: string): GhJson {
  try {
    // SAFETY: JSON.parse produces the JSON data model, which GhJson describes
    // exactly; every field read from it is revalidated by the guards above.
    return JSON.parse(text) as GhJson;
  } catch {
    throw new Error(`gh returned a ${what} that was not valid JSON.`);
  }
}

/**
 * Split concatenated JSON values. `gh api --paginate` prints one JSON document
 * per page, so the stream is not a single parseable document; the scanner
 * tracks strings and escapes so a page boundary inside a string cannot confuse
 * it, and a stream that ends mid-value is reported as truncated.
 */
function splitJsonStream(text: string, what: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      if (start === -1) start = index;
      continue;
    }
    if (character === "[" || character === "{") {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (character === "]" || character === "}") {
      depth--;
      if (depth < 0) throw new Error(`gh returned a malformed ${what}.`);
      if (depth === 0) {
        chunks.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (inString || depth !== 0) throw new Error(`gh returned a truncated ${what}.`);
  return chunks;
}

/**
 * Every row of a paginated `gh api` answer. Pages are concatenated arrays;
 * `--slurp`-style nesting is flattened too. An error document is reported as
 * GitHub's own message rather than as a shape mismatch.
 */
function decodePages(text: string, what: string): GhJson[] {
  const rows: GhJson[] = [];
  for (const chunk of splitJsonStream(text, what)) {
    const page = parseJson(chunk, what);
    if (isGhObject(page)) {
      const message = textField(page, "message");
      throw message === null ? new Error(`GitHub's ${what} was not a list.`) : githubBodyError(message);
    }
    if (!Array.isArray(page)) throw new Error(`GitHub's ${what} was not a list.`);
    for (const row of page) {
      if (Array.isArray(row)) rows.push(...row);
      else rows.push(row);
    }
  }
  return rows;
}

/* ------------------------------------------------------------ pull request URL */

interface PullTarget {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/** Strictly an explicit github.com pull request URL; no search, no shorthand. */
function parsePullUrl(raw: string): PullTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Enter a full GitHub pull request URL, such as https://github.com/owner/repo/pull/123.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== GITHUB_HOST) {
    throw new Error("Only https://github.com pull request URLs are supported.");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Remove the query string or fragment from the pull request URL.");
  }
  const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
  if (match === null) {
    throw new Error("Enter a pull request URL of the form https://github.com/owner/repo/pull/123.");
  }
  const owner = match[1];
  const repo = match[2];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error("Enter a pull request URL of the form https://github.com/owner/repo/pull/123.");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) {
    throw new Error("That pull request number is out of range.");
  }
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

interface PrMetadata {
  url: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  baseSha: string;
  headSha: string;
  baseRefName: string;
  headRefName: string;
  crossRepository: boolean;
  headRepository: string;
  headRepositoryOwner: string;
}

/* -------------------------------------------------------------- diff parsing */

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

interface ParsedLine {
  kind: "add" | "delete" | "context";
  text: string;
}

interface ParsedFile {
  path: string;
  oldPath: string;
  /** Hunk headers and body rows exactly as GitHub wrote them. */
  patch: string[];
  hunks: number;
  special: "binary" | "link" | null;
}

interface ParsedDiff {
  files: ParsedFile[];
  lines: SnapshotLine[];
  anchors: Set<string>;
  problem: string | null;
}

/** Every anchor a comment may legitimately use. */
function anchorKey(path: string, line: number, side: DiffSide): string {
  return `${path}\u0000${side}:${line}`;
}

function unquotePath(raw: string): string {
  const value = raw.split("\t")[0] ?? "";
  if (value.startsWith('"')) return value;
  return value.replace(/^[ab]\//, "");
}

const COMBINED_PROBLEM = "GitHub returned a combined merge diff, and diffninja cannot anchor review comments to one.";
const BINARY_PROBLEM = "This pull request changes binary files, so diffninja cannot place line review comments.";
const LINK_PROBLEM = "This pull request changes a submodule or symbolic link, which diffninja does not review line by line.";
const HTML_PROBLEM = "GitHub returned an HTML page instead of a diff. Check that the gh account can read this pull request.";
const EMPTY_PROBLEM = "GitHub returned an empty diff for this pull request.";
const UNPARSED_PROBLEM = "GitHub returned a diff that diffninja could not parse; refusing to review an unverified diff.";

function incompleteProblem(path: string): string {
  const where = path === "" ? "this pull request" : path;
  return `GitHub returned an incomplete diff for ${where}; diffninja will not review a partial diff.`;
}

/**
 * Parse the canonical diff as strictly as it can be parsed: every hunk header
 * must account for exactly its line counts, and anything GitHub would not
 * produce (truncation, combined diffs, stray headers) rejects the snapshot
 * instead of silently dropping reviewable lines.
 */
function parseCanonicalDiff(rawDiff: string): ParsedDiff {
  const empty: ParsedDiff = { files: [], lines: [], anchors: new Set(), problem: null };
  const fatal = (problem: string): ParsedDiff => ({ ...empty, problem });
  const text = rawDiff.replace(/\r\n/g, "\n");
  if (text.trim() === "") return fatal(EMPTY_PROBLEM);
  if (text.trimStart().startsWith("<")) return fatal(HTML_PROBLEM);
  const rows = text.split("\n");
  const files: ParsedFile[] = [];
  const lines: SnapshotLine[] = [];
  const anchors = new Set<string>();
  let current: ParsedFile | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === "") continue;
    if (row.startsWith("diff --cc ") || row.startsWith("diff --combined ")) return fatal(COMBINED_PROBLEM);
    if (row.startsWith("diff --git ")) {
      const names = /^diff --git (.*) (.*)$/.exec(row);
      current = { path: unquotePath(names?.[2] ?? ""), oldPath: unquotePath(names?.[1] ?? ""), patch: [], hunks: 0, special: null };
      files.push(current);
      continue;
    }
    if (current === null) {
      if (row.startsWith("@@")) return fatal(COMBINED_PROBLEM);
      return fatal(UNPARSED_PROBLEM);
    }
    if (row === "GIT binary patch" || row.startsWith("Binary files ") || row.startsWith("Binary file ")) {
      current.special = "binary";
      continue;
    }
    if (/^(new file mode|old mode|new mode|index|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|deleted file mode) /.test(row)) {
      if (/(^|\s)(120000|160000)(\s|$)/.test(row)) current.special = "link";
      continue;
    }
    if (row.startsWith("--- ") && rows[i + 1]?.startsWith("+++ ")) {
      const oldPath = unquotePath(row.slice(4));
      const newPath = unquotePath(rows[++i].slice(4));
      current.oldPath = oldPath;
      current.path = newPath === "/dev/null" ? oldPath : newPath;
      continue;
    }
    if (row.startsWith("@")) {
      if (!row.startsWith("@@ ")) return fatal(COMBINED_PROBLEM);
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (header === null) return fatal(UNPARSED_PROBLEM);
      let oldLine = Number(header[1]);
      let newLine = Number(header[3]);
      let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      let newLeft = header[4] === undefined ? 1 : Number(header[4]);
      const body: string[] = [row];
      while (oldLeft > 0 || newLeft > 0) {
        const next = rows[++i];
        if (next === undefined || next === "") return fatal(incompleteProblem(current.path));
        if (next === NO_NEWLINE_MARKER) {
          body.push(next);
          continue;
        }
        let parsed: ParsedLine;
        if (next.startsWith("+")) parsed = { kind: "add", text: next.slice(1) };
        else if (next.startsWith("-")) parsed = { kind: "delete", text: next.slice(1) };
        else if (next.startsWith(" ")) parsed = { kind: "context", text: next.slice(1) };
        else return fatal(incompleteProblem(current.path));
        body.push(next);
        if (parsed.kind === "add") {
          lines.push({ path: current.path, line: newLine, side: "RIGHT", text: parsed.text, kind: "add" });
          anchors.add(anchorKey(current.path, newLine, "RIGHT"));
          newLine++;
          newLeft--;
        } else if (parsed.kind === "delete") {
          lines.push({ path: current.path, line: oldLine, side: "LEFT", text: parsed.text, kind: "delete" });
          anchors.add(anchorKey(current.path, oldLine, "LEFT"));
          oldLine++;
          oldLeft--;
        } else {
          lines.push({ path: current.path, line: newLine, side: "RIGHT", text: parsed.text, kind: "context" });
          anchors.add(anchorKey(current.path, newLine, "RIGHT"));
          anchors.add(anchorKey(current.path, oldLine, "LEFT"));
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        }
        if (oldLeft < 0 || newLeft < 0) return fatal(incompleteProblem(current.path));
      }
      if (rows[i + 1] === NO_NEWLINE_MARKER) body.push(rows[++i]);
      current.patch.push(...body);
      current.hunks++;
      continue;
    }
    if (row.startsWith("@@@") || row.startsWith("@@")) return fatal(COMBINED_PROBLEM);
    return fatal(UNPARSED_PROBLEM);
  }

  if (files.length === 0) return fatal(EMPTY_PROBLEM);
  if (files.some((file) => file.special === "binary")) return fatal(BINARY_PROBLEM);
  if (files.some((file) => file.special === "link")) return fatal(LINK_PROBLEM);
  if (files.some((file) => file.path === "")) return fatal(UNPARSED_PROBLEM);
  return { files, lines, anchors, problem: null };
}

/* ------------------------------------------------------- canonical validation */

interface ListedFile {
  filename: string;
  previous: string | null;
  patch: string | null;
}

function listedFiles(listing: GhJson): ListedFile[] | null {
  if (!Array.isArray(listing)) return null;
  const entries: ListedFile[] = [];
  for (const row of listing) {
    if (!isGhObject(row)) return null;
    const filename = textField(row, "filename");
    if (filename === null) return null;
    entries.push({ filename, previous: textField(row, "previous_filename"), patch: textField(row, "patch") });
  }
  return entries;
}

function normalizePatch(text: string): string[] {
  const rows = text.replace(/\r\n/g, "\n").split("\n").filter((row) => row !== NO_NEWLINE_MARKER);
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

function samePatch(raw: string[], patch: string): boolean {
  const rows = normalizePatch(patch);
  const expected = raw.filter((row) => row !== NO_NEWLINE_MARKER);
  return rows.length === expected.length && rows.every((row, index) => row === expected[index]);
}

/**
 * The diff GitHub serves for the pull request must agree, file by file, with
 * the paginated file list of that same pull request. Anything else means one of
 * the two answers was truncated, so no report is built at all.
 */
function checkCoverage(files: ParsedFile[], listing: GhJson): string | null {
  const entries = listedFiles(listing);
  if (entries === null) return "GitHub did not return a usable file list for this pull request.";
  const used = new Set<number>();
  for (const file of files) {
    const index = entries.findIndex((entry, position) => !used.has(position)
      && (entry.filename === file.path || entry.filename === file.oldPath || entry.previous === file.oldPath));
    if (index === -1) {
      return `GitHub's diff includes ${file.path}, but its file list for the same pull request does not.`;
    }
    used.add(index);
    const patch = entries[index].patch;
    if (patch === null) {
      if (file.patch.length > 0) return incompleteProblem(file.path);
      continue;
    }
    if (!samePatch(file.patch, patch)) {
      return `GitHub's file list and its diff disagree about ${file.path}; refusing to review an unverified diff.`;
    }
  }
  for (let index = 0; index < entries.length; index++) {
    if (!used.has(index)) {
      return `GitHub's file list includes ${entries[index].filename}, but the diff for the same pull request does not.`;
    }
  }
  return null;
}

function validateCanonicalDiff(rawDiff: string, listing: GhJson): ParsedDiff {
  const parsed = parseCanonicalDiff(rawDiff);
  if (parsed.problem !== null) return { files: [], lines: [], anchors: new Set(), problem: parsed.problem };
  const coverage = checkCoverage(parsed.files, listing);
  if (coverage !== null) return { files: [], lines: [], anchors: new Set(), problem: coverage };
  return parsed;
}

/* ------------------------------------------------------------------ session */

const VIEW_FIELDS = [
  "url", "id", "number", "state", "baseRefOid", "headRefOid", "isCrossRepository",
  "headRepository", "headRepositoryOwner", "baseRefName", "headRefName",
].join(",");

const MAX_REVIEW_CHARS = 65_536;
const MAX_COMMENT_CHARS = 65_536;
const MAX_COMMENTS = 100;
const ACCEPT_JSON = "Accept: application/vnd.github+json";
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
/** Control characters except TAB; CR and LF are rejected separately with their own message. */
const CONTROL_CHARACTERS = /[^\P{Cc}\t]/u;

/** Binds host, repository, number, base, head, state, and the exact diff bytes. */
function snapshotId(meta: PrMetadata, rawDiff: string): string {
  const diffHash = createHash("sha256").update(rawDiff).digest("hex");
  return createHash("sha256").update(`${meta.owner}/${meta.repo}#${meta.number}|${meta.baseSha}|${meta.headSha}|${meta.state}|${diffHash}`).digest("hex");
}

interface PullCoordinates {
  owner: string;
  repo: string;
  number: number;
}

function apiPath(coordinates: PullCoordinates, suffix: string): string {
  return `repos/${coordinates.owner}/${coordinates.repo}/pulls/${coordinates.number}${suffix === "" ? "" : `/${suffix}`}`;
}

interface SnapshotRead {
  snapshot: ConnectedSnapshot;
  anchors: Set<string>;
  /** A fact the reviewer should see even though the snapshot is reviewable. */
  note: string | null;
}

/**
 * A fork head still reviews fine: comments anchor to the base repository's diff
 * and `commit_id` is the head commit. Say so, because the reviewer is looking
 * at a commit that does not exist in the base repository.
 */
function forkNote(meta: PrMetadata): string | null {
  if (!meta.crossRepository) return null;
  return `Head branch "${meta.headRefName}" lives in ${meta.headRepository}, a fork; this review anchors to the diff in ${meta.owner}/${meta.repo}.`;
}

/**
 * One connected review session. Every method serializes behind the previous
 * one, so an in-flight submission can never be double-fired.
 */
export class ConnectedReview {
  private readonly runner: GhRunner;
  private readonly timeoutMs: number;
  private version: string | null = null;
  private identity: ConnectedIdentity | undefined;
  private snapshot: ConnectedSnapshot | undefined;
  private anchors = new Set<string>();
  private status: ConnectedStatus = "empty";
  private receipt: ConnectedReceipt | undefined;
  private message: string | undefined;
  private previewed: { serialized: string } | undefined;
  /** Review ids that already existed before this session's write attempt. */
  private preexistingReviewIds = new Set<number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: ConnectedReviewDeps = {}) {
    this.runner = deps.runner ?? ghCliRunner();
    this.timeoutMs = deps.timeoutMs ?? GH_TIMEOUT_MS;
  }

  getState(): ConnectedState {
    return {
      identity: this.identity,
      snapshot: this.snapshot,
      status: this.status,
      receipt: this.receipt,
      message: this.message,
    };
  }

  async load(url: string): Promise<ConnectedState> {
    return this.serialize(() => this.runLoad(url));
  }

  async preview(input: ReviewInput): Promise<ReviewPayload> {
    return this.serialize(() => this.runPreview(input));
  }

  async submit(input: ReviewInput): Promise<ConnectedState> {
    return this.serialize(() => this.runSubmit(input));
  }

  async reconcile(): Promise<ConnectedState> {
    return this.serialize(() => this.runReconcile());
  }

  /** Run `work` after everything already queued; failures never break the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async call(args: string[], stdin?: string): Promise<GhResult> {
    try {
      return await this.runner.run({ args, stdin, timeoutMs: this.timeoutMs });
    } catch (error) {
      throw classifyGhFailure(error instanceof Error ? error : new Error("gh failed"), "request");
    }
  }

  private async ensureGhVersion(): Promise<void> {
    if (this.version !== null) return;
    const result = await this.call(["--version"]);
    const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
    if (match === null) {
      // Fail closed: an unreadable version cannot be proven new enough for the
      // flags and JSON fields every later call depends on.
      throw new Error(`diffninja could not read the installed gh version. Install gh ${MIN_GH_VERSION} or newer and try again.`);
    }
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (compareVersions(version, MIN_GH_VERSION) < 0) {
      throw new Error(`The installed gh is ${version}, older than the supported ${MIN_GH_VERSION}. Update gh and try again.`);
    }
    this.version = version;
  }

  /** The identity of the credential gh actually uses, re-read before each submit. */
  private async readIdentity(): Promise<ConnectedIdentity> {
    const result = await this.call(["api", "--hostname", GITHUB_HOST, "-H", ACCEPT_JSON, "user"]);
    const payload = parseJson(result.stdout, "account");
    if (!isGhObject(payload)) throw new Error("gh did not report a GitHub account. Run `gh auth login --hostname github.com`.");
    const login = textField(payload, "login");
    const id = numberField(payload, "id");
    if (login === null || id === null) throw new Error("gh did not report a GitHub account. Run `gh auth login --hostname github.com`.");
    const identity: ConnectedIdentity = { login, id };
    const bound = this.identity;
    if (bound !== undefined && (bound.login.toLowerCase() !== login.toLowerCase() || bound.id !== id)) {
      throw new Error(`gh is now authenticated as ${login}, but this session started as ${bound.login}. Refusing to mix accounts; restart diffninja after fixing gh auth.`);
    }
    return identity;
  }

  private async readMetadata(target: PullTarget): Promise<PrMetadata> {
    const result = await this.call(["pr", "view", target.url, "--json", VIEW_FIELDS]);
    const payload = parseJson(result.stdout, "pull request");
    if (!isGhObject(payload)) throw new Error("gh returned an unreadable pull request.");
    const url = textField(payload, "url");
    const state = textField(payload, "state");
    const number = numberField(payload, "number");
    const baseSha = textField(payload, "baseRefOid");
    const headSha = textField(payload, "headRefOid");
    const baseRefName = textField(payload, "baseRefName");
    const headRefName = textField(payload, "headRefName");
    const crossRepository = booleanField(payload, "isCrossRepository");
    const headRepository = textField(objectField(payload, "headRepository"), "nameWithOwner");
    const headRepositoryOwner = textField(objectField(payload, "headRepositoryOwner"), "login");
    if (url === null || state === null || number === null || baseSha === null || headSha === null
      || baseRefName === null || headRefName === null || crossRepository === null
      || headRepository === null || headRepositoryOwner === null) {
      throw new Error(`gh did not return the pull request fields diffninja needs. Update gh to ${MIN_GH_VERSION} or newer.`);
    }
    if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) throw new Error("GitHub reported a malformed base or head commit for this pull request.");
    const canonical = parsePullUrl(url);
    if (canonical.number !== number) throw new Error("GitHub's pull request metadata is inconsistent; refusing to review it.");
    return {
      url: canonical.url,
      owner: canonical.owner,
      repo: canonical.repo,
      number: canonical.number,
      state,
      baseSha,
      headSha,
      baseRefName,
      headRefName,
      crossRepository,
      headRepository,
      headRepositoryOwner,
    };
  }

  private async readCanonicalDiff(meta: PrMetadata): Promise<string> {
    const result = await this.call(["api", "--hostname", GITHUB_HOST, "-H", "Accept: application/vnd.github.diff", apiPath(meta, "")]);
    return result.stdout;
  }

  private async readChangedFiles(meta: PrMetadata): Promise<GhJson[]> {
    const result = await this.call([
      "api", "--hostname", GITHUB_HOST, "--paginate", "-H", ACCEPT_JSON, `${apiPath(meta, "files")}?per_page=100`,
    ]);
    return decodePages(result.stdout, "file list");
  }

  private async readReviewIds(coordinates: PullCoordinates): Promise<Set<number>> {
    const result = await this.call([
      "api", "--hostname", GITHUB_HOST, "--paginate", "-H", ACCEPT_JSON, `${apiPath(coordinates, "reviews")}?per_page=100`,
    ]);
    const ids = new Set<number>();
    for (const row of decodePages(result.stdout, "review list")) {
      const id = isGhObject(row) ? numberField(row, "id") : null;
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  /**
   * Metadata plus the verified canonical diff; the only source of anchors. The
   * metadata is read again after the diff and the file list, so a pull request
   * that moved mid-read is rejected instead of producing a snapshot that mixes
   * two revisions.
   */
  private async readSnapshot(target: PullTarget): Promise<SnapshotRead> {
    const meta = await this.readMetadata(target);
    if (meta.owner.toLowerCase() !== target.owner.toLowerCase() || meta.repo.toLowerCase() !== target.repo.toLowerCase() || meta.number !== target.number) {
      throw new Error(`gh resolved that URL to ${meta.url}, a different pull request. Load that URL explicitly.`);
    }
    const rawDiff = await this.readCanonicalDiff(meta);
    const listing = await this.readChangedFiles(meta);
    const after = await this.readMetadata(target);
    if (after.baseSha !== meta.baseSha || after.headSha !== meta.headSha || after.state !== meta.state) {
      throw new Error("The pull request changed while diffninja was reading it. Load it again.");
    }
    const canonical = validateCanonicalDiff(rawDiff, listing);
    const snapshot: ConnectedSnapshot = {
      id: snapshotId(meta, rawDiff),
      url: meta.url,
      owner: meta.owner,
      repo: meta.repo,
      number: meta.number,
      baseSha: meta.baseSha,
      headSha: meta.headSha,
      state: meta.state,
      lines: canonical.lines,
    };
    const reason = canonical.problem ?? reviewabilityProblem(meta);
    if (reason !== null) snapshot.unavailableReason = reason;
    return { snapshot, anchors: canonical.anchors, note: reason === null ? forkNote(meta) : null };
  }

  /**
   * One PR and one account per session: the first pull request that loads at all
   * is bound, reviewable or not, because a session is about one pull request and
   * switching targets silently is exactly what this mode refuses to do. Only a
   * refresh of that same pull request is allowed.
   */
  private assertLoadable(target: PullTarget): void {
    if (this.status === "submitting") throw new Error("A submission is in flight; wait for it to finish.");
    if (this.status === "unknown") throw new Error("The previous submission is unresolved. Reconcile this session before loading anything else.");
    if (this.status === "submitted") throw new Error("A review was already submitted in this session. Restart diffninja to review another pull request.");
    const bound = this.snapshot;
    if (bound === undefined) return;
    if (bound.owner.toLowerCase() === target.owner.toLowerCase() && bound.repo.toLowerCase() === target.repo.toLowerCase() && bound.number === target.number) return;
    const state = bound.unavailableReason === undefined ? "" : " (not reviewable)";
    throw new Error(`This session is bound to ${bound.owner}/${bound.repo}#${bound.number}${state}. Restart diffninja to review a different pull request.`);
  }

  private async runLoad(url: string): Promise<ConnectedState> {
    const target = parsePullUrl(url);
    this.assertLoadable(target);
    await this.ensureGhVersion();
    const identity = await this.readIdentity();
    const read = await this.readSnapshot(target);
    this.identity = identity;
    this.snapshot = read.snapshot;
    this.anchors = read.anchors;
    this.previewed = undefined;
    this.message = read.snapshot.unavailableReason ?? read.note ?? undefined;
    this.status = read.snapshot.unavailableReason === undefined ? "ready" : "empty";
    return this.getState();
  }

  private runPreview(input: ReviewInput): Promise<ReviewPayload> {
    const payload = this.buildPayload(input);
    this.previewed = { serialized: JSON.stringify(payload) };
    return Promise.resolve(payload);
  }

  private async runSubmit(input: ReviewInput): Promise<ConnectedState> {
    const receipt = this.receipt;
    if (receipt !== undefined) {
      throw new Error(`A review was already submitted in this session (${receipt.url}).`);
    }
    if (this.status === "unknown") {
      throw new Error("The previous submission is unresolved. Reconcile before submitting anything else.");
    }
    const payload = this.buildPayload(input);
    const previewed = this.previewed;
    if (previewed === undefined) throw new Error("Preview the review before submitting it.");
    if (previewed.serialized !== JSON.stringify(payload)) {
      throw new Error("The review changed after the last preview. Preview it again before submitting.");
    }
    const snapshot = this.snapshot;
    if (snapshot === undefined) throw new Error("Load a pull request before submitting a review.");
    const target: PullTarget = { owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number, url: snapshot.url };
    const identity = await this.readIdentity();
    const read = await this.readSnapshot(target);
    if (read.snapshot.unavailableReason !== undefined) {
      throw new Error(`This pull request cannot be reviewed any more: ${read.snapshot.unavailableReason}`);
    }
    if (read.snapshot.id !== snapshot.id) {
      throw new Error("The pull request changed since it was loaded. Reload it, then preview the review again.");
    }
    this.identity = identity;
    this.anchors = read.anchors;
    // Read the reviews that exist BEFORE the write. Reconciliation is then able
    // to tell this session's review from an identical review left by an earlier
    // one, which would otherwise look like proof that this write landed.
    this.preexistingReviewIds = await this.readReviewIds(snapshot);
    await this.postReview(snapshot, payload);
    return this.getState();
  }

  private async postReview(snapshot: ConnectedSnapshot, payload: ReviewPayload): Promise<void> {
    this.status = "submitting";
    this.message = "Submitting the review to GitHub.";
    let stdout: string;
    try {
      const result = await this.runner.run({
        args: ["api", "--hostname", GITHUB_HOST, "--input", "-", "-X", "POST", "-H", ACCEPT_JSON, apiPath(snapshot, "reviews")],
        stdin: JSON.stringify(payload),
        timeoutMs: this.timeoutMs,
      });
      stdout = result.stdout;
    } catch (error) {
      const failure = asGhCommandError(error instanceof Error ? error : new Error("gh failed"));
      const status = httpStatus(failure);
      // A 4xx answer (except a 408 timeout) proves the write never landed, so
      // the review may be fixed and retried, and GitHub's own reason (for
      // example a self-approval refusal) is safe to show. Everything else
      // (timeout, connection loss, 5xx) is ambiguous: the session goes unknown
      // and is never retried.
      const definite = (status !== null && status >= 400 && status < 500 && status !== 408)
        || /was not found|unknown flag|unknown shorthand|unknown command/i.test(failure.message);
      if (definite) {
        this.status = "ready";
        this.message = "GitHub rejected the review; nothing was submitted.";
        this.previewed = undefined;
        throw classifyGhFailure(failure, "review");
      }
      this.status = "unknown";
      this.message = "The submission did not finish, so GitHub may or may not have created the review. diffninja will not resubmit it; check the pull request, then reconcile.";
      throw new Error(this.message);
    }
    const receipt = readReceipt(stdout, payload);
    if (receipt === null) {
      this.status = "unknown";
      this.message = "GitHub answered the submission with something unreadable, so diffninja cannot tell whether the review was created. Reconcile before doing anything else.";
      throw new Error(this.message);
    }
    this.receipt = receipt;
    this.previewed = undefined;
    this.status = "submitted";
    this.message = `Review submitted to ${snapshot.url}.`;
  }

  /**
   * Resolve an ambiguous write. This never retries and never assumes: it looks
   * for a review that matches this session exactly and was not already present
   * before the attempt, so an identical older review cannot pass as proof.
   */
  private async runReconcile(): Promise<ConnectedState> {
    const snapshot = this.snapshot;
    if (snapshot === undefined) throw new Error("Load a pull request before reconciling.");
    const receipt = this.receipt;
    if (receipt !== undefined) {
      this.message = `A review was already submitted in this session (${receipt.url}).`;
      return this.getState();
    }
    if (this.status !== "unknown") {
      throw new Error("There is nothing to reconcile: no submission is unresolved in this session.");
    }
    const previewed = this.previewed;
    if (previewed === undefined) throw new Error("This session has no prepared review to compare against GitHub.");
    const identity = await this.readIdentity();
    const meta = await this.readMetadata({ owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number, url: snapshot.url });
    const payload = parsePayload(previewed.serialized);
    const found = await this.findMatchingReview(meta, payload, identity);
    if (found === null) {
      this.message = "GitHub shows no review matching this session's attempt, but that is not proof the write failed. diffninja will not resubmit; check the pull request in your browser before doing anything else.";
      return this.getState();
    }
    this.receipt = found;
    this.status = "submitted";
    this.message = `Review found on GitHub at ${found.url}; nothing else will be submitted this session.`;
    return this.getState();
  }

  private async findMatchingReview(meta: PrMetadata, payload: ReviewPayload, identity: ConnectedIdentity): Promise<ConnectedReceipt | null> {
    const list = await this.call([
      "api", "--hostname", GITHUB_HOST, "--paginate", "-H", ACCEPT_JSON, `${apiPath(meta, "reviews")}?per_page=100`,
    ]);
    const wanted = REVIEW_STATE[payload.event];
    for (const entry of decodePages(list.stdout, "review list")) {
      if (!isGhObject(entry)) continue;
      const id = numberField(entry, "id");
      const url = textField(entry, "html_url");
      const state = textField(entry, "state");
      const commitId = textField(entry, "commit_id");
      const login = textField(objectField(entry, "user"), "login");
      const body = textField(entry, "body") ?? "";
      if (id === null || url === null || state === null || commitId === null || login === null) continue;
      // A review that already existed cannot be evidence that this attempt landed.
      if (this.preexistingReviewIds.has(id)) continue;
      if (login.toLowerCase() !== identity.login.toLowerCase() || state !== wanted || commitId !== payload.commit_id) continue;
      if (body.replace(/\r\n/g, "\n") !== payload.body.replace(/\r\n/g, "\n")) continue;
      const comments = await this.readReviewComments(meta, id);
      if (comments !== null && sameCommentSet(comments, payload.comments)) {
        return { id, url, state, commitId };
      }
    }
    return null;
  }

  private async readReviewComments(meta: PrMetadata, reviewId: number): Promise<ReviewComment[] | null> {
    const result = await this.call([
      "api", "--hostname", GITHUB_HOST, "--paginate", "-H", ACCEPT_JSON, `${apiPath(meta, `reviews/${reviewId}/comments`)}?per_page=100`,
    ]);
    const comments: ReviewComment[] = [];
    for (const row of decodePages(result.stdout, "review comment list")) {
      if (!isGhObject(row)) return null;
      const path = textField(row, "path");
      const side = textField(row, "side");
      const body = textField(row, "body");
      const line = numberField(row, "line") ?? numberField(row, "original_line");
      if (path === null || body === null || line === null) return null;
      if (side !== "LEFT" && side !== "RIGHT") return null;
      comments.push({ path, line, side, body });
    }
    return comments;
  }

  /**
   * The only payload a submit can ever send is the previewed one, so both the
   * anchor check and the preview check run before anything is written.
   */
  private buildPayload(input: ReviewInput): ReviewPayload {
    const snapshot = this.snapshot;
    if (this.status !== "ready" || snapshot === undefined || snapshot.unavailableReason !== undefined) {
      throw new Error(this.message ?? "Load a reviewable pull request before preparing a review.");
    }
    if (!isGhText(input.snapshotId) || input.snapshotId !== snapshot.id) {
      throw new Error("This review belongs to a different version of the pull request. Reload it and try again.");
    }
    const event = input.event;
    if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") {
      throw new Error("Choose one review event: COMMENT, APPROVE, or REQUEST_CHANGES.");
    }
    const body = input.body;
    if (!isGhText(body)) throw new Error("Send the review text as a string.");
    if (body.length > MAX_REVIEW_CHARS) throw new Error(`Review text is limited to ${MAX_REVIEW_CHARS} characters.`);
    if (event === "REQUEST_CHANGES" && body.trim() === "") {
      throw new Error("Requesting changes needs review text that says what must change.");
    }
    const rows = input.comments;
    if (!Array.isArray(rows)) throw new Error("Send review comments as an array.");
    if (rows.length > MAX_COMMENTS) throw new Error(`A review carries at most ${MAX_COMMENTS} comments.`);
    const comments = rows.map((comment) => this.validateComment(comment));
    if (body.trim() === "" && comments.length === 0) {
      throw new Error("Add review text or at least one comment before submitting.");
    }
    return { commit_id: snapshot.headSha, event, body, comments };
  }

  /**
   * A comment is accepted only when it names a line of this pull request's diff
   * and carries plain single-line text: the transport casts the request body, so
   * shape is established here rather than assumed.
   */
  private validateComment(comment: ReviewComment | null | undefined): ReviewComment {
    if (comment === null || comment === undefined || Object.getPrototypeOf(comment) !== Object.prototype) {
      throw new Error("Every review comment must be an object with path, line, side, and body.");
    }
    const path = comment.path;
    if (!isGhText(path) || path === "") throw new Error("Every comment needs a file path from the pull request diff.");
    if (CONTROL_CHARACTERS.test(path)) throw new Error(`The comment path ${sanitizeText(path)} contains control characters.`);
    const line = comment.line;
    if (!Number.isSafeInteger(line) || line <= 0) throw new Error(`The comment on ${path} needs a positive diff line number.`);
    const side = comment.side;
    if (side !== "LEFT" && side !== "RIGHT") throw new Error(`The comment on ${path}:${line} needs side LEFT or RIGHT.`);
    const body = comment.body;
    if (!isGhText(body) || body.trim() === "") throw new Error(`The comment on ${path}:${line} needs text.`);
    if (/[\r\n]/.test(body)) throw new Error(`The comment on ${path}:${line} must be a single line of text.`);
    if (CONTROL_CHARACTERS.test(body)) throw new Error(`The comment on ${path}:${line} contains control characters.`);
    if (body.length > MAX_COMMENT_CHARS) throw new Error(`The comment on ${path}:${line} exceeds ${MAX_COMMENT_CHARS} characters.`);
    if (this.anchors.has(anchorKey(path, line, side))) return { path, line, side, body };
    throw new Error(`The comment on ${path}:${line} (${side}) does not match a line of this pull request's diff. Comment on an added line on the right, a deleted line on the left, or a context line.`);
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Why a loaded pull request cannot take a review, or null when it is reviewable. */
function reviewabilityProblem(meta: PrMetadata): string | null {
  if (meta.state === "CLOSED") return "This pull request is closed, so GitHub will not accept a new review.";
  if (meta.state === "MERGED") return "This pull request is merged, so GitHub will not accept a new review.";
  if (meta.state !== "OPEN") return `This pull request is ${meta.state.toLowerCase()}, so GitHub will not accept a new review.`;
  if (meta.headRepository === "" || meta.headRepositoryOwner === "") {
    return "The head repository of this pull request is unavailable, so its diff cannot be reviewed.";
  }
  return null;
}

/** GitHub's review state for each event diffninja can send. */
const REVIEW_STATE = {
  COMMENT: "COMMENTED",
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
} satisfies Record<ReviewEvent, string>;

/**
 * A receipt is only trusted when GitHub echoes the commit this review was
 * submitted for and the state that event produces; anything else stays unknown.
 */
function readReceipt(stdout: string, payload: ReviewPayload): ConnectedReceipt | null {
  const decoded = tryParseJson(stdout);
  if (!isGhObject(decoded)) return null;
  const id = numberField(decoded, "id");
  const url = textField(decoded, "html_url");
  const state = textField(decoded, "state");
  const commitId = textField(decoded, "commit_id");
  if (id === null || url === null || state === null || commitId === null) return null;
  if (commitId !== payload.commit_id || state !== REVIEW_STATE[payload.event]) return null;
  return { id, url, state, commitId };
}

function tryParseJson(text: string): GhJson | null {
  try {
    // SAFETY: JSON.parse produces the JSON data model, which GhJson describes
    // exactly; the caller revalidates every field it reads.
    return JSON.parse(text) as GhJson;
  } catch {
    return null;
  }
}

/** Re-read the payload the caller previewed; the session wrote nothing else. */
function parsePayload(serialized: string): ReviewPayload {
  const decoded = tryParseJson(serialized);
  if (decoded === null || !isGhObject(decoded)) throw new Error("The prepared review could not be read back.");
  const commitId = textField(decoded, "commit_id");
  const event = textField(decoded, "event");
  const body = textField(decoded, "body");
  const rows = decoded["comments"];
  if (commitId === null || body === null || !Array.isArray(rows)) throw new Error("The prepared review could not be read back.");
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new Error("The prepared review could not be read back.");
  const comments: ReviewComment[] = [];
  for (const row of rows) {
    if (!isGhObject(row)) throw new Error("The prepared review could not be read back.");
    const path = textField(row, "path");
    const line = numberField(row, "line");
    const side = textField(row, "side");
    const text = textField(row, "body");
    if (path === null || line === null || text === null || (side !== "LEFT" && side !== "RIGHT")) {
      throw new Error("The prepared review could not be read back.");
    }
    comments.push({ path, line, side, body: text });
  }
  return { commit_id: commitId, event, body, comments };
}

/** Compare two comment multisets ignoring order and CRLF differences. */
function sameCommentSet(left: ReviewComment[], right: ReviewComment[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  for (const comment of left) {
    const index = remaining.findIndex((candidate) => candidate.path === comment.path
      && candidate.line === comment.line
      && candidate.side === comment.side
      && candidate.body.replace(/\r\n/g, "\n") === comment.body.replace(/\r\n/g, "\n"));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}
