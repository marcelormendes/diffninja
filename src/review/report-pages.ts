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
import type { ReviewItem, ReviewReport, SuggestedComment } from "./types.js";

/** Most reports one connection keeps; the oldest page closes first. */
export const MAX_REPORT_PAGES = 20;
/** Most comments one review may carry from the agent: a reviewer's handful, not a lint dump. */
export const MAX_SUGGESTED_COMMENTS = 30;
/** Longest suggested comment: a sentence or two, the way a reviewer writes one. */
export const MAX_SUGGESTED_CHARS = 280;

const CONTROL_CHARACTERS = /[^\P{Cc}]/u;
/** Report scaffolding a person would not write in a review comment: "Finding 1:", "Attention -", "**Error**", "## Bug". */
const REPORT_LABEL = /^\s*(?:#|>|[-*+]\s|\d+[.)]\s|\*\*|\[)|^\s*(?:findings?|issues?|attention|errors?|warnings?|bugs?|problems?|severity|critical|major|minor|high|medium|low|concerns?|risks?|suggestions?|observations?|summary)\b\s*#?\d*\s*[:\-\u2013\u2014.]|\*\*/i;

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
  /** Set once finish_review accepted the agent's whole reading; only then is the page's address handed out. */
  finished?: boolean;
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
}

interface ReviewedPage {
  readonly token: string;
  readonly page: ReportPage;
  readonly report: ReviewReport;
}

export interface RecordedOrder {
  readonly reviewId: string;
  readonly ordered: number;
}

export interface RecordedComments {
  readonly reviewId: string;
  readonly suggested: number;
}

/** Everything the reviewing agent owes a review before its pages are handed out. */
export interface FinishInput {
  readonly answers: readonly AnswerInput[];
  readonly order: readonly string[];
  readonly comments: readonly SuggestedComment[];
}

export interface FinishedReview {
  readonly reviewId: string;
  readonly answered: number;
  readonly ordered: number;
  readonly suggested: number;
  readonly reportUrl: string;
}

/** Every answer names a question this review asked, once, with one of its options. */
function checkAnswers(report: ReviewReport, answers: readonly AnswerInput[]): void {
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
}

function applyAnswers(report: ReviewReport, answers: readonly AnswerInput[], answeredBy: string): void {
  const questions = new Map(report.questions.map((question) => [question.id, question]));
  const answeredAt = new Date().toISOString();
  for (const answer of answers) questions.get(answer.questionId)!.answer = { choice: answer.choice, answeredBy, answeredAt };
}

/** The order names every hunk of the review exactly once. */
function checkOrder(report: ReviewReport, itemIds: readonly string[]): void {
  const known = new Set(report.items.map((item) => item.id));
  const seen = new Set<string>();
  itemIds.forEach((id, index) => {
    if (!known.has(id)) throw new Error(`order[${index}] names a hunk this review does not have.`);
    if (seen.has(id)) throw new Error(`order[${index}] repeats a hunk; name each hunk once.`);
    seen.add(id);
  });
  const missing = report.items.filter((item) => !seen.has(item.id)).map((item) => item.id);
  if (missing.length > 0) throw new Error(`order leaves out ${missing.length} of ${known.size} hunks, starting with ${missing[0]}; name every hunk once.`);
}

function applyOrder(report: ReviewReport, itemIds: readonly string[], orderedBy: string): void {
  const diffninjaIds = report.agentOrder?.diffninjaIds ?? report.items.map((item) => item.id);
  const position = new Map(itemIds.map((id, index) => [id, index]));
  report.items.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  report.agentOrder = { itemIds: [...itemIds], orderedBy, orderedAt: new Date().toISOString(), diffninjaIds };
}

/** Every comment names a line of the diff, one per line, and reads like the reviewer's own. */
function checkComments(report: ReviewReport, comments: readonly SuggestedComment[]): void {
  const anchors = new Set<string>();
  for (const item of report.items) anchorsOf(item, anchors);
  const seen = new Set<string>();
  comments.forEach((comment, index) => {
    const key = anchorKey(comment.path, comment.side, comment.line);
    if (!anchors.has(key)) throw new Error(`comments[${index}] names ${comment.path}:${comment.line} (${comment.side}), which is not a line of this review's diff.`);
    if (seen.has(key)) throw new Error(`comments[${index}] is a second comment on the same line; combine them into one.`);
    const problem = commentProblem(comment.body);
    if (problem !== undefined) throw new Error(`comments[${index}] ${problem}.`);
    seen.add(key);
  });
}

function applyComments(report: ReviewReport, comments: readonly SuggestedComment[], suggestedBy: string): void {
  report.agentComments = {
    comments: comments.map(({ path, line, side, body }) => ({ path, line, side, body: body.trim() })),
    suggestedBy,
    suggestedAt: new Date().toISOString(),
  };
}

/** Map key of one commentable line. */
function anchorKey(path: string, side: "LEFT" | "RIGHT", line: number): string {
  return JSON.stringify([path, side, line]);
}

/** Every line a comment may anchor to in one hunk: added lines on the new side, removed on the old, context on both. */
function anchorsOf(item: ReviewItem, into: Set<string>): void {
  let oldLine = item.oldStart;
  let newLine = item.newStart;
  for (const text of item.diff.split("\n").slice(1)) {
    if (text.startsWith("+")) into.add(anchorKey(item.file, "RIGHT", newLine++));
    else if (text.startsWith("-")) into.add(anchorKey(item.file, "LEFT", oldLine++));
    else if (text.startsWith(" ")) {
      into.add(anchorKey(item.file, "RIGHT", newLine++));
      into.add(anchorKey(item.file, "LEFT", oldLine++));
    }
  }
}

/** Why a suggested comment cannot be offered as the reviewer's own words, or undefined when it can. */
function commentProblem(body: string): string | undefined {
  if (body.trim() === "") return "is empty";
  if (/[\r\n]/.test(body)) return "must be one line of text";
  if (CONTROL_CHARACTERS.test(body)) return "contains control characters";
  if (body.length > MAX_SUGGESTED_CHARS) return `is longer than ${MAX_SUGGESTED_CHARS} characters; say it the way a reviewer would, in a sentence or two`;
  if (REPORT_LABEL.test(body)) return "reads like a report (a heading, list marker, bold, or a label such as \"Finding 1:\"); write it the way the reviewer would say it";
  return undefined;
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
   * Accept the reviewing agent's whole reading of a review at once: an answer
   * to every question, the reading order of every hunk, and the line comments
   * it suggests (an empty list says it has none). Everything is checked before
   * anything is kept, so one gap or bad entry refuses the call and changes
   * nothing. Only a finished review's page addresses are handed out: an agent
   * cannot give the human a page it has not finished reading.
   */
  finish(reviewId: string, input: FinishInput, by: string): FinishedReview {
    const { token, page, report } = this.review(reviewId);
    checkAnswers(report, input.answers);
    const answeredIds = new Set(input.answers.map((answer) => answer.questionId));
    const unanswered = report.questions.filter((question) => !answeredIds.has(question.id));
    if (unanswered.length > 0) {
      throw new Error(`answers leave out ${unanswered.length} of ${report.questions.length} questions, starting with ${unanswered[0].id}; answer every question, cannot-tell when the code does not settle it.`);
    }
    checkOrder(report, input.order);
    checkComments(report, input.comments);
    applyAnswers(report, input.answers, by);
    applyOrder(report, input.order, by);
    applyComments(report, input.comments, by);
    page.finished = true;
    this.rerender(page, report);
    return {
      reviewId,
      answered: input.answers.length,
      ordered: input.order.length,
      suggested: input.comments.length,
      reportUrl: `${this.origin}/report/${token}`,
    };
  }

  /** Whether finish_review accepted this review, so its addresses may be handed out again. */
  isFinished(reviewId: string): boolean {
    return this.review(reviewId).page.finished === true;
  }

  /**
   * Update the answers of a review. Every answer is checked before any is kept
   * — a question this review asked, one of that question's options, each
   * question at most once per call — so a call with one bad answer changes
   * nothing. A later answer replaces an earlier one.
   */
  record(reviewId: string, answers: readonly AnswerInput[], answeredBy: string): RecordedAnswers {
    const { page, report } = this.review(reviewId);
    checkAnswers(report, answers);
    applyAnswers(report, answers, answeredBy);
    this.rerender(page, report);
    const answered = report.questions.filter((question) => question.answer !== undefined).length;
    return { reviewId, recorded: answers.length, answered, unanswered: report.questions.length - answered };
  }

  /**
   * Update the reading order the reviewing agent recommends: the report's items
   * are reordered to it, so every page and the connected analysis list hunks in
   * the agent's order. diffninja's own order is kept beside it; statuses and
   * priorities never change. The order must name every hunk exactly once;
   * anything else refuses the call and keeps the previous order.
   */
  recordOrder(reviewId: string, itemIds: readonly string[], orderedBy: string): RecordedOrder {
    const { page, report } = this.review(reviewId);
    checkOrder(report, itemIds);
    applyOrder(report, itemIds, orderedBy);
    this.rerender(page, report);
    return { reviewId, ordered: itemIds.length };
  }

  /**
   * Update the line comments the reviewing agent suggests. The human sees them
   * under their lines on the pull request page and adds each to their own
   * review, or not; nothing here posts anything. Any bad comment refuses the
   * call and keeps the previous set; an empty list clears it.
   */
  suggestComments(reviewId: string, comments: readonly SuggestedComment[], suggestedBy: string): RecordedComments {
    const { page, report } = this.review(reviewId);
    checkComments(report, comments);
    applyComments(report, comments, suggestedBy);
    this.rerender(page, report);
    return { reviewId, suggested: comments.length };
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
