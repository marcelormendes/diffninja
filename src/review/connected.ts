import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConnectedReview, type ConnectedState, type ReviewPayload } from "./github.js";
import { renderConnectedPage } from "./connected-html.js";

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
type ApiResponse = ConnectedState | ReviewPayload | ErrorResponse;

async function body(req: IncomingMessage): Promise<string> {
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

/** A single ephemeral session; never exposes a general GitHub API proxy. */
export async function serveConnected(review = new ConnectedReview()): Promise<ConnectedSession> {
  const csrf = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'nonce-${csrf}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const json = (code: number, value: ApiResponse) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin) || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) {
      json(403, { error: "Untrusted Host or Origin." }); return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderConnectedPage(csrf)); return;
    }
    if (req.method === "GET" && req.url === "/api/state") { json(200, review.getState()); return; }
    const routes = ["/api/load", "/api/preview", "/api/submit", "/api/reconcile"];
    if (req.method !== "POST" || !routes.includes(req.url ?? "")) { json(404, { error: "Not found." }); return; }
    const token = tokenSchema.safeParse(req.headers["x-diffninja-csrf"]);
    if (req.headers.origin !== origin || !token.success || !timingSafeEqual(Buffer.from(token.data), Buffer.from(csrf))) {
      json(403, { error: "Invalid session or CSRF token." }); return;
    }
    try {
      const text = await body(req);
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
