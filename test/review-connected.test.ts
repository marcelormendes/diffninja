import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "node:http";
import { serveConnected, type ConnectedSession } from "../src/review/connected.js";
import { ConnectedReview } from "../src/review/github.js";

const servers: ConnectedSession[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(({ server }) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });
async function start() { const session = await serveConnected(); servers.push(session); return session; }
describe("connected session boundary", () => {
  it("serves only loopback and blocks cross-origin reads and mutations", async () => {
    const { server, url } = await start();
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    const page = await fetch(url);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(url + "api/state", { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(url, { headers: { Host: "attacker.example" } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(hostileHostStatus).toBe(403);
    expect((await fetch(url + "api/load", { method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/a/b/pull/1" }) })).status).toBe(403);
  });
  it("serves call-flow pages only to its own origin's frames, and only for the analyzed revision", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const session = await serveConnected(undefined, {
      flow: async (snapshotId, file) => {
        asked.push([snapshotId, file]);
        return snapshotId === "snap-1" ? "<!doctype html><title>flow</title><style>p{}</style><script>void 0</script>" : undefined;
      },
    });
    servers.push(session);
    const page = await fetch(session.url);
    expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const flow = await fetch(session.url + "flow?snapshot=snap-1&file=" + encodeURIComponent("src/a b.ts"));
    expect(flow.status).toBe(200);
    expect(flow.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const policy = flow.headers.get("content-security-policy")!;
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toContain("frame-ancestors 'none'");
    expect(policy).toMatch(/script-src 'sha256-/);
    expect(await flow.text()).toContain("<title>flow</title>");
    expect((await fetch(session.url + "flow?snapshot=snap-2")).status).toBe(404);
    expect(asked).toEqual([["snap-1", "src/a b.ts"], ["snap-2", undefined]]);
    expect((await fetch(session.url + "flow?snapshot=snap-1", { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await fetch(session.url + "flow?snapshot=snap-1", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  });
  it("keeps scrolled-to controls clear of the pinned file and change headers", async () => {
    const { url } = await start();
    const html = await (await fetch(url)).text();
    // File headers and reading-order change headers are sticky; without scroll
    // padding a control scrolled into view lands under one, and a click meant
    // for it hits the header instead.
    const padding = Number(/scroll-padding-top: (\d+)px/.exec(html)?.[1]);
    for (const head of ["file-head", "stop-head"]) {
      expect(html).toMatch(new RegExp(`\\.${head} \\{\\s*position: sticky; top: 0;`));
      const header = new RegExp(`\\.${head} \\{[^}]*min-height: (\\d+)px`).exec(html);
      expect(padding).toBeGreaterThan(Number(header?.[1]));
    }
  });
  it("rejects arbitrary endpoints and malformed authenticated requests", async () => {
    const { url } = await start();
    const page = await fetch(url);
    const token = /var CSRF = "([a-f0-9]{64})"/.exec(await page.text())![1];
    const headers = { Origin: new URL(url).origin, "Content-Type": "application/json", "X-Diffninja-CSRF": token };
    expect((await fetch(url + "api/exec", { method: "POST", headers, body: "{}" })).status).toBe(404);
    const invalid = await fetch(url + "api/load", { method: "POST", headers, body: JSON.stringify({ url: "https://github.com/a/b/pull/1", command: "whoami" }) });
    expect(invalid.status).toBe(400);
    expect((await fetch(url + "api/load", { method: "POST", headers, body: "{" })).status).toBe(400);
  });
  it("answers nothing without the session's secret path, so a local process that never got the link finds no page, no PR data and no way to post", async () => {
    const review = new ConnectedReview();
    const touched = [vi.spyOn(review, "getState"), vi.spyOn(review, "load"), vi.spyOn(review, "preview"), vi.spyOn(review, "submit"), vi.spyOn(review, "reconcile")];
    let analysisAsked = 0;
    const session = await serveConnected(review, { analysis: async () => { analysisAsked += 1; return { available: false, reason: "x" }; } });
    servers.push(session);
    const origin = new URL(session.url).origin;
    const secret = new URL(session.url).pathname.split("/")[1] ?? "";
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    // The page is what carries the CSRF token; fetch it the legitimate way once.
    const csrf = /var CSRF = "([a-f0-9]{64})"/.exec(await (await fetch(session.url)).text())?.[1] ?? "";
    expect(csrf).toHaveLength(64);
    const same = { Origin: origin, "Content-Type": "application/json", "X-Diffninja-CSRF": csrf };
    const wrong = (secret[0] === "a" ? "b" : "a") + secret.slice(1);
    for (const prefix of ["/", `/${wrong}/`, `/${secret.slice(0, 63)}/`, `/${secret}x/`, `//${secret}/`, "/api/", `/${secret}`]) {
      for (const [method, path] of [["GET", ""], ["GET", "api/state"], ["GET", "api/analysis"], ["GET", "flow?snapshot=x"], ["POST", "api/load"], ["POST", "api/preview"], ["POST", "api/submit"], ["POST", "api/reconcile"]] as const) {
        const response = await fetch(origin + prefix + path, { method, headers: method === "POST" ? same : {}, body: method === "POST" ? "{}" : undefined });
        expect(response.status, `${method} ${prefix}${path}`).toBe(404);
        expect(await response.text()).not.toMatch(/CSRF|snapshot|diff/i);
      }
    }
    for (const spy of touched) expect(spy).not.toHaveBeenCalled();
    expect(analysisAsked).toBe(0);
    // The right prefix works, and still needs the CSRF token to change anything.
    expect((await fetch(session.url + "api/state")).status).toBe(200);
    expect((await fetch(session.url + "api/submit", { method: "POST", headers: { ...same, "X-Diffninja-CSRF": "0".repeat(64) }, body: "{}" })).status).toBe(403);
    expect(touched[0]).toHaveBeenCalledTimes(1);
    for (const spy of touched.slice(1)) expect(spy).not.toHaveBeenCalled();
  });
  it("gives every response its own script nonce, never the CSRF token, and sends the page's requests under the secret prefix", async () => {
    const { url } = await start();
    const first = await fetch(url);
    const second = await fetch(url);
    const html = await first.text();
    const nonce = (response: Response) => /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(response.headers.get("content-security-policy")!)![1];
    expect(nonce(first)).not.toBe(nonce(second));
    expect(html).toContain(`<script nonce="${nonce(first)}">`);
    expect(html).not.toContain(/var CSRF = "([a-f0-9]{64})"/.exec(html)![1] + '">');
    expect(nonce(first)).not.toContain(/var CSRF = "([a-f0-9]{64})"/.exec(html)![1]);
    const base = new URL(url).pathname;
    expect(html).toContain(`var BASE = ${JSON.stringify(base)};`);
    // Every request the page's script makes goes through api() or a frame src, both under BASE.
    expect(html.match(/\bfetch\(/g)).toHaveLength(1);
    expect(html).toContain("fetch(BASE + ");
    expect(html).not.toContain("'/flow?");
    expect(html.match(/= BASE \+ 'flow\?snapshot='/g)).toHaveLength(2);
    expect(first.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
