/**
 * Loopback pages for static review reports, owned by one MCP connection.
 *
 * A static review returns its report to the agent as data; this serves the same
 * report as the self-contained HTML page for the human reviewer. The page is
 * read-only: there is no API, nothing is written to disk, and the only route is
 * `GET /report/<token>`, where the token is 256 random bits per report. Reports
 * embed source code, so the listener binds 127.0.0.1 only, rejects any request
 * whose Host is not this exact origin, and forbids caching, framing, and every
 * resource the page does not carry inline. The inline script and stylesheet are
 * allowed by their SHA-256 hashes, so the report HTML is served byte for byte.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { ReviewReport } from "./types.js";

/** Most reports one connection keeps; the oldest page closes first. */
export const MAX_REPORT_PAGES = 20;

const INLINE_BLOCK = /<(script|style)>([\s\S]*?)<\/\1>/g;

/** CSP naming exactly the inline script and style blocks of one page. */
export function reportPolicy(html: string): string {
  const hashes = { script: new Set<string>(), style: new Set<string>() };
  for (const match of html.matchAll(INLINE_BLOCK)) {
    const kind = match[1] === "script" ? "script" : "style";
    hashes[kind].add(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
  }
  const sources = (set: Set<string>) => (set.size === 0 ? "'none'" : [...set].join(" "));
  return [
    "default-src 'none'",
    `script-src ${sources(hashes.script)}`,
    `style-src ${sources(hashes.style)}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

interface ReportPage {
  html: string;
  policy: string;
  /** The report behind a published page, kept so recorded answers can re-render it. */
  readonly report?: ReviewReport;
  readonly reviewId?: string;
}

/** A static review published on this connection. */
export interface PublishedReview {
  readonly reviewId: string;
  readonly url: string;
}

/** One answer as the agent sent it; validated against the question before it is kept. */
export interface AnswerInput {
  readonly questionId: string;
  readonly choice: string;
}

export interface RecordedAnswers {
  readonly reviewId: string;
  readonly recorded: number;
  readonly answered: number;
  readonly unanswered: number;
  readonly reportUrl: string;
}

interface ReviewedPage {
  readonly token: string;
  readonly page: ReportPage;
  readonly report: ReviewReport;
}

export interface RecordedOrder {
  readonly reviewId: string;
  readonly ordered: number;
  readonly reportUrl: string;
}

export class ReportPages {
  private readonly pages = new Map<string, ReportPage>();
  private readonly tokens = new Map<string, string>();

  constructor(private readonly render: (report: ReviewReport) => string = () => "") {}
  private listening: Promise<{ server: Server; origin: string }> | undefined;
  private closed = false;

  /** Serve one report page and return its URL. */
  async add(html: string): Promise<string> {
    if (this.closed) throw new Error("This MCP connection is shutting down; the report page was not served.");
    const { origin } = await (this.listening ??= this.listen());
    const token = randomBytes(32).toString("hex");
    this.pages.set(token, { html, policy: reportPolicy(html) });
    for (const [oldest, page] of this.pages) {
      if (this.pages.size <= MAX_REPORT_PAGES) break;
      this.pages.delete(oldest);
      if (page.reviewId !== undefined) this.tokens.delete(page.reviewId);
    }
    return `${origin}/report/${token}`;
  }

  /** Serve a static review's page, keeping the report so answers can be recorded. */
  async publish(report: ReviewReport): Promise<PublishedReview> {
    const url = await this.add(this.render(report));
    const token = url.slice(url.lastIndexOf("/") + 1);
    const reviewId = randomBytes(16).toString("hex");
    const page = this.pages.get(token)!;
    this.pages.set(token, { ...page, report, reviewId });
    this.tokens.set(reviewId, token);
    return { reviewId, url };
  }

  /**
   * Record answers to one review's questions and re-render its page. Every
   * answer is checked before any is kept — a question this review asked, one of
   * that question's options, each question at most once per call — so a call
   * with one bad answer changes nothing. A later answer replaces an earlier one.
   */
  record(reviewId: string, answers: readonly AnswerInput[], answeredBy: string): RecordedAnswers {
    const { token, page, report } = this.review(reviewId);
    const questions = new Map(report.questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    answers.forEach((answer, index) => {
      const question = questions.get(answer.questionId);
      if (question === undefined) throw new Error(`answers[${index}] names a question this review did not ask.`);
      if (seen.has(answer.questionId)) throw new Error(`answers[${index}] answers the same question twice in one call.`);
      if (!question.options.includes(answer.choice)) {
        throw new Error(`answers[${index}] is not one of that question's options: ${question.options.join(", ")}.`);
      }
      seen.add(answer.questionId);
    });
    const answeredAt = new Date().toISOString();
    for (const answer of answers) questions.get(answer.questionId)!.answer = { choice: answer.choice, answeredBy, answeredAt };
    this.rerender(page, report);
    const answered = report.questions.filter((question) => question.answer !== undefined).length;
    return {
      reviewId,
      recorded: answers.length,
      answered,
      unanswered: report.questions.length - answered,
      reportUrl: `${this.origin}/report/${token}`,
    };
  }

  /**
   * Record the reading order the reviewing agent recommends: the report's items
   * are reordered to it, so every page and the connected analysis list hunks in
   * the agent's order, and the page is re-rendered. diffninja's own order is kept
   * beside it; statuses and priorities never change. The order must name every
   * hunk of the review exactly once; anything else refuses the whole call and
   * keeps the previous order. A later order replaces an earlier one.
   */
  recordOrder(reviewId: string, itemIds: readonly string[], orderedBy: string): RecordedOrder {
    const { token, page, report } = this.review(reviewId);
    const known = new Set(report.items.map((item) => item.id));
    const seen = new Set<string>();
    itemIds.forEach((id, index) => {
      if (!known.has(id)) throw new Error(`order[${index}] names a hunk this review does not have.`);
      if (seen.has(id)) throw new Error(`order[${index}] repeats a hunk; name each hunk once.`);
      seen.add(id);
    });
    const missing = report.items.filter((item) => !seen.has(item.id)).map((item) => item.id);
    if (missing.length > 0) throw new Error(`order leaves out ${missing.length} of ${known.size} hunks, starting with ${missing[0]}; name every hunk once.`);
    const diffninjaIds = report.agentOrder?.diffninjaIds ?? report.items.map((item) => item.id);
    const position = new Map(itemIds.map((id, index) => [id, index]));
    report.items.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    report.agentOrder = { itemIds: [...itemIds], orderedBy, orderedAt: new Date().toISOString(), diffninjaIds };
    this.rerender(page, report);
    return { reviewId, ordered: itemIds.length, reportUrl: `${this.origin}/report/${token}` };
  }

  private review(reviewId: string): ReviewedPage {
    const token = this.tokens.get(reviewId);
    const page = token === undefined ? undefined : this.pages.get(token);
    if (token === undefined || page?.report === undefined) {
      throw new Error("No review with that reviewId on this MCP connection. Reviews last as long as the connection, at most the latest 20.");
    }
    return { token, page, report: page.report };
  }

  private rerender(page: ReportPage, report: ReviewReport): void {
    page.html = this.render(report);
    page.policy = reportPolicy(page.html);
  }

  private origin = "";

  /** Stop serving every page. Repeated calls are harmless. */
  async close(): Promise<void> {
    this.closed = true;
    this.pages.clear();
    this.tokens.clear();
    const listening = this.listening;
    if (listening === undefined) return;
    const { server } = await listening.catch(() => ({ server: undefined }));
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async listen(): Promise<{ server: Server; origin: string }> {
    let origin = "";
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      const refuse = (code: number, message: string) => {
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
      };
      if (req.headers.host !== new URL(origin).host) return refuse(403, "Untrusted Host.");
      if (req.method !== "GET") return refuse(405, "Read-only report.");
      const token = /^\/report\/([a-f0-9]{64})$/.exec(req.url ?? "")?.[1];
      const page = token === undefined ? undefined : this.pages.get(token);
      if (page === undefined) return refuse(404, "No such report on this connection.");
      res.setHeader("Content-Security-Policy", page.policy);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page.html);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = z.object({ port: z.number().int().positive() }).parse(server.address());
    origin = `http://127.0.0.1:${address.port}`;
    this.origin = origin;
    // A close that raced this listen still owns the teardown.
    if (this.closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("This MCP connection is shutting down; the report page was not served.");
    }
    return { server, origin };
  }
}
