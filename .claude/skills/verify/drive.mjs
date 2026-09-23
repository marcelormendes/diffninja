#!/usr/bin/env node
// Drive the built diffninja MCP server the way an agent host does: spawn
// dist/review/mcp-cli.js over stdio, call its tools, fetch the loopback pages it
// returns, and write every request, result, and page to an evidence directory.
//
//   node .claude/skills/verify/drive.mjs doctor
//   node .claude/skills/verify/drive.mjs review --args '<review_diff JSON>' [--answer cannot-tell|first] [--order reverse] [--hold SECONDS] [--out DIR]
//
// The server lives only as long as this process: closing the client closes the
// server's stdin, which ends the session and its pages. Evidence stays on disk.
import { execFileSync, spawnSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER = join(ROOT, "dist/review/mcp-cli.js");
const CLIENT = { name: "diffninja-verify", version: "1" };
const require = createRequire(join(ROOT, "package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { args: { type: "string" }, answer: { type: "string" }, order: { type: "string" }, hold: { type: "string" }, out: { type: "string" } },
});

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function connect(stderrFile) {
  const client = new Client(CLIENT, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", chunk => stderr.push(chunk));
  await client.connect(transport);
  return { client, pid: transport.pid, flushStderr: () => stderrFile && writeFileSync(stderrFile, Buffer.concat(stderr)) };
}

// The page server checks Host against its own origin. fetch() always sends the
// URL's own host, so node:http is what lets a check send a foreign one.
function get(url, host) {
  return new Promise((done, fail) => {
    const req = request(url, { headers: { host: host ?? new URL(url).host } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail).end();
  });
}

function newest(dir, suffix) {
  let latest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) latest = Math.max(latest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return latest;
}

async function doctor() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  check("node >= 22.18", major > 22 || (major === 22 && minor >= 18), process.version);
  if (!check("built server exists", existsSync(SERVER), SERVER)) return;
  const stale = newest(join(ROOT, "src"), ".ts") > statSync(SERVER).mtimeMs;
  check("build is newer than src/", !stale, stale ? "run `npm run build`" : "");
  const bad = spawnSync(process.execPath, [SERVER, "unexpected-arg"], { encoding: "utf8", timeout: 20_000 });
  check("server refuses arguments", bad.status === 1 && bad.stderr.includes("accepts no arguments") && bad.stdout === "", `exit ${bad.status}`);
  const { client } = await connect();
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  check("tools are review_diff, record_answers, record_order", tools.join(",") === "record_answers,record_order,review_diff", tools.join(","));
  await client.close();
  let gh = "not installed";
  try { execFileSync("gh", ["auth", "status"], { stdio: "pipe", timeout: 20_000 }); gh = "authenticated"; } catch (error) { gh = error.code === "ENOENT" ? gh : "not authenticated"; }
  console.log(`INFO gh CLI: ${gh} (needed only for connected pull request review)`);
}

async function review() {
  if (!values.args) throw new Error("review needs --args '<review_diff arguments as JSON>'");
  const args = JSON.parse(values.args);
  const out = resolve(values.out ?? join(tmpdir(), "diffninja-verify", new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(out, { recursive: true });
  const save = (name, data) => writeFileSync(join(out, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  save("request.json", args);
  const { client, pid, flushStderr } = await connect(join(out, "server-stderr.txt"));
  console.log(`server pid ${pid}; evidence in ${out}`);
  let reportUrl;
  try {
    const result = await client.callTool({ name: "review_diff", arguments: args }, undefined, { timeout: 900_000 });
    save("review_diff.json", result);
    if (!check("review_diff succeeded", !result.isError, result.isError ? result.content[0].text : "")) return;
    const report = result.structuredContent;
    reportUrl = report.reportUrl;
    check("text content is the same JSON as structuredContent", JSON.stringify(JSON.parse(result.content[0].text)) === JSON.stringify(report));
    const pages = { reportUrl: report.reportUrl, url: report.url };
    for (const [name, url] of Object.entries(pages)) {
      if (!url) continue;
      const origin = new URL(url);
      check(`${name} is loopback`, origin.hostname === "127.0.0.1", url);
      const page = await get(url, origin.host);
      save(`${name}.html`, page.body); save(`${name}.headers.json`, { status: page.status, ...page.headers });
      check(`${name} serves the page`, page.status === 200 && page.headers["content-type"]?.startsWith("text/html"), `status ${page.status}`);
      check(`${name} is no-store with a CSP`, /no-store/.test(page.headers["cache-control"] ?? "") && Boolean(page.headers["content-security-policy"]));
      const foreign = await get(url, "evil.example");
      check(`${name} refuses a foreign Host`, foreign.status === 403, `status ${foreign.status}`);
    }
    const summary = report.items ? { items: report.items.length, statuses: report.items.map(item => item.status), questions: report.questions?.length ?? 0 }
      : { mode: report.mode, questions: report.report?.questions?.length ?? 0 };
    console.log(`INFO ${JSON.stringify(summary)}`);
    const questions = report.questions ?? report.report?.questions ?? [];
    if (values.answer && questions.length > 0) {
      const answers = questions.map(q => ({ questionId: q.id, choice: values.answer === "first" ? q.options[0] : "cannot-tell" }));
      const recorded = await client.callTool({ name: "record_answers", arguments: { reviewId: report.reviewId, answers } });
      save("record_answers.json", recorded);
      check("record_answers accepted every answer", !recorded.isError && recorded.structuredContent?.recorded === answers.length, recorded.isError ? recorded.content[0].text : "");
      const refused = await client.callTool({ name: "record_answers", arguments: { reviewId: report.reviewId, answers: [{ questionId: questions[0].id, choice: "not-an-option" }] } });
      save("record_answers.refused.json", refused);
      check("record_answers refuses an unlisted option", refused.isError === true);
      const after = await get(report.reportUrl, new URL(report.reportUrl).host);
      save("reportUrl.after-answers.html", after.body);
      check("page shows the answers attributed to this client", after.body.includes(CLIENT.name));
    }
    const items = report.items ?? report.report?.items ?? [];
    if (values.order === "reverse" && items.length > 1) {
      const before = await get(report.reportUrl);
      const ids = items.map(item => item.id).reverse();
      const ordered = await client.callTool({ name: "record_order", arguments: { reviewId: report.reviewId, order: ids } });
      save("record_order.json", ordered);
      check("record_order accepted the full order", !ordered.isError && ordered.structuredContent?.ordered === ids.length, ordered.isError ? ordered.content[0].text : "");
      const partial = await client.callTool({ name: "record_order", arguments: { reviewId: report.reviewId, order: ids.slice(1) } });
      save("record_order.refused.json", partial);
      check("record_order refuses an order that leaves a hunk out", partial.isError === true);
      const after = await get(report.reportUrl);
      save("reportUrl.after-order.html", after.body);
      const list = /<ol class="agent-order-list">([\s\S]*?)<\/ol>/.exec(after.body)?.[1] ?? "";
      const ranks = [...list.matchAll(/href="#item-(\d+)"/g)].map(match => Number(match[1]));
      check("page lists the agent's order, attributed to this client", after.body.includes(`Reading order recommended by ${CLIENT.name}`) && ranks.join(",") === items.map((_, k) => k + 1).reverse().join(","), ranks.join(","));
      const cards = body => [...body.matchAll(/<span class="path mono">([^<]*)<\/span>/g)].map(match => match[1]).join("|");
      check("diffninja's own card order is unchanged", cards(after.body) === cards(before.body));
    }
    if (values.hold) {
      console.log(`HOLD ${values.hold}s — open now: ${Object.values(pages).filter(Boolean).join(" ")}`);
      await new Promise(done => setTimeout(done, Number(values.hold) * 1000));
    }
  } finally {
    await client.close();
    flushStderr();
  }
  if (reportUrl) {
    const gone = await get(reportUrl).then(() => false, () => true);
    check("page closes with the connection", gone, reportUrl);
  }
  save("checks.json", checks);
}

try {
  if (command === "doctor") await doctor();
  else if (command === "review") await review();
  else throw new Error("usage: drive.mjs doctor | drive.mjs review --args '<json>' [--answer cannot-tell|first] [--order reverse] [--hold SECONDS] [--out DIR]");
} catch (error) {
  console.error(`drive.mjs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
if (checks.some(c => !c.ok)) process.exitCode = 1;
