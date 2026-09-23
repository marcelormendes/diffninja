import { afterEach, describe, expect, it } from "vitest";
import { get } from "node:http";
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
  it("rejects arbitrary endpoints and malformed authenticated requests", async () => {
    const { url } = await start();
    const page = await fetch(url);
    const token = page.headers.get("content-security-policy")!.match(/nonce-([a-f0-9]+)/)![1];
    const headers = { Origin: new URL(url).origin, "Content-Type": "application/json", "X-Diffninja-CSRF": token };
    expect((await fetch(url + "api/exec", { method: "POST", headers, body: "{}" })).status).toBe(404);
    const invalid = await fetch(url + "api/load", { method: "POST", headers, body: JSON.stringify({ url: "https://github.com/a/b/pull/1", command: "whoami" }) });
    expect(invalid.status).toBe(400);
    expect((await fetch(url + "api/load", { method: "POST", headers, body: "{" })).status).toBe(400);
  });
});
