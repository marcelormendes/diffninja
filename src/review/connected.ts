import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ConnectedReview, type ReviewInput } from "./github.js";
import { renderConnectedPage } from "./connected-html.js";

const MAX_BODY = 256 * 1024;
export interface ConnectedSession { server: Server; url: string }
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") throw new Error("Expected application/json.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error("Request exceeds 256 KiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin) || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) {
      json(403, { error: "Untrusted Host or Origin." }); return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderConnectedPage(csrf)); return;
    }
    if (req.method === "GET" && req.url === "/api/state") { json(200, review.getState()); return; }
    const routes = ["/api/load", "/api/preview", "/api/submit", "/api/reconcile"];
    if (req.method !== "POST" || !routes.includes(req.url ?? "")) { json(404, { error: "Not found." }); return; }
    const token = req.headers["x-diffninja-csrf"];
    if (req.headers.origin !== origin || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) {
      json(403, { error: "Invalid session or CSRF token." }); return;
    }
    try {
      const input = await body(req);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object.");
      let result: unknown;
      switch (req.url) {
        case "/api/load": {
          const value = input as Record<string, unknown>;
          if (typeof value.url !== "string" || Object.keys(value).some(key => key !== "url")) throw new Error("Provide only an explicit GitHub PR URL.");
          result = await review.load(value.url); break;
        }
        case "/api/preview": result = await review.preview(input as ReviewInput); break;
        case "/api/submit": result = await review.submit(input as ReviewInput); break;
        case "/api/reconcile":
          if (Object.keys(input).length) throw new Error("Reconciliation takes no parameters.");
          result = await review.reconcile(); break;
      }
      json(200, result);
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : "Request failed.", state: review.getState() });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback binding failed.");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin + "/" };
}
