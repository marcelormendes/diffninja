import { createHash } from "node:crypto";
import { request } from "node:http";
import { describe, expect, test } from "vitest";
import { MAX_REPORT_PAGES, MAX_SUMMARY_CHARS, MAX_SUMMARY_WORDS, ReportPages, reportPolicy } from "../src/review/report-pages.js";
import type { ReviewReport } from "../src/review/types.js";

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
