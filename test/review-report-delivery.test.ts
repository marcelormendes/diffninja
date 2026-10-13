import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Lexer, type Token, type Tokens } from "marked";
import { afterEach, describe, expect, test } from "vitest";
import { renderReview } from "../src/review/html.js";
import { pullRequestOf } from "../src/review/pull-request-ref.js";
import { draftReviewCommand, mdCode, mdProse, renderReportMarkdown, shellQuote } from "../src/review/report-markdown.js";
import { MAX_REPORT_FILES, REPORT_FILE_MAX_AGE_MS, draftReview, pruneReportFiles, reportFileHtml, reportFileSetting, writeReportFiles } from "../src/review/report-files.js";
import { reportPolicy } from "../src/review/report-pages.js";
import { reviewDiff } from "../src/review/service.js";
import type { ReviewReport } from "../src/review/types.js";

const patch = readFileSync(resolve("examples/review/checkout.patch"), "utf8");
const HEAD = "a".repeat(40);
const HOSTILE = "![x](https://evil.example/p.png?d=1) <img src=x onerror=alert(1)> [click](javascript:alert(1)) www.evil.example **bold** `tick` | a | b | &#x26; $$x$$ \u202Eevil";

const folders: string[] = [];
afterEach(() => {
  while (folders.length > 0) rmSync(folders.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffninja-report-files-"));
  folders.push(dir);
  return dir;
}

/** A connected review's report as finish_review leaves it: summary, one blocker, rules. */
async function connectedReport(overrides: { title?: string; comment?: string; path?: string } = {}): Promise<ReviewReport> {
  const report = await reviewDiff({ diff: patch, source: "https://github.com/acme/shop/pull/7" }, {
    pr: { title: overrides.title ?? "Raise the checkout limit", body: "", url: "https://github.com/acme/shop/pull/7", baseRef: "b".repeat(40), headRef: HEAD },
  });
  const item = report.items[0];
  const added = item.diff.split("\n").slice(1).findIndex((line) => line.startsWith("+"));
  expect(added).toBeGreaterThanOrEqual(0);
  report.agentSummary = { text: overrides.comment ?? "Checkout compares against the configured limit.", summarizedBy: "test-agent 1.0" };
  report.agentComments = {
    comments: [{
      path: overrides.path ?? item.file,
      line: item.newStart + item.diff.split("\n").slice(1, added + 1).filter((line) => !line.startsWith("-")).length,
      side: "RIGHT",
      body: overrides.comment ?? "This lets an empty cart through.",
      scenario: "A cart with zero items reaches the payment step and is charged.",
      evidence: "traced",
      unlessTrue: "the cart page blocks empty carts first.",
    }],
    suggestedBy: "test-agent 1.0",
    suggestedAt: new Date(0).toISOString(),
  };
  report.agentExplanation = {
    functions: [],
    processes: [],
    rules: [{ text: overrides.comment ?? "An order over the limit is refused.", change: "added" }],
    explainedBy: "test-agent 1.0",
    explainedAt: new Date(0).toISOString(),
  };
  return report;
}

/** Every link, image, and HTML token Markdown would build from this text, at any depth. */
function liveTokens(markdown: string): Array<{ type: string; target: string }> {
  const found: Array<{ type: string; target: string }> = [];
  const walk = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      // SAFETY: each cast follows the check of token.type that names that token's kind.
      const target = token.type === "link" ? (token as Tokens.Link).href : token.type === "image" ? (token as Tokens.Image).href : token.type === "html" ? (token as Tokens.HTML).raw : undefined;
      if (target !== undefined) found.push({ type: token.type, target });
      for (const key of ["tokens", "items"] as const) {
        // SAFETY: block and inline tokens keep their children in tokens, lists in items; Array.isArray checks it.
        const children = (token as { tokens?: Token[]; items?: Token[] })[key];
        if (Array.isArray(children)) walk(children);
      }
    }
  };
  walk(new Lexer({ gfm: true }).lex(markdown));
  return found;
}

describe("Markdown summary", () => {
  test("a code span holds any text literally, whatever backticks or spaces it has", () => {
    for (const text of ["plain", "a`b", "``x``", "`lead", "trail`", " both ", "x\ny", "a\u200Bb"]) {
      const tokens = new Lexer().inlineTokens(mdCode(text));
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe("codespan");
    }
    expect(mdCode("")).toBe("(empty)");
    expect(mdCode("a\u202Eb")).toContain("⟦U+202E⟧");
    expect(mdCode("x".repeat(500))).toHaveLength(202);
  });

  test("the agent's prose builds no link, image, tag, or emphasis, and web addresses become code", () => {
    const shown = mdProse(HOSTILE);
    expect(liveTokens(shown)).toEqual([]);
    const inline = new Lexer({ gfm: true }).inlineTokens(shown);
    expect(inline.some((token) => token.type === "strong" || token.type === "em")).toBe(false);
    // SAFETY: filtered to codespan tokens, which carry text.
    expect(inline.filter((token) => token.type === "codespan").map((token) => (token as Tokens.Codespan).text)).toEqual([
      "https://evil.example/p.png?d=1)",
      "www.evil.example",
    ]);
    expect(shown).toContain("⟦U+202E⟧");
    expect(shown).not.toContain("\n");
  });

  test("hostile title, path, and agent text yield no live link, image, or HTML; the only link is the pull request's own page", async () => {
    const report = await connectedReport({ title: HOSTILE, comment: HOSTILE });
    report.items[0].file = HOSTILE;
    const markdown = renderReportMarkdown(report);
    expect(liveTokens(markdown)).toEqual([{ type: "link", target: "https://github.com/acme/shop/pull/7/files" }]);
    expect(markdown).not.toContain("\u202E");
  });

  test("a static report has no submit section and no comments", async () => {
    const report = await reviewDiff({ diff: patch, source: "MCP inline diff" });
    const markdown = renderReportMarkdown(report);
    expect(markdown).toMatch(/^## diffninja review: /);
    expect(markdown).not.toMatch(/github\.com|Comments that block|gh api/);
    expect(liveTokens(markdown)).toEqual([]);
  });

  test("a pull request summary names the goal, each blocker with its proof, the reading order, the rules, and how to finish on GitHub", async () => {
    const report = await connectedReport();
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain("## diffninja review of `acme/shop#7`: `Raise the checkout limit`");
    expect(markdown).toContain("**Goal**, as test-agent 1.0 read");
    expect(markdown).toContain("This lets an empty cart through.");
    expect(markdown).toContain("Why it blocks (traced by reading): A cart with zero items");
    expect(markdown).toContain("Not a problem if: the cart page blocks empty carts first.");
    expect(markdown).toContain("**Read the hunks in this order**");
    expect(markdown).toContain("- added: An order over the limit is refused.");
    expect(markdown).toContain("<https://github.com/acme/shop/pull/7/files>");
    expect(markdown).not.toContain("gh api");
    expect(Buffer.byteLength(markdown)).toBeLessThan(16 * 1024);
  });

  test("with files, the summary names the report and the command that drafts the review, quoted for the shell", async () => {
    const report = await connectedReport();
    const markdown = renderReportMarkdown(report, { files: { report: "/home/me/r.html", draftReview: "/home/o'neil/d.json" } });
    expect(markdown).toContain("```\n/home/me/r.html\n```");
    expect(markdown).toContain(draftReviewCommand("acme", "shop", 7, "/home/o'neil/d.json"));
    expect(shellQuote("/home/o'neil/d.json")).toBe("'/home/o'\\''neil/d.json'");
    expect(markdown).toContain("Only you can see the draft");
  });

  test("a pull request link that is not a canonical github.com one is treated as no pull request", async () => {
    const report = await connectedReport();
    for (const url of ["https://github.com/acme/shop/pull/7/files", "http://github.com/acme/shop/pull/7", "https://github.com/a b/shop/pull/7", "https://github.com/../shop/pull/7", "https://evil.example/acme/shop/pull/7"]) {
      report.pr = { ...report.pr!, url };
      expect(pullRequestOf(report)).toBeUndefined();
    }
    report.pr = { ...report.pr!, url: "https://github.com/acme/shop/pull/7", headRef: "main" };
    expect(pullRequestOf(report)).toEqual({ owner: "acme", repo: "shop", number: 7, url: "https://github.com/acme/shop/pull/7" });
  });
});

describe("report page", () => {
  test("a pull request's report shows the goal and each blocker with its proof; a static one shows no comments", async () => {
    const report = await connectedReport({ comment: "<b>not bold</b>" });
    const html = renderReview(report);
    expect(html).toContain('class="agent-reading"');
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).not.toContain("<b>not bold</b>");
    expect(html).toContain("Why it blocks</strong> (traced by reading)");
    report.pr = { ...report.pr!, url: undefined };
    expect(renderReview(report)).not.toContain("Comments that block the merge");
  });
});

describe("report files", () => {
  test("they are off unless the person sets DIFFNINJA_REPORT_FILES to 1 or an absolute folder", () => {
    expect(reportFileSetting({})).toMatchObject({ enabled: false, reason: expect.stringContaining("DIFFNINJA_REPORT_FILES=1") });
    expect(reportFileSetting({ DIFFNINJA_REPORT_FILES: "0" }).enabled).toBe(false);
    expect(reportFileSetting({ DIFFNINJA_REPORT_FILES: "yes" })).toMatchObject({ enabled: false, reason: expect.stringContaining("must be 1 or an absolute folder") });
    expect(reportFileSetting({ DIFFNINJA_REPORT_FILES: "reports" }).enabled).toBe(false);
    expect(reportFileSetting({ DIFFNINJA_REPORT_FILES: "1" })).toMatchObject({ enabled: true, dir: expect.stringMatching(/\.cache[/\\]diffninja[/\\]reports$/) });
    expect(reportFileSetting({ DIFFNINJA_REPORT_FILES: "/srv/reports/../r" })).toEqual({ enabled: true, dir: resolve("/srv/r") });
  });

  test("the file is the report page with its security policy inside, before anything it governs", async () => {
    const page = renderReview(await connectedReport());
    const file = reportFileHtml(page);
    const policy = reportPolicy(page).replace("; frame-ancestors 'none'", "");
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    expect(file.indexOf(meta)).toBeGreaterThan(0);
    expect(file.indexOf(meta)).toBeLessThan(file.indexOf("<style>"));
    expect(policy).toMatch(/^default-src 'none'; script-src 'sha256-/);
    expect(policy).not.toContain("frame-ancestors");
    expect(file).toContain('<meta name="referrer" content="no-referrer">');
    // The same inline blocks, so the hashes still match.
    expect(reportPolicy(file)).toBe(reportPolicy(page));
    expect(() => reportFileHtml("<html><body></body></html>")).toThrow(/no head element/);
  });

  test("the draft review names no event, so GitHub keeps it a draft, and carries only what GitHub posts", async () => {
    const report = await connectedReport();
    const draft = JSON.parse(draftReview(report)!);
    expect(Object.keys(draft).sort()).toEqual(["comments", "commit_id"]);
    expect(draft.commit_id).toBe(HEAD);
    expect(Object.keys(draft.comments[0]).sort()).toEqual(["body", "line", "path", "side"]);
    report.agentComments!.comments = [];
    expect(draftReview(report)).toBeUndefined();
    const unknownHead = await connectedReport();
    unknownHead.pr = { ...unknownHead.pr!, headRef: "main" };
    expect(draftReview(unknownHead)).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("files go to a private folder, readable only by this user, under names that cannot be guessed", async () => {
    const dir = join(scratch(), "nested", "reports");
    const report = await connectedReport();
    const written = writeReportFiles(dir, renderReview(report), report, new Date("2026-10-13T12:34:56.789Z"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(written.report).toMatch(/[/\\]diffninja-20261013T123456Z-[0-9a-f]{16}\.html$/);
    expect(written.draftReview).toBe(written.report.replace(/\.html$/, ".draft-review.json"));
    for (const file of [written.report, written.draftReview!]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(written.report, "utf8")).toContain("Content-Security-Policy");
    const again = writeReportFiles(dir, renderReview(report), report, new Date("2026-10-13T12:34:56.789Z"));
    expect(again.report).not.toBe(written.report);
  });

  test.skipIf(process.platform === "win32")("a folder other users can open is refused, and so is a link to one", async () => {
    const report = await connectedReport();
    const open = join(scratch(), "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => writeReportFiles(open, renderReview(report), report)).toThrow(/other users can open .* chmod 700/);
    const link = join(scratch(), "link");
    symlinkSync(open, link);
    expect(() => writeReportFiles(link, renderReview(report), report)).toThrow(/other users can open/);
    expect(readdirSync(open)).toEqual([]);
    const plain = join(scratch(), "plain-file");
    writeFileSync(plain, "x");
    expect(() => writeReportFiles(plain, renderReview(report), report)).toThrow();
  });

  test.skipIf(process.platform === "win32")("old and surplus report files are deleted, and nothing else in the folder is touched", () => {
    const dir = scratch();
    chmodSync(dir, 0o700);
    const now = Date.parse("2026-10-13T12:00:00Z");
    const name = (index: number) => `diffninja-20261013T1200${String(index).padStart(2, "0")}Z-${index.toString(16).padStart(16, "0")}`;
    for (let index = 0; index < MAX_REPORT_FILES + 5; index += 1) {
      for (const suffix of [".html", ".draft-review.json"]) {
        const path = join(dir, name(index) + suffix);
        writeFileSync(path, "x");
        const seconds = (now - (MAX_REPORT_FILES + 5 - index) * 1000) / 1000;
        utimesSync(path, seconds, seconds);
      }
    }
    const stale = join(dir, `diffninja-20261001T000000Z-${"f".repeat(16)}.html`);
    writeFileSync(stale, "x");
    utimesSync(stale, (now - REPORT_FILE_MAX_AGE_MS - 1000) / 1000, (now - REPORT_FILE_MAX_AGE_MS - 1000) / 1000);
    const others = ["notes.html", "diffninja-latest.html", `diffninja-20261013T120000Z-${"0".repeat(16)}.txt`];
    for (const other of others) writeFileSync(join(dir, other), "keep");
    const target = join(scratch(), "target.html");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, `diffninja-20261013T110000Z-${"e".repeat(16)}.html`));

    pruneReportFiles(dir, now);
    const left = readdirSync(dir);
    const reports = left.filter((file) => file.endsWith(".html") && file.startsWith("diffninja-2026") && !lstatSync(join(dir, file)).isSymbolicLink());
    expect(reports).toHaveLength(MAX_REPORT_FILES - 1);
    expect(reports).toContain(`${name(MAX_REPORT_FILES + 4)}.html`);
    expect(reports).not.toContain(`${name(0)}.html`);
    expect(existsSync(stale)).toBe(false);
    for (const other of others) expect(left).toContain(other);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});
