import { createHash } from "node:crypto";
import { request } from "node:http";
import { describe, expect, test } from "vitest";
import { MAX_REPORT_PAGES, MAX_SUGGESTED_COMMENTS, MAX_SUMMARY_CHARS, MAX_SUMMARY_WORDS, ReportPages, reportPolicy } from "../src/review/report-pages.js";
import type { ReviewReport } from "../src/review/types.js";

/** The proof a blocker carries next to its body. */
const PROOF = {
  scenario: "A caller passing 0 gets the old value back, so the new default never applies.",
  evidence: "ran" as const,
  unlessTrue: "no caller ever passes 0.",
};

const PAGE = "<!doctype html><style>body{color:red}</style><p>report</p><script>document.title='x'</script>";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Plain loopback HTTP, with an optional forged Host header. */
function get(url: string, options: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "GET",
        headers: options.host === undefined ? {} : { host: options.host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("report pages", () => {
  test("serves the report byte for byte behind a hash-pinned CSP", async () => {
    const pages = new ReportPages();
    try {
      const url = await pages.add(PAGE);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report\/[a-f0-9]{64}$/);
      const reply = await get(url);
      expect(reply.status).toBe(200);
      expect(reply.body).toBe(PAGE);
      const policy = String(reply.headers["content-security-policy"]);
      expect(policy).toContain(`script-src ${sha("document.title='x'")}`);
      expect(policy).toContain(`style-src ${sha("body{color:red}")}`);
      expect(policy).toContain("default-src 'none'");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
    } finally {
      await pages.close();
    }
  });

  test("refuses a foreign Host, a write, and an unknown or malformed token", async () => {
    const pages = new ReportPages();
    try {
      const url = await pages.add(PAGE);
      expect((await get(url, { host: "evil.example" })).status).toBe(403);
      expect((await get(url, { method: "POST" })).status).toBe(405);
      const origin = new URL(url).origin;
      expect((await get(`${origin}/report/${"0".repeat(64)}`)).status).toBe(404);
      expect((await get(`${origin}/report/../etc/passwd`)).status).toBe(404);
      expect((await get(`${origin}/`)).status).toBe(404);
    } finally {
      await pages.close();
    }
  });

  test("keeps a bounded number of pages, dropping the oldest", async () => {
    const pages = new ReportPages();
    try {
      const urls: string[] = [];
      for (let index = 0; index <= MAX_REPORT_PAGES; index++) urls.push(await pages.add(`<p>${index}</p>`));
      expect((await get(urls[0])).status).toBe(404);
      expect((await get(urls[1])).body).toBe("<p>1</p>");
      expect((await get(urls.at(-1)!)).body).toBe(`<p>${MAX_REPORT_PAGES}</p>`);
    } finally {
      await pages.close();
    }
  });

  test("stops listening on close and refuses to serve afterwards", async () => {
    const pages = new ReportPages();
    const url = await pages.add(PAGE);
    await pages.close();
    await expect(get(url)).rejects.toThrow();
    await expect(pages.add(PAGE)).rejects.toThrow(/shutting down/);
  });

  test("a page without inline blocks allows no script or style", () => {
    expect(reportPolicy("<p>plain</p>")).toContain("script-src 'none'; style-src 'none'");
  });
});

/** The least report finish() can be called on: one hunk, one question. */
function report(): ReviewReport {
  return {
    title: "t", source: "s", createdAt: "2026-09-24T00:00:00Z",
    items: [{
      id: "hunk-1", file: "src/a.ts", header: "@@ -1 +1 @@", added: 1, removed: 1, oldStart: 1, newStart: 1,
      diff: "@@ -1 +1 @@\n-old()\n+new()\n", status: "attention", priority: 50, reasons: [],
    }],
    callFlow: [], callFlows: [], callFlowAvailability: "no-changes", warnings: [],
    questions: [{ id: "q1", kind: "behaviorChange", unitIds: ["hunk-1"], text: "Does this change behavior?", options: ["changes-behavior", "no-behavior-change", "cannot-tell"] }],
  };
}

describe("finish_review goal summary", () => {
  test("refuses a malformed paragraph without keeping the reading it came with", async () => {
    const pages = new ReportPages();
    try {
      const review = report();
      const { reviewId } = await pages.publish(review);
      const reading = { answers: [{ questionId: "q1", choice: "no-behavior-change" }], order: ["hunk-1"], comments: [] };
      const malformed = [
        "",
        "   ",
        "Two lines\nof text",
        "A tab\there",
        "x".repeat(MAX_SUMMARY_CHARS + 1),
        Array.from({ length: MAX_SUMMARY_WORDS + 1 }, () => "word").join(" "),
        "# Goal",
        "- a list item",
        "**bold goal**",
        "`code` in prose",
        "<b>tag</b>",
      ];
      for (const summary of malformed) {
        expect(() => pages.finish(reviewId, { ...reading, summary }, "agent 1.0")).toThrow(/summary/);
        // Nothing of the refused call was kept: not the summary, and not the
        // answers, order, or comments that arrived with it either.
        expect(review.agentSummary).toBeUndefined();
        expect(review.agentOrder).toBeUndefined();
        expect(review.agentComments).toBeUndefined();
        expect(review.questions[0].answer).toBeUndefined();
        expect(pages.isFinished(reviewId)).toBe(false);
      }

      // A plain paragraph is trimmed, kept attributed, and counted in characters.
      const kept = "Charge the limit the config states instead of a fixed ten. The author does not say why the warning log went away.";
      const done = pages.finish(reviewId, { ...reading, summary: `  ${kept}  ` }, "agent 1.0");
      expect(done).toMatchObject({ answered: 1, ordered: 1, suggested: 0, summarized: kept.length });
      expect(review.agentSummary).toEqual({ text: kept, summarizedBy: "agent 1.0" });
      expect(pages.isFinished(reviewId)).toBe(true);

      // A later finish replaces the paragraph; omitting it keeps the previous one.
      const updated = "Charge the limit the config states instead of a fixed ten.";
      expect(pages.finish(reviewId, { ...reading, summary: updated }, "agent 1.0").summarized).toBe(updated.length);
      expect(review.agentSummary?.text).toBe(updated);
      expect(pages.finish(reviewId, reading, "agent 1.0").summarized).toBe(0);
      expect(review.agentSummary?.text).toBe(updated);
    } finally {
      await pages.close();
    }
  });
});

describe("suggested comments on a file whose name holds a hidden character", () => {
  /** One hunk per file, each adding line 1. */
  function reportOf(files: readonly string[]): ReviewReport {
    return {
      ...report(),
      items: files.map((file, index) => ({
        id: `hunk-${index + 1}`, file, header: "@@ -1 +1 @@", added: 1, removed: 1, oldStart: 1, newStart: 1,
        diff: "@@ -1 +1 @@\n-old()\n+new()\n", status: "attention" as const, priority: 50, reasons: [],
      })),
      questions: [],
    };
  }
  const comment = (path: string) => ({ path, line: 1, side: "RIGHT" as const, body: "Should this stay?", ...PROOF });

  test("take the path as the agent was shown it and keep the file's own path, so the comment anchors to the real line", async () => {
    const pages = new ReportPages();
    try {
      const review = reportOf(["lib\u200B.ts"]);
      const { reviewId } = await pages.publish(review);
      expect(pages.suggestComments(reviewId, [comment("lib⟦U+200B⟧.ts")], "agent 1.0").suggested).toBe(1);
      expect(review.agentComments?.comments.map((kept) => kept.path)).toEqual(["lib\u200B.ts"]);
      // The file's own path still names it.
      pages.suggestComments(reviewId, [comment("lib\u200B.ts")], "agent 1.0");
      expect(review.agentComments?.comments.map((kept) => kept.path)).toEqual(["lib\u200B.ts"]);
    } finally {
      await pages.close();
    }
  });

  test("refuse a path two different files are shown as, keeping the previous suggestions", async () => {
    const pages = new ReportPages();
    try {
      // One file is literally named with the marker text the other is shown as.
      const review = reportOf(["lib\u200B.ts", "lib⟦U+200B⟧.ts"]);
      const { reviewId } = await pages.publish(review);
      expect(() => pages.suggestComments(reviewId, [comment("lib⟦U+200B⟧.ts")], "agent 1.0")).toThrow(/more than one file/);
      expect(review.agentComments).toBeUndefined();
    } finally {
      await pages.close();
    }
  });
});

describe("suggested comments are blockers, each with its proof", () => {
  /** keep() is context on both sides, old() is removed, a() to f() are added, last() is context: 7 changed lines. */
  const DIFF = "@@ -1,3 +1,8 @@\n keep()\n-old()\n+a()\n+b()\n+c()\n+d()\n+e()\n+f()\n last()\n";
  function blockerReport(): ReviewReport {
    return {
      ...report(),
      items: [{ id: "hunk-1", file: "src/a.ts", header: "@@ -1,3 +1,8 @@", added: 6, removed: 1, oldStart: 1, newStart: 1, diff: DIFF, status: "attention", priority: 50, reasons: [] }],
      questions: [],
    };
  }
  const at = (line: number, side: "LEFT" | "RIGHT" = "RIGHT") => ({ path: "src/a.ts", line, side, body: `Check line ${line}.`, ...PROOF });
  /** Six anchors on added lines. */
  const added = [2, 3, 4, 5, 6, 7].map((line) => at(line));

  test("keeps a blocker with its proof trimmed and no severity, attributed to the agent", async () => {
    const pages = new ReportPages();
    try {
      const review = blockerReport();
      const { reviewId } = await pages.publish(review);
      const padded = { ...at(3), body: "  Check line 3.  ", scenario: `  ${PROOF.scenario}  `, unlessTrue: `  ${PROOF.unlessTrue}  ` };
      expect(pages.suggestComments(reviewId, [at(2, "LEFT"), padded], "agent 1.0")).toEqual({ reviewId, suggested: 2 });
      expect(review.agentComments).toEqual({
        comments: [at(2, "LEFT"), at(3)],
        suggestedBy: "agent 1.0",
        suggestedAt: expect.any(String),
      });
      expect(review.agentComments?.comments.some((kept) => "severity" in kept)).toBe(false);
    } finally {
      await pages.close();
    }
  });

  test("refuses a sixth comment and says why, keeping the previous set", async () => {
    const pages = new ReportPages();
    try {
      const review = blockerReport();
      const { reviewId } = await pages.publish(review);
      expect(MAX_SUGGESTED_COMMENTS).toBe(5);
      pages.suggestComments(reviewId, added.slice(0, 5), "agent 1.0");
      const kept = review.agentComments;
      expect(kept?.comments).toHaveLength(5);
      expect(() => pages.suggestComments(reviewId, added, "agent 2.0")).toThrow(/at most 5 are allowed\. A review rarely has more than 5 real blockers\. Check each one again and drop every one you cannot show fails\./);
      expect(review.agentComments).toBe(kept);
    } finally {
      await pages.close();
    }
  });

  test("refuses an unchanged line on either side, and a line outside the diff with its own message", async () => {
    const pages = new ReportPages();
    try {
      const review = blockerReport();
      const { reviewId } = await pages.publish(review);
      pages.suggestComments(reviewId, [at(2, "LEFT")], "agent 1.0");
      const kept = review.agentComments;
      for (const [line, side] of [[1, "RIGHT"], [8, "RIGHT"], [1, "LEFT"], [3, "LEFT"]] as const) {
        expect(() => pages.suggestComments(reviewId, [at(2), at(line, side)], "agent 2.0"), `${side} ${line}`)
          .toThrow(`comments[1] names src/a.ts:${line} (${side}), an unchanged line. Unchanged code cannot block this merge. Anchor the comment on the nearest line this pull request adds or removes and say the rest in the body, or leave it out.`);
        expect(review.agentComments).toBe(kept);
      }
      expect(() => pages.suggestComments(reviewId, [at(99)], "agent 2.0")).toThrow(/which is not a line of this review's diff/);
      // The nearest changed line is fine, on either side.
      expect(() => pages.suggestComments(reviewId, [at(2), at(2, "LEFT")], "agent 2.0")).not.toThrow();
    } finally {
      await pages.close();
    }
  });

  test("checks the proof's length on its trimmed text and keeps it to one line without control characters", async () => {
    const pages = new ReportPages();
    try {
      const review = blockerReport();
      const { reviewId } = await pages.publish(review);
      const proof = (fields: Partial<typeof PROOF>) => [{ ...at(2), ...fields }];
      const refused: Array<[Partial<typeof PROOF>, RegExp]> = [
        [{ scenario: "x".repeat(19) }, /comments\[0\]\.scenario is shorter than 20 characters/],
        [{ scenario: ` ${"x".repeat(19)} ` }, /comments\[0\]\.scenario is shorter than 20 characters/],
        [{ scenario: "x".repeat(401) }, /comments\[0\]\.scenario is longer than 400 characters/],
        [{ unlessTrue: "x".repeat(9) }, /comments\[0\]\.unlessTrue is shorter than 10 characters/],
        [{ unlessTrue: "x".repeat(301) }, /comments\[0\]\.unlessTrue is longer than 300 characters/],
        [{ scenario: `${"x".repeat(20)}\nmore` }, /comments\[0\]\.scenario must be one line of text/],
        [{ unlessTrue: `${"x".repeat(20)}\r` + "y" }, /comments\[0\]\.unlessTrue must be one line of text/],
        [{ scenario: `${"x".repeat(20)}\t` + "y" }, /comments\[0\]\.scenario contains control characters/],
        [{ unlessTrue: `${"x".repeat(20)}\u0007` }, /comments\[0\]\.unlessTrue contains control characters/],
      ];
      for (const [fields, expected] of refused) {
        expect(() => pages.suggestComments(reviewId, proof(fields), "agent 1.0"), JSON.stringify(fields)).toThrow(expected);
        expect(review.agentComments).toBeUndefined();
      }
      // The bounds are inclusive, and only the body has to read like a reviewer.
      const edge = { scenario: "x".repeat(20), unlessTrue: "y".repeat(10) };
      expect(() => pages.suggestComments(reviewId, proof(edge), "agent 1.0")).not.toThrow();
      const longest = { scenario: "x".repeat(400), unlessTrue: "y".repeat(300) };
      expect(() => pages.suggestComments(reviewId, proof(longest), "agent 1.0")).not.toThrow();
      const labelled = { scenario: "Finding 1: the docs say 0 is valid.", unlessTrue: "- the docs are out of date." };
      expect(() => pages.suggestComments(reviewId, proof(labelled), "agent 1.0")).not.toThrow();
      expect(review.agentComments?.comments[0]).toMatchObject(labelled);
      expect(() => pages.suggestComments(reviewId, [{ ...at(2), body: "Finding 1: the docs say 0 is valid." }], "agent 1.0")).toThrow(/comments\[0\]\.body reads like a report/);
    } finally {
      await pages.close();
    }
  });

  test("a finish carrying six comments, or one on an unchanged line, is refused whole", async () => {
    const pages = new ReportPages();
    try {
      const review = blockerReport();
      const { reviewId } = await pages.publish(review);
      const reading = { answers: [], order: ["hunk-1"] };
      for (const [comments, expected] of [[added, /at most 5 are allowed/], [[at(1)], /an unchanged line/]] as const) {
        expect(() => pages.finish(reviewId, { ...reading, comments, summary: "Charge the limit the config states." }, "agent 1.0")).toThrow(expected);
        expect(review.agentComments).toBeUndefined();
        expect(review.agentOrder).toBeUndefined();
        expect(review.agentSummary).toBeUndefined();
        expect(pages.isFinished(reviewId)).toBe(false);
      }
      expect(pages.finish(reviewId, { ...reading, comments: added.slice(0, 5) }, "agent 1.0")).toMatchObject({ suggested: 5 });
      expect(pages.isFinished(reviewId)).toBe(true);
    } finally {
      await pages.close();
    }
  });
});
