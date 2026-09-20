/**
 * Pull request detection shared by the CLI and the MCP server.
 *
 * Inputs are arbitrary text: a bare URL, a sentence with a link in it, or the
 * value half of `--flag=value`. Detection is content based, so no caller has to
 * know which argument carried the link. Only github.com pull requests count,
 * and free text that never claims one is ignored rather than rejected. Text
 * that does claim a github.com pull request and cannot be read is refused
 * loudly: a mistyped target must never silently become a review of something
 * else. The canonical URL returned always passes the strict parser the
 * connected session itself uses.
 */

const GITHUB_HOST = "github.com";
const GITHUB_WWW_HOST = `www.${GITHUB_HOST}`;
const PR_MARKER = "/pull/";
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** Owner and repository segments GitHub accepts; also excludes `.` and `..`. */
const NAME = /^[A-Za-z0-9._-]+$/;
/** `/owner/repo/pull/123`, then an optional path, query, or fragment. */
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\.(?:diff|patch))?(?=\/|$)/;
/**
 * Characters that end the argument-shaped token around a URL: whitespace,
 * quotes — including the typographic ones a paste carries — brackets, markdown
 * and shell punctuation, and the zero-width formatting characters that ride
 * along with copied links. `#` ends a token too: it can only follow a URL,
 * never sit inside the part that names a pull request. `&` ends one because a
 * glued `&x=1` or `&amp;` is not part of the address a reviewer copied.
 */
const TOKEN_BREAK = /[\s"'`“”‘’«»<>,;|\\=*()[\]{}【】&…–—#\u200b-\u200f\u2060\ufeff]/u;
/** Trailing sentence punctuation, which is never part of the URL. */
const TRAILING = /[\s.,;:!?]+$/u;

const UNSUPPORTED_PROBLEM = "Only https://github.com pull request URLs are supported.";
const CREDENTIALS_PROBLEM = "Remove the username or token from the pull request URL.";
const FORM_PROBLEM = "Enter a pull request URL of the form https://github.com/owner/repo/pull/123.";
const RANGE_PROBLEM = "That pull request number is out of range.";

/** Where the last `scheme://` in `head` starts; 0 when it holds no scheme. */
function schemeStart(head: string): number {
  const scheme = /[A-Za-z][A-Za-z0-9+.-]*:\/\//gu;
  let start = 0;
  for (let match = scheme.exec(head); match !== null; match = scheme.exec(head)) start = match.index;
  return start;
}

/** Every `/pull/`-shaped token in one string; a bare host or repo is not one. */
function pullTokens(text: string): string[] {
  const tokens: string[] = [];
  for (let index = text.indexOf(PR_MARKER); index !== -1; index = text.indexOf(PR_MARKER, index + PR_MARKER.length)) {
    let start = index;
    while (start > 0 && !TOKEN_BREAK.test(text[start - 1])) start--;
    let end = index + PR_MARKER.length;
    while (end < text.length && !TOKEN_BREAK.test(text[end])) end++;
    // Text glued to a link keeps its own words in the token (`PR:https://…`,
    // a page whose path holds the link); the link itself starts at the last
    // scheme before the marker, so glue can never hide a real link.
    start += schemeStart(text.slice(start, index + PR_MARKER.length));
    const token = text.slice(start, end).replace(TRAILING, "");
    if (token !== "") tokens.push(token);
  }
  return tokens;
}

/**
 * The canonical pull request URL one token names, or null when the token is not
 * about github.com at all. A token that is about github.com and is unreadable
 * throws instead, so a mistyped URL is never silently ignored.
 */
function canonicalPullUrl(token: string): string | null {
  let rest = token;
  const scheme = SCHEME.exec(rest);
  if (scheme !== null) {
    if (!/^https?$/iu.test(scheme[1])) {
      if (rest.toLowerCase().includes(GITHUB_HOST)) throw new Error(UNSUPPORTED_PROBLEM);
      return null;
    }
    rest = rest.slice(scheme[0].length);
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }
  const boundary = rest.search(/[/?#]/u);
  const authority = (boundary === -1 ? rest : rest.slice(0, boundary)).toLowerCase();
  const path = boundary === -1 ? "" : rest.slice(boundary);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  // Another host entirely: free text, not a claim about a pull request. A host
  // that merely contains github.com (github.com.evil.com, notgithub.com, a
  // port) is a claim that cannot be honored, so it is refused.
  if (!host.includes(GITHUB_HOST)) return null;
  if (host !== GITHUB_HOST && host !== GITHUB_WWW_HOST) throw new Error(UNSUPPORTED_PROBLEM);
  if (authority !== host) throw new Error(CREDENTIALS_PROBLEM);
  const match = PR_PATH.exec(path.split(/[?#]/u)[0]);
  if (match === null) throw new Error(FORM_PROBLEM);
  const [, owner, repo, digits] = match;
  if (!NAME.test(owner) || !NAME.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") throw new Error(FORM_PROBLEM);
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(RANGE_PROBLEM);
  return `https://${GITHUB_HOST}/${owner}/${repo}/pull/${number}`;
}

/**
 * The one pull request named by any of the given strings, as
 * `https://github.com/owner/repo/pull/123`. Empty strings are ignored. An
 * unreadable github.com pull request URL, or two different pull requests, is an
 * error: neither may be resolved by guessing which one was meant.
 */
export function detectPullRequest(inputs: readonly string[]): string | undefined {
  const found: string[] = [];
  for (const input of inputs) {
    for (const token of pullTokens(input)) {
      const url = canonicalPullUrl(token);
      if (url !== null && !found.some(existing => existing.toLowerCase() === url.toLowerCase())) found.push(url);
    }
  }
  if (found.length === 0) return undefined;
  if (found.length > 1) {
    const shown = found.slice(0, 3).join(", ");
    const extra = found.length > 3 ? `, and ${found.length - 3} more` : "";
    throw new Error(`Found ${found.length} different pull requests (${shown}${extra}). Pass exactly one.`);
  }
  return found[0];
}
