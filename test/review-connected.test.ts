import { afterEach, describe, expect, it } from "vitest";
import { serveConnected, type ConnectedSession } from "../src/review/connected.js";

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
    expect((await fetch(url, { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await fetch(url + "api/load", { method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/a/b/pull/1" }) })).status).toBe(403);
  });
  it("rejects arbitrary endpoints and malformed authenticated requests", async () => {
    const { url } = await start();
    const page = await fetch(url);
    const token = page.headers.get("content-security-policy")!.match(/nonce-([a-f0-9]+)/)![1];
    const headers = { Origin: new URL(url).origin, "Content-Type": "application/json", "X-Diffninja-CSRF": token };
    expect((await fetch(url + "api/exec", { method: "POST", headers, body: "{}" })).status).toBe(404);
    const invalid = await fetch(url + "api/load", { method: "POST", headers, body: JSON.stringify({ url: "https://github.com/a/b/pull/1", command: "whoami" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "Provide only an explicit GitHub PR URL." });
    expect((await fetch(url + "api/load", { method: "POST", headers, body: "{" })).status).toBe(400);
  });
});
