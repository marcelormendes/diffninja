import { createHash } from "node:crypto";
import { request } from "node:http";
import { describe, expect, test } from "vitest";
import { MAX_REPORT_PAGES, ReportPages, reportPolicy } from "../src/review/report-pages.js";

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
