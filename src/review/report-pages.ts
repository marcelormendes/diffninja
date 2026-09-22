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
  readonly html: string;
  readonly policy: string;
}

export class ReportPages {
  private readonly pages = new Map<string, ReportPage>();
  private listening: Promise<{ server: Server; origin: string }> | undefined;
  private closed = false;

  /** Serve one report page and return its URL. */
  async add(html: string): Promise<string> {
    if (this.closed) throw new Error("This MCP connection is shutting down; the report page was not served.");
    const { origin } = await (this.listening ??= this.listen());
    const token = randomBytes(32).toString("hex");
    this.pages.set(token, { html, policy: reportPolicy(html) });
    for (const oldest of this.pages.keys()) {
      if (this.pages.size <= MAX_REPORT_PAGES) break;
      this.pages.delete(oldest);
    }
    return `${origin}/report/${token}`;
  }

  /** Stop serving every page. Repeated calls are harmless. */
  async close(): Promise<void> {
    this.closed = true;
    this.pages.clear();
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
    // A close that raced this listen still owns the teardown.
    if (this.closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("This MCP connection is shutting down; the report page was not served.");
    }
    return { server, origin };
  }
}
