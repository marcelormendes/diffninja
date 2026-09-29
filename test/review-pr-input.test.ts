import { describe, it, expect } from "vitest";
import { detectPullRequest } from "../src/review/pr-input.js";

const CANONICAL = "https://github.com/octocat/hello/pull/7";

describe("pull request detection", () => {
  it("accepts the URL forms a reviewer actually pastes", () => {
    for (const input of [
      CANONICAL,
      "https://www.github.com/octocat/hello/pull/7",
      "http://github.com/octocat/hello/pull/7",
      "https://GitHub.com/octocat/hello/pull/7",
      "github.com/octocat/hello/pull/7",
      "//github.com/octocat/hello/pull/7",
      "https://github.com/octocat/hello/pull/7/",
      "https://github.com/octocat/hello/pull/7/files",
      "https://github.com/octocat/hello/pull/7/commits?diff=split",
      "https://github.com/octocat/hello/pull/7#discussion_r123",
      "https://github.com/octocat/hello/pull/7.diff",
      "https://github.com/octocat/hello/pull/7.patch",
      "https://github.com/octocat/hello/pull/007",
    ]) {
      expect(detectPullRequest([input]), input).toBe(CANONICAL);
    }
  });

  it("finds the URL anywhere in the arguments, including inside free text", () => {
    expect(detectPullRequest(["--pr=" + CANONICAL])).toBe(CANONICAL);
    expect(detectPullRequest(["--pull-request", CANONICAL])).toBe(CANONICAL);
    expect(detectPullRequest(["--diff", "change.patch", CANONICAL, "--mock"])).toBe(CANONICAL);
    expect(detectPullRequest(["please review these changes", "See " + CANONICAL + " before tomorrow."])).toBe(CANONICAL);
    expect(detectPullRequest(["[the PR](" + CANONICAL + ")"])).toBe(CANONICAL);
    expect(detectPullRequest(["`" + CANONICAL + "` is the one"])).toBe(CANONICAL);
    expect(detectPullRequest([CANONICAL + ",", "and " + CANONICAL + "/files"])).toBe(CANONICAL);
    expect(detectPullRequest([CANONICAL, "https://github.com/OctoCat/Hello/pull/7"])).toBe(CANONICAL);
  });

  it("sees the link through the characters a paste carries with it", () => {
    for (const input of [
      `“${CANONICAL}”`, // typographic quotes
      `【${CANONICAL}】`, // CJK brackets
      `${CANONICAL}\u200b`, // zero-width space
      `\u200b${CANONICAL}`,
      `${CANONICAL}\u200e`, // left-to-right mark
      `${CANONICAL}\u2060`, // word joiner
      `${CANONICAL}\ufeff`, // byte order mark
      `see#${CANONICAL}`, // glued onto a heading marker
      `PR:${CANONICAL}`, // glued onto a label
      `${CANONICAL}&x=1`, // query glued on without its `?`
      `${CANONICAL}—see it`, // em dash instead of a space
      `${CANONICAL}…`, // ellipsis instead of three periods
      `https://evil.test/redirect/https://github.com/octocat/hello/pull/7`,
    ]) {
      expect(detectPullRequest([input]), JSON.stringify(input)).toBe(CANONICAL);
    }
  });

  it("reports no pull request for text that never claims one", () => {
    expect(detectPullRequest([])).toBeUndefined();
    expect(detectPullRequest(["", "   "])).toBeUndefined();
    expect(detectPullRequest(["https://github.com/octocat/hello"])).toBeUndefined();
    expect(detectPullRequest(["https://github.com/octocat/hello/tree/main"])).toBeUndefined();
    expect(detectPullRequest(["https://api.github.com/repos/octocat/hello/pulls/7"])).toBeUndefined();
    expect(detectPullRequest(["https://gitlab.com/octocat/hello/pull/7"])).toBeUndefined();
    expect(detectPullRequest(["git@github.com:octocat/hello.git"])).toBeUndefined();
    expect(detectPullRequest(["--diff", "change.patch", "--mock"])).toBeUndefined();
  });

  it("names what is wrong with a claimed link it cannot read", () => {
    const cases: Array<[string, RegExp]> = [
      ["https://user:token@github.com/octocat/hello/pull/7", /username|token/],
      ["https://token@github.com/octocat/hello/pull/7", /username|token/],
      ["https://github.com.evil.test/octocat/hello/pull/7", /github\.com/],
      ["https://notgithub.com/octocat/hello/pull/7", /github\.com/],
      ["https://github.com:8443/octocat/hello/pull/7", /github\.com/],
      ["git://github.com/octocat/hello/pull/7", /https/],
      ["https://github.com/octocat/pull/7", /pull request URL/],
      ["https://github.com/octocat/hello/pull/", /pull request URL/],
      ["https://github.com/octocat/hello/pull/7abc", /pull request URL/],
      ["https://github.com/octocat/hello/pull/7.5", /pull request URL/],
      ["https://github.com/octocat/hello/pull/new/main", /pull request URL/],
      ["https://github.com/octo%63at/hello/pull/7", /pull request URL/],
      ["https://github.com/octocat/hello/pull/0", /number.*range/],
      ["https://github.com/octocat/hello/pull/99999999999999999999", /number.*range/],
    ];
    for (const [input, expected] of cases) {
      expect(() => detectPullRequest([input]), input).toThrow(expected);
    }
  });

  it("refuses two different pull requests rather than choosing one", () => {
    expect(() => detectPullRequest([CANONICAL, "https://github.com/octocat/hello/pull/8"])).toThrow(/different pull requests/);
    expect(() => detectPullRequest(["--pr=" + CANONICAL, "https://github.com/other/repo/pull/1"])).toThrow(/different pull requests/);
  });

  it("text that is one long run of /pull/ is read in bounded time (it took 14.6 s for 96,000 characters)", () => {
    for (const hostile of ["/pull/".repeat(200_000), "a/pull/".repeat(150_000), `x${"/pull/9".repeat(100_000)}`]) {
      const started = performance.now();
      try { detectPullRequest([hostile]); } catch { /* a refusal is fine; time is the point */ }
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it("a real link is still found at the edges of a long message", () => {
    const link = "https://github.com/acme/widgets/pull/42";
    expect(detectPullRequest([`${"word ".repeat(50_000)}${link}`])).toBe(link);
    expect(detectPullRequest([`${link} ${"word ".repeat(50_000)}`])).toBe(link);
    expect(detectPullRequest([`PR:${link}/files`])).toBe(link);
    expect(detectPullRequest([`${"x ".repeat(250)}${link}`])).toBe(link);
  });
});
