import type { ReviewReport } from "./types.js";

/** The pull request a connected review's report describes. */
export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Always `https://github.com/<owner>/<repo>/pull/<number>`, rebuilt from the checked parts. */
  readonly url: string;
  /** The head commit the review read, when it is a full commit id. */
  readonly headSha?: string;
}

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d{0,15})$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The pull request behind a report, or undefined for a static report. Only a
 * connected review stores a github.com pull request URL; it is checked again
 * here, part by part, so anything built from it (a link, a `gh` command) holds
 * nothing but those checked parts.
 */
export function pullRequestOf(report: ReviewReport): PullRequestRef | undefined {
  const match = PULL_URL.exec(report.pr?.url ?? "");
  if (match === null) return undefined;
  const [, owner, repo, digits] = match;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) return undefined;
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  const head = report.pr?.headRef;
  if (head === undefined || !COMMIT_ID.test(head)) return { owner, repo, number, url };
  return { owner, repo, number, url, headSha: head };
}
