import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConnectedReview, type ConnectedState, type ReviewPayload } from "./github.js";
import { renderConnectedPage } from "./connected-html.js";
import type { ConnectedAnalysisView } from "./connected-analysis.js";
import { reportPolicy } from "./report-pages.js";

const MAX_BODY = 256 * 1024;
const loadSchema = z.object({ url: z.string() }).strict();
const reviewSchema = z.object({
  snapshotId: z.string(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string(),
  comments: z.array(z.object({ path: z.string(), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body: z.string() }).strict()),
}).strict();
const emptySchema = z.object({}).strict();
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface ConnectedSession { server: Server; url: string }
interface ErrorResponse { error: string; state?: ConnectedState }
type ApiResponse = ConnectedState | ReviewPayload | ErrorResponse | ConnectedAnalysisView;

/** Read-only extras a connected session can serve beside the review itself. */
export interface ConnectedOptions {
  /**
   * The local analysis of the loaded snapshot, for `GET /api/analysis`. It must
   * describe the snapshot the review currently holds, or say it is unavailable.
   */
  readonly analysis?: () => Promise<ConnectedAnalysisView>;
  /**
   * The call-flow page of the analysis of snapshot `snapshotId`, for one changed
   * file or all of them, for `GET /flow`. Undefined when that snapshot is not
   * the one analyzed or it has no call flows there.
   */
  readonly flow?: (snapshotId: string, file: string | undefined) => Promise<string | undefined>;
}

const NO_ANALYSIS: ConnectedAnalysisView = {
  available: false,
  reason: "No local analysis is attached to this session.",
};

async function readBody(req: IncomingMessage): Promise<string> {
  if (req.headers["content-type"] !== "application/json") throw new Error("Expected application/json.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error("Request exceeds 256 KiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Loopback-only guard. The request must name this session's exact host, must
 * not carry a foreign `Origin`, and must not announce a cross-site fetch. A
 * browser page on another origin can produce none of these headers honestly.
 */
function requestIsTrusted(req: IncomingMessage, origin: string): boolean {
  if (req.headers.host !== new URL(origin).host) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  const site = req.headers["sec-fetch-site"];
  return !site || ["same-origin", "none"].includes(String(site));
}

/** A single ephemeral session; never exposes a general GitHub API proxy. */
export async function serveConnected(review = new ConnectedReview(), options: ConnectedOptions = {}): Promise<ConnectedSession> {
  const csrf = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'nonce-${csrf}'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const json = (code: number, value: ApiResponse) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (!requestIsTrusted(req, origin)) { json(403, { error: "Untrusted Host or Origin." }); return; }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderConnectedPage(csrf)); return;
    }
    if (req.method === "GET" && req.url === "/api/state") { json(200, review.getState()); return; }
    if (req.method === "GET" && req.url === "/api/analysis") {
      try {
        json(200, options.analysis === undefined ? NO_ANALYSIS : await options.analysis());
      } catch (error) {
        json(200, { available: false, reason: `Local analysis failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
      return;
    }
    if (req.method === "GET" && (req.url ?? "").startsWith("/flow?")) {
      const query = new URL(req.url ?? "", origin).searchParams;
      const snapshotId = query.get("snapshot") ?? "";
      const file = query.get("file") ?? undefined;
      let html: string | undefined;
      try {
        html = options.flow === undefined ? undefined : await options.flow(snapshotId, file);
      } catch {
        html = undefined;
      }
      if (html === undefined) { json(404, { error: "No call flow for that revision and file." }); return; }
      // Only this page may frame it: the drawer beside the diff.
      res.setHeader("Content-Security-Policy", reportPolicy(html).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const routes = ["/api/load", "/api/preview", "/api/submit", "/api/reconcile"];
    if (req.method !== "POST" || !routes.includes(req.url ?? "")) { json(404, { error: "Not found." }); return; }
    const token = tokenSchema.safeParse(req.headers["x-diffninja-csrf"]);
    if (req.headers.origin !== origin || !token.success || !timingSafeEqual(Buffer.from(token.data), Buffer.from(csrf))) {
      json(403, { error: "Invalid session or CSRF token." }); return;
    }
    try {
      const text = await readBody(req);
      let result: ConnectedState | ReviewPayload;
      switch (req.url) {
        case "/api/load": result = await review.load(loadSchema.parse(JSON.parse(text)).url); break;
        case "/api/preview": result = await review.preview(reviewSchema.parse(JSON.parse(text))); break;
        case "/api/submit": result = await review.submit(reviewSchema.parse(JSON.parse(text))); break;
        default: emptySchema.parse(JSON.parse(text)); result = await review.reconcile(); break;
      }
      json(200, result);
    } catch (error) {
      const message = error instanceof z.ZodError ? "Invalid request fields: " + error.issues.map(issue => issue.path.join(".") || "input").join(", ") : error instanceof Error ? error.message : "Request failed.";
      json(400, { error: message, state: review.getState() });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin + "/" };
}
