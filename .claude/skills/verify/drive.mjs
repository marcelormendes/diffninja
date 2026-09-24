#!/usr/bin/env node
// Drive the built diffninja MCP server the way an agent host does: spawn
// dist/review/mcp-cli.js over stdio, call its tools, fetch the loopback pages it
// returns, and write every request, result, and page to an evidence directory.
//
//   node .claude/skills/verify/drive.mjs doctor
//   node .claude/skills/verify/drive.mjs review --args '<review_diff JSON>' [--answer cannot-tell|first] [--order reverse] [--suggest] [--hold SECONDS] [--out DIR]
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
  options: { args: { type: "string" }, answer: { type: "string" }, order: { type: "string" }, suggest: { type: "boolean" }, hold: { type: "string" }, out: { type: "string" } },
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
  check("tools are review_diff, finish_review, record_answers, record_order, suggest_comments", tools.join(",") === "finish_review,record_answers,record_order,review_diff,suggest_comments", tools.join(","));
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
    const payload = result.structuredContent;
    check("text content is the same JSON as structuredContent", JSON.stringify(JSON.parse(result.content[0].text)) === JSON.stringify(payload));
    const report = payload.report ?? payload;
    const items = report.items ?? [];
    const questions = report.questions ?? [];
    console.log(`INFO ${JSON.stringify({ mode: payload.mode ?? "static", items: items.length, questions: questions.length, unavailable: payload.analysisUnavailable ?? null })}`);
    let pages = { reportUrl: payload.reportUrl, url: payload.url };
    if (payload.reviewId) {
      // The diff itself may mention loopback addresses; only the link fields matter.
      check("review_diff hands out no page link before finish_review", !("url" in payload) && !("reportUrl" in payload));
      const answers = questions.map(q => ({ questionId: q.id, choice: values.answer === "first" ? q.options[0] : "cannot-tell" }));
      const order = items.map(item => item.id);
      if (values.order === "reverse") order.reverse();
      const comments = [];
      if (values.suggest) {
        // One comment on the first added line of each of the first three hunks, in a reviewer's voice.
        for (const item of items.slice(0, 3)) {
          let line = item.newStart;
          for (const text of item.diff.split("\n").slice(1)) {
            if (text.startsWith("+")) { comments.push({ path: item.file, line, side: "RIGHT", body: `Could we cover ${item.file.split("/").pop()} line ${line} with a test?` }); break; }
            if (!text.startsWith("-")) line += 1;
          }
        }
      }
      if (questions.length > 0) {
        const partial = await client.callTool({ name: "finish_review", arguments: { reviewId: payload.reviewId, answers: answers.slice(1), order, comments } });
        save("finish_review.refused.json", partial);
        check("finish_review refuses a reading that leaves a question out", partial.isError === true && !/127\.0\.0\.1/.test(partial.content[0].text));
      }
      const labelled = comments.length > 0
        ? await client.callTool({ name: "finish_review", arguments: { reviewId: payload.reviewId, answers, order, comments: [{ ...comments[0], body: "Finding 1: missing test" }] } })
        : null;
      if (labelled) { save("finish_review.labelled.json", labelled); check("finish_review refuses report-style comments", labelled.isError === true); }
      const finished = await client.callTool({ name: "finish_review", arguments: { reviewId: payload.reviewId, answers, order, comments } });
      save("finish_review.json", finished);
      if (!check("finish_review accepted the whole reading", !finished.isError, finished.isError ? finished.content[0].text : "")) return;
      pages = { reportUrl: finished.structuredContent.reportUrl, url: finished.structuredContent.url };
      check("finish_review hands out the page links", Boolean(pages.reportUrl) && (payload.mode !== "connected" || Boolean(pages.url)), JSON.stringify(pages));
      const reportPage = await get(pages.reportUrl);
      save("reportUrl.finished.html", reportPage.body);
      check("report page shows the answers and order attributed to this client", reportPage.body.includes(CLIENT.name) && reportPage.body.includes(`reading order recommended by ${CLIENT.name}`));
      if (pages.url) {
        const view = JSON.parse((await get(new URL("api/analysis", pages.url).href)).body);
        save("url.analysis.json", view);
        check("pull request page has the agent's order", view.order?.source === "agent" && view.hunks.map(h => h.id).join(",") === order.join(","), JSON.stringify(view.order));
        check("pull request page has every answer", view.questions?.answered === questions.length, JSON.stringify(view.questions));
        check("pull request page has the suggested comments", (view.suggestions?.comments.length ?? 0) === comments.length && (comments.length === 0 || view.suggestions.suggestedBy.startsWith(CLIENT.name)));
      }
    }
    reportUrl = pages.reportUrl;
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
  else throw new Error("usage: drive.mjs doctor | drive.mjs review --args '<json>' [--answer cannot-tell|first] [--order reverse] [--suggest] [--hold SECONDS] [--out DIR]");
} catch (error) {
  console.error(`drive.mjs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
if (checks.some(c => !c.ok)) process.exitCode = 1;
