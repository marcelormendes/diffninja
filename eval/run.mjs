#!/usr/bin/env node
// Runs diffninja on the labelled pull requests in eval/manifest.json, headless,
// the way a user would: `claude -p` with diffninja as its only MCP server and
// the prompt from the manifest. See eval/README.md.
//
//   node eval/run.mjs prepare --work DIR [--only id,id]
//   node eval/run.mjs review  --work DIR [--only id,id] [--model sonnet] [--budget 5] [--jobs 3] [--tag NAME] [--force]
//   node eval/run.mjs summary --work DIR [--tag NAME]
//
// Nothing is posted to GitHub. `prepare` only reads (git clone/fetch of public
// repositories, `gh pr view`, `gh api` GETs). `review` runs with a stand-in
// `gh` (eval/fake-gh.mjs) that serves those recordings and refuses every other
// call, with no gh or git credentials in the environment.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, createWriteStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, "..");
const manifest = JSON.parse(readFileSync(join(evalDir, "manifest.json"), "utf8"));
const VIEW_FIELDS = "url,id,number,state,title,body,baseRefOid,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,baseRefName,headRefName";
const RUN_TIMEOUT_MS = 30 * 60_000;

function parseArgs(argv) {
  const options = { command: argv[0], only: null, model: "sonnet", budget: "5", jobs: 3, tag: null, force: false, work: null };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--force") { options.force = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    index++;
    if (flag === "--work") options.work = resolve(value);
    else if (flag === "--only") options.only = new Set(value.split(","));
    else if (flag === "--model") options.model = value;
    else if (flag === "--budget") options.budget = value;
    else if (flag === "--jobs") options.jobs = Number(value);
    else if (flag === "--tag") options.tag = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!["prepare", "review", "summary"].includes(options.command)) throw new Error("usage: run.mjs prepare|review|summary --work DIR");
  if (options.work === null) throw new Error("--work DIR is required (a directory outside this repository)");
  if ((options.work + sep).startsWith(repoRoot + sep)) throw new Error("--work must be outside the diffninja repository");
  options.tag ??= options.model;
  return options;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function selected(options) {
  return manifest.cases.filter(item => options.only === null || options.only.has(item.id));
}

function caseDir(options, item) {
  return join(options.work, "cases", item.id);
}

function cloneDir(options, item) {
  return join(caseDir(options, item), item.repo.split("/")[1]);
}

/** One bare clone per repository; each case gets a repo that borrows its objects. */
function prepareCase(options, item) {
  const url = `https://github.com/${item.repo}/pull/${item.pr}`;
  const cache = join(options.work, "cache", `${item.repo.replace("/", "__")}.git`);
  if (!existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    git(["clone", "--bare", "--no-tags", `https://github.com/${item.repo}.git`, cache]);
  }
  git(["fetch", "--no-tags", "origin", `+refs/pull/${item.pr}/head:refs/eval/${item.id}/pr-head`], cache);
  git(["fetch", "--no-tags", "origin", item.base], cache);
  const prHead = git(["rev-parse", `refs/eval/${item.id}/pr-head`], cache);
  if (prHead !== item.head) process.stderr.write(`${item.id}: refs/pull/${item.pr}/head is ${prHead}, manifest head is ${item.head}; using the manifest\n`);
  git(["cat-file", "-e", `${item.head}^{commit}`], cache);

  // Recordings for the stand-in gh. The pull request is reported open, since a
  // merged one cannot be reviewed; everything else is GitHub's own answer.
  const fixture = join(caseDir(options, item), "gh");
  mkdirSync(fixture, { recursive: true });
  const view = JSON.parse(gh(["pr", "view", url, "--json", VIEW_FIELDS]));
  view.state = "OPEN";
  view.baseRefOid = item.base;
  view.headRefOid = item.head;
  view.headRepositoryOwner ??= { login: item.repo.split("/")[0] };
  view.headRepository ??= { name: item.repo.split("/")[1] };
  // gh 2.87 reports nameWithOwner as "" for every pull request, which diffninja
  // 0.4.2 reads as "head repository unavailable"; fill it so the review runs.
  if (!view.headRepository.nameWithOwner) view.headRepository.nameWithOwner = `${view.headRepositoryOwner.login}/${view.headRepository.name}`;
  writeFileSync(join(fixture, "view.json"), JSON.stringify(view));
  writeFileSync(join(fixture, "pr.json"), JSON.stringify({ repo: item.repo, number: item.pr, url: view.url }));
  writeFileSync(join(fixture, "pr.diff"), gh(["api", "-H", "Accept: application/vnd.github.diff", `repos/${item.repo}/pulls/${item.pr}`]));
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${item.repo}/pulls/${item.pr}/files?per_page=100`]));
  writeFileSync(join(fixture, "files.json"), JSON.stringify(pages.flat()));

  // The clone the agent works in: the PR head checked out, the base branch at
  // the PR's base, and no remote and no later commits, so the history cannot
  // show the fix that came after.
  const clone = cloneDir(options, item);
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(clone, { recursive: true });
  git(["init", "--quiet", "--initial-branch", `pr-${item.pr}`], clone);
  writeFileSync(join(clone, ".git", "objects", "info", "alternates"), `${join(cache, "objects")}\n`);
  git(["update-ref", `refs/heads/${view.baseRefName}`, item.base], clone);
  git(["update-ref", `refs/heads/pr-${item.pr}`, item.head], clone);
  git(["checkout", "--quiet", "--force", `pr-${item.pr}`], clone);
  process.stdout.write(`prepared ${item.id}\n`);
}

/** The environment a review runs in: the stand-in gh first on PATH, no credentials. */
function reviewEnv(options, item) {
  const dir = caseDir(options, item);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(evalDir, "fake-gh.mjs")}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const empty = join(dir, "empty");
  mkdirSync(join(empty, "gh-config"), { recursive: true });
  writeFileSync(join(empty, "gitconfig"), "");
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const env = { ...process.env };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
  return {
    ...env,
    PATH: `${bin}:${process.env.PATH}`,
    EVAL_GH_FIXTURE: join(dir, "gh"),
    GH_CONFIG_DIR: join(empty, "gh-config"),
    GIT_CONFIG_GLOBAL: join(empty, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_ignore_scripts: "true",
    DIFFNINJA_GRAMMAR_CACHE: join(options.work, "grammars"),
    TMPDIR: join(dir, "tmp"),
  };
}

function reviewCase(options, item) {
  const out = join(options.work, "runs", options.tag, item.id);
  if (existsSync(join(out, "result.json")) && !options.force) return Promise.resolve(JSON.parse(readFileSync(join(out, "result.json"), "utf8")));
  mkdirSync(out, { recursive: true });
  // An earlier run may have left files or another checkout behind.
  const clone = cloneDir(options, item);
  git(["checkout", "--quiet", "--force", `pr-${item.pr}`], clone);
  git(["reset", "--quiet", "--hard", item.head], clone);
  git(["clean", "--quiet", "-fdx"], clone);
  const env = reviewEnv(options, item);
  const mcpConfig = join(caseDir(options, item), "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { diffninja: {
    type: "stdio", command: process.execPath, args: [join(repoRoot, "dist", "review", "mcp-cli.js")],
    env: { PATH: env.PATH, EVAL_GH_FIXTURE: env.EVAL_GH_FIXTURE, GH_CONFIG_DIR: env.GH_CONFIG_DIR, DIFFNINJA_GRAMMAR_CACHE: env.DIFFNINJA_GRAMMAR_CACHE },
  } } }));
  const prompt = manifest.prompt
    .replace("{url}", `https://github.com/${item.repo}/pull/${item.pr}`)
    .replace("{clone}", cloneDir(options, item));
  const args = [
    "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--model", options.model, "--max-budget-usd", options.budget,
    "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "",
    "--permission-mode", "bypassPermissions", "--disallowedTools", "WebFetch", "WebSearch",
    "--no-session-persistence",
  ];
  const started = Date.now();
  return new Promise(done => {
    const child = spawn("claude", args, { cwd: cloneDir(options, item), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(createWriteStream(join(out, "transcript.jsonl")));
    child.stderr.pipe(createWriteStream(join(out, "stderr.log")));
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", code => {
      clearTimeout(timer);
      const result = { id: item.id, tag: options.tag, model: options.model, exit: code, wallMs: Date.now() - started, ...extract(join(out, "transcript.jsonl")) };
      writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${item.id}: ${result.finished ? "finished" : "NOT finished"}, ${result.comments.length} blocker(s), $${result.cost?.toFixed(2)}\n`);
      done(result);
    });
  });
}

/** A tool result's content is either a string or a list of text parts. */
function toolText(content) {
  if (Array.isArray(content)) return content.map(part => part.text ?? "").join("");
  return String(content ?? "");
}

/** What the model sent to diffninja, read from the stream-json transcript. */
export function extract(file) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const calls = new Map();
  const ordered = [];
  let final = null;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const parts = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === "assistant") {
      for (const part of parts.filter(part => part.type === "tool_use")) {
        const call = { name: part.name, input: part.input, ok: null, output: "" };
        calls.set(part.id, call);
        ordered.push(call);
      }
    } else if (event.type === "user") {
      for (const part of parts.filter(part => part.type === "tool_result")) {
        const call = calls.get(part.tool_use_id);
        if (call === undefined) continue;
        call.ok = part.is_error !== true;
        call.output = toolText(part.content);
      }
    } else if (event.type === "result") {
      final = event;
    }
  }
  const named = suffix => ordered.filter(call => call.name.endsWith(`__${suffix}`));
  const finish = named("finish_review");
  const accepted = finish.filter(call => call.ok);
  // The comments that stand are those of the last accepted finish_review or suggest_comments.
  const commentCalls = ordered.filter(call => call.ok && (call.name.endsWith("__finish_review") || call.name.endsWith("__suggest_comments")));
  const lastComments = commentCalls.at(-1)?.input?.comments ?? [];
  return {
    cost: final?.total_cost_usd ?? null,
    turns: final?.num_turns ?? null,
    durationMs: final?.duration_ms ?? null,
    subtype: final?.subtype ?? null,
    finished: accepted.length > 0,
    reviewDiffCalls: named("review_diff").map(call => ({ input: call.input, ok: call.ok, head: call.output.slice(0, 300) })),
    finishAttempts: finish.length,
    finishErrors: finish.filter(call => !call.ok).map(call => call.output.slice(0, 600)),
    summary: accepted.at(-1)?.input?.summary ?? null,
    comments: lastComments,
    commentsSentInFinish: accepted.at(-1)?.input?.comments?.length ?? null,
    suggestCalls: named("suggest_comments").length,
    bash: ordered.filter(call => call.name === "Bash").map(call => ({ command: call.input?.command ?? "", ok: call.ok, output: call.output.slice(0, 600) })),
    toolCounts: Object.fromEntries([...new Set(ordered.map(call => call.name))].map(name => [name, ordered.filter(call => call.name === name).length])),
    finalText: String(final?.result ?? ""),
  };
}

async function review(options) {
  const queue = [...selected(options)];
  const results = [];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) results.push(await reviewCase(options, item));
  };
  await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, worker));
  const cost = results.reduce((sum, result) => sum + (result.cost ?? 0), 0);
  process.stdout.write(`${results.length} review(s), total $${cost.toFixed(2)}\n`);
}

function summary(options) {
  const rows = [];
  for (const item of selected(options)) {
    const file = join(options.work, "runs", options.tag, item.id, "result.json");
    if (!existsSync(file)) continue;
    const result = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ id: item.id, label: item.label, finished: result.finished, blockers: result.comments.length, evidence: result.comments.map(comment => comment.evidence).join(","), turns: result.turns, cost: result.cost });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  const cost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  process.stdout.write(`${rows.length} result(s), total $${cost.toFixed(2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "prepare") {
    // The grammars a user would install, into a cache of the eval's own.
    execFileSync(process.execPath, [join(repoRoot, "dist", "review", "cli.js"), "grammars", "install"], {
      env: { ...process.env, DIFFNINJA_GRAMMAR_CACHE: join(options.work, "grammars") }, stdio: ["ignore", "ignore", "inherit"],
    });
    for (const item of selected(options)) prepareCase(options, item);
  } else if (options.command === "review") {
    await review(options);
  } else {
    summary(options);
  }
}
