/**
 * Report files: the full report as one HTML file, for a person who cannot open
 * the pages on the agent's machine. Off unless the person who configures the
 * server turns it on with DIFFNINJA_REPORT_FILES; the agent cannot turn it on.
 *
 * A report holds source code, so the files are private: a folder that belongs
 * to the user and that no one else can enter, files only the user can read,
 * names that cannot be guessed, never through a symbolic link, never over an
 * existing file. Old files are deleted as new ones are written, and only files
 * whose names diffninja makes are ever deleted.
 *
 * The HTML is the read-only report page, byte for byte, with its content
 * security policy moved into the file itself, so it runs only its own inline
 * script and style and loads nothing from the network.
 *
 * For a pull request with comments that block the merge, a second file holds
 * a draft review in the exact shape GitHub's API takes. It names no event, so
 * GitHub keeps it as a draft only its author sees until they submit it on
 * GitHub. diffninja never sends it: the person runs the command it is for.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pullRequestOf } from "./pull-request-ref.js";
import { reportPolicy } from "./report-pages.js";
import type { ReviewReport } from "./types.js";
import type { ReportFileLocations } from "./report-markdown.js";

/** The variable that turns report files on: `1` for the default folder, or an absolute folder path. */
export const REPORT_FILES_VARIABLE = "DIFFNINJA_REPORT_FILES";
/** Files older than this are deleted when a new report is written. */
export const REPORT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Most reports kept in the folder; the oldest go first. */
export const MAX_REPORT_FILES = 20;

/** Names diffninja gives its files: a UTC time stamp and 64 random bits. */
const FILE_NAME = /^diffninja-(\d{8}T\d{6}Z-[0-9a-f]{16})\.(html|draft-review\.json)$/;

export type ReportFileSetting =
  | { readonly enabled: true; readonly dir: string }
  | { readonly enabled: false; readonly reason: string };

const OFF = `Report files are off. Only the person who configures diffninja can turn them on, by setting ${REPORT_FILES_VARIABLE}=1 (or an absolute folder path) in the environment of the diffninja MCP server, then restarting the agent. Use delivery "inline" meanwhile.`;

/** Whether the person turned report files on, and where they go. */
export function reportFileSetting(env: NodeJS.ProcessEnv = process.env): ReportFileSetting {
  const value = env[REPORT_FILES_VARIABLE]?.trim() ?? "";
  if (value === "" || value === "0") return { enabled: false, reason: OFF };
  if (value === "1") return { enabled: true, dir: join(homedir(), ".cache", "diffninja", "reports") };
  if (isAbsolute(value)) return { enabled: true, dir: resolve(value) };
  return { enabled: false, reason: `${REPORT_FILES_VARIABLE} must be 1 or an absolute folder path; report files stay off until it is. Use delivery "inline" meanwhile.` };
}

/**
 * The folder, created if missing, as its real path. Refused unless it belongs
 * to this user and no one else can read, write, or enter it. Windows has no
 * user ids or mode bits, so nothing is checked there.
 */
function privateFolder(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  const stats = statSync(real);
  if (!stats.isDirectory()) throw new Error(`${dir} is not a folder.`);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    if (stats.uid !== uid) throw new Error(`${dir} belongs to another user (uid ${stats.uid}); report files go only to a folder of your own.`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`other users can open ${dir} (mode ${(stats.mode & 0o777).toString(8)}); run chmod 700 on it, since reports hold source code.`);
    }
  }
  return real;
}

/** Write a new file only this user can read. Refuses an existing name and a symbolic link. */
function writePrivate(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
  } finally {
    closeSync(fd);
  }
}

/**
 * Delete this folder's report files that are past their age, then the oldest
 * past the count, keeping room for one more. Only regular files of this user
 * with a name diffninja makes are touched; anything else in the folder stays.
 */
export function pruneReportFiles(dir: string, now = Date.now()): void {
  const uid = process.getuid?.();
  const reports = new Map<string, { names: string[]; time: number }>();
  for (const name of readdirSync(dir)) {
    const match = FILE_NAME.exec(name);
    if (match === null) continue;
    const stats = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile() || (uid !== undefined && stats.uid !== uid)) continue;
    const entry = reports.get(match[1]) ?? { names: [], time: stats.mtimeMs };
    entry.names.push(name);
    entry.time = Math.min(entry.time, stats.mtimeMs);
    reports.set(match[1], entry);
  }
  const byAge = [...reports.values()].sort((a, b) => a.time - b.time);
  const keep = MAX_REPORT_FILES - 1;
  byAge.forEach((entry, index) => {
    if (now - entry.time <= REPORT_FILE_MAX_AGE_MS && byAge.length - index <= keep) return;
    for (const name of entry.names) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Already gone, or not ours to delete: the next write tries again.
      }
    }
  });
}

/**
 * The report page as a file: its content security policy goes into the page as
 * a meta element, before anything it governs. `frame-ancestors` is left out,
 * since browsers ignore it there.
 */
export function reportFileHtml(page: string): string {
  const policy = reportPolicy(page).split("; ").filter((part) => !part.startsWith("frame-ancestors")).join("; ");
  const head = "<head>\n";
  const at = page.indexOf(head);
  if (at === -1) throw new Error("The report page has no head element; no file was written.");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">\n<meta name="referrer" content="no-referrer">\n`;
  return page.slice(0, at + head.length) + meta + page.slice(at + head.length);
}

/**
 * The draft review GitHub's API takes for this pull request: the comments that
 * block the merge on the commit that was reviewed, and no event, so GitHub
 * keeps it as a draft its author submits on GitHub. Undefined when there is
 * nothing to draft or the commit is unknown.
 */
export function draftReview(report: ReviewReport): string | undefined {
  const pr = pullRequestOf(report);
  const comments = report.agentComments?.comments ?? [];
  if (pr?.headSha === undefined || comments.length === 0) return undefined;
  const body = {
    commit_id: pr.headSha,
    comments: comments.map(({ path, line, side, body: text }) => ({ path, line, side, body: text })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Write the report (and its draft review, if any) to the folder the person chose, and return where. */
export function writeReportFiles(dir: string, page: string, report: ReviewReport, now = new Date()): ReportFileLocations {
  const html = reportFileHtml(page);
  const draft = draftReview(report);
  const folder = privateFolder(dir);
  pruneReportFiles(folder, now.getTime());
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const base = `diffninja-${stamp}-${randomBytes(8).toString("hex")}`;
  const reportPath = join(folder, `${base}.html`);
  writePrivate(reportPath, html);
  if (draft === undefined) return { report: reportPath };
  const draftPath = join(folder, `${base}.draft-review.json`);
  writePrivate(draftPath, draft);
  return { report: reportPath, draftReview: draftPath };
}
