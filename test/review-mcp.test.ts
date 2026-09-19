import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";
import { createReviewServer } from "../src/review/mcp.js";
import type { ReviewReport, ReviewStatus } from "../src/review/types.js";

const patch = readFileSync(resolve("examples/review/checkout.patch"), "utf8");
const GIT_ENV = ["-c", "user.name=MCP Test", "-c", "user.email=mcp@example.invalid"];
const STATUS_RANK = { attention: 0, uncertain: 1, low: 2, passed: 3 } satisfies Record<ReviewStatus, number>;

/** Every opened pair is torn down after each test so no transport or client leaks. */
const closers: Array<() => Promise<void>> = [];
const originalFetch = globalThis.fetch;
let fetchAttempts: string[] = [];

/**
 * Provenance requests leave the process; mock runs must not. Any attempt is
 * recorded and fails the request, so a violation surfaces as a test failure
 * rather than as a slow network call.
 */
function blockNetwork(): void {
  fetchAttempts = [];
  globalThis.fetch = async input => {
    fetchAttempts.push(String(input));
    throw new Error("network access is forbidden while a live call must not happen");
  };
}

interface ReviewPair { client: Client; close: () => Promise<void> }

async function openReview(): Promise<ReviewPair> {
  const server = createReviewServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "diffninja-mcp-test", version: "0.1.0" });
  // Both ends must start together: an initialize request sent before the server
  // transport starts would be queued with nothing to flush it.
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
  };
  closers.push(close);
  return { client, close };
}

async function connectReview(): Promise<Client> {
  return (await openReview()).client;
}

async function review(client: Client, args: NonNullable<CallToolRequest["params"]["arguments"]>) {
  return CallToolResultSchema.parse(await client.callTool({ name: "review_diff", arguments: args }));
}

/**
 * The served page, or null when nothing is listening on that loopback address.
 * Uses node:http so a blocked global fetch still leaves the local page readable.
 */
function loopback(url: string): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    const request = get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", () => resolve(null));
    request.setTimeout(3_000, () => { request.destroy(); resolve(null); });
  });
}

function textOf(result: CallToolResult): string {
  return result.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function reportOf(result: CallToolResult): ReviewReport {
  // SAFETY: this payload is produced by our connected review server; tests below
  // assert its report fields and equality with the structured protocol payload.
  return JSON.parse(textOf(result)) as ReviewReport;
}

async function withMissingApiKey(run: () => Promise<void>): Promise<void> {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (closers.length > 0) await closers.pop()!();
});

describe("review_diff discovery", () => {
  test("a real client sees one review_diff tool with the documented arguments", async () => {
    const client = await connectReview();
    const listed = await client.listTools();

    expect(listed.tools.map(tool => tool.name)).toEqual(["review_diff"]);
    const tool = listed.tools[0];
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(false);
    const schema = tool.inputSchema;
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["diff", "from", "input", "mock", "pr", "repo", "to"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("review_diff over the MCP protocol", () => {
  test("ranks the checkout patch in mock mode and touches no network", async () => {
    blockNetwork();
    const client = await connectReview();

    const result = await review(client, { diff: patch, mock: true });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.mode).toBe("mock");
    expect(report.modelCalls).toBe(0);
    expect(report.items).toHaveLength(5);
    expect(report.warnings.join("\n")).toMatch(/mock mode/i);
    expect(report.warnings.join("\n")).toMatch(/no API call/i);

    // The text payload and the structured payload are the same report.
    expect(result.structuredContent).toEqual(report);

    // Ranked: attention first, higher priority before lower inside a status.
    const rank = report.items.map(item => STATUS_RANK[item.status]);
    expect(rank).toEqual([...rank].sort((left, right) => left - right));
    for (const [index, item] of report.items.entries()) {
      expect(item.priority).toBeGreaterThanOrEqual(0);
      expect(item.priority).toBeLessThanOrEqual(100);
      expect(item.reasons.length).toBeGreaterThan(0);
      if (index > 0) {
        const previous = report.items[index - 1];
        if (STATUS_RANK[previous.status] === STATUS_RANK[item.status]) {
          expect(previous.priority).toBeGreaterThanOrEqual(item.priority);
        }
      }
    }
    expect(report.items[0]).toMatchObject({ file: "src/auth/session.ts", status: "attention" });
    expect(report.items.at(-1)).toMatchObject({ file: "docs/review-notes.txt", status: "passed" });
    // Every judged hunk is labeled as a fixture; the deterministic pass is not judged at all.
    const judged = report.items.filter(item => item.judgment !== undefined);
    expect(judged).toHaveLength(4);
    expect(judged.every(item => item.reasons.some(reason => /mock mode/i.test(reason)))).toBe(true);
    expect(report.items.find(item => item.status === "passed")?.judgment).toBeUndefined();

    expect(fetchAttempts).toEqual([]);
  });

  test("accepts an empty diff as no changes instead of failing", async () => {
    const client = await connectReview();
    const result = await review(client, { diff: "", mock: true });

    expect(result.isError).toBeFalsy();
    const report = reportOf(result);
    expect(report.items).toEqual([]);
    expect(report.modelCalls).toBe(0);
    expect(report.mode).toBe("mock");
    expect(report.callFlows).toEqual([]);
    expect(report.callFlowAvailability).toBe("needs-git-range");
  });

  test("rejects unusable requests with named tool errors and no model call", async () => {
    blockNetwork();
    const client = await connectReview();
    const cases: Array<{ args: NonNullable<CallToolRequest["params"]["arguments"]>; expected: RegExp }> = [
      { args: { diff: patch, from: "HEAD~1", to: "HEAD" }, expected: /exactly one input/i },
      { args: { from: "HEAD~1" }, expected: /both from and to/i },
      { args: { repo: "/tmp", diff: patch }, expected: /only supported with a git range/i },
      { args: { repo: "relative/repo", from: "HEAD~1", to: "HEAD" }, expected: /absolute repo path/i },
      { args: { from: "HEAD~1", to: "HEAD" }, expected: /absolute repo path/i },
      { args: { diff: "this is not a patch" }, expected: /unified diff/i },
      {
        args: { diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const a = 1;" },
        expected: /truncated hunk/i,
      },
    ];

    for (const { args, expected } of cases) {
      const result = await review(client, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toMatch(expected);
      expect(result.structuredContent).toBeUndefined();
    }
    expect(fetchAttempts).toEqual([]);
  });

  test("refuses an apiKey argument and never echoes its value", async () => {
    blockNetwork();
    const client = await connectReview();

    const result = await review(client, { diff: patch, mock: true, apiKey: "forbidden-test-value" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("review_diff");
    expect(textOf(result)).toMatch(/unrecognized key|invalid arguments/i);
    expect(textOf(result)).not.toContain("forbidden-test-value");
    expect(fetchAttempts).toEqual([]);
  });

  test("fails closed when live mode has no credentials, without a network attempt", async () => {
    await withMissingApiKey(async () => {
      blockNetwork();
      const client = await connectReview();

      const result = await review(client, { diff: patch });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("TYPESAFE_API_KEY");
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("ranks a git range and keeps the removed authorize call in the call flow", async () => {
    blockNetwork();
    const dir = mkdtempSync(join(tmpdir(), "diffninja-mcp-git-"));
    try {
      const base = "export function checkout() { authorize(); charge(); }\nfunction authorize() {}\nfunction charge() {}\n";
      const head = "export function checkout() { charge(); }\nfunction authorize() {}\nfunction charge() {}\n";
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), base);
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", [...GIT_ENV, "commit", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "checkout.ts"), head);
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", [...GIT_ENV, "commit", "-m", "head"], { cwd: dir });
      const before = readdirSync(dir).sort();

      const client = await connectReview();
      const result = await review(client, { repo: dir, from: "HEAD~1", to: "HEAD", mock: true });

      expect(result.isError).toBeFalsy();
      const report = reportOf(result);
      expect(report.mode).toBe("mock");
      expect(report.modelCalls).toBe(0);
      expect(report.source).toContain("HEAD~1 → HEAD");
      expect(report.callFlow.join("\n")).toContain("authorize");
      expect(report.callFlow.join("\n")).toContain("charge");
      expect(report.warnings.join("\n")).toMatch(/call flows are syntactic/i);
      expect(report.items).toHaveLength(1);
      expect(report.items[0].file).toBe("checkout.ts");
      expect(report.items[0].callFlow?.join("\n")).toContain("authorize");
      expect(report.callFlowAvailability).toBe("available");
      expect(report.callFlows.map(entry => entry.file)).toEqual(["checkout.ts"]);
      expect(report.callFlows[0].trees[0]).toMatchObject({ key: "checkout", status: "changed", file: "checkout.ts" });

      // Reviewing a range writes no report files next to the repository.
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(fetchAttempts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Connected pull request review: a link in any input starts a live session. */
/* ------------------------------------------------------------------------ */

const GH_URL = "https://github.com/octocat/hello/pull/7";
const GH_PATCH = "@@ -1,3 +1,4 @@ function run()\n keep()\n-gone()\n+added()\n+more()\n last()";
/** The canonical diff GitHub serves for the fixture pull request. */
const GH_DIFF = [
  "diff --git a/app.ts b/app.ts",
  "index 1111111..2222222 100644",
  "--- a/app.ts",
  "+++ b/app.ts",
  ...GH_PATCH.split("\n"),
  "",
].join("\n");
const GH_METADATA = {
  url: GH_URL,
  id: "PR_kwDOAAAB",
  number: 7,
  state: "OPEN",
  baseRefOid: "1".repeat(40),
  headRefOid: "2".repeat(40),
  isCrossRepository: false,
  headRepository: { id: "R_1", name: "hello", nameWithOwner: "octocat/hello" },
  headRepositoryOwner: { id: "O_1", login: "octocat" },
  baseRefName: "main",
  headRefName: "feature",
};
const GH_FILES = [
  { filename: "app.ts", previous_filename: null, status: "modified", additions: 1, deletions: 1, patch: GH_PATCH },
];

/**
 * A real `gh` on PATH, scripted per pull request. Connected review builds its
 * own gh runner, so GitHub is faked where that runner looks, not inside the MCP
 * server: the load, the diff validation, and the session are all real. The
 * fixture answer is the pull request its own argv names, so one script serves
 * several pull requests and a page bound to the wrong one is visible. Every
 * argv is appended to GH_TEST_LOG; GH_TEST_FAIL and GH_TEST_DELAY_MS script a
 * refusal and a slow answer.
 */
const GH_SCRIPT = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (process.env.GH_TEST_LOG) appendFileSync(process.env.GH_TEST_LOG, args.join(" ") + "\\n");
if (process.env.GH_TEST_FAIL === "1" && args[0] === "pr") {
  process.stderr.write("gh: Bad credentials (HTTP 401)\\n");
  process.exit(1);
}
const requested = args.map(String).find(argument => argument.startsWith("https://github.com/")) ?? ${JSON.stringify(GH_URL)};
const number = Number(/(\\d+)$/.exec(requested.split(/[?#]/)[0])?.[1] ?? 7);
const metadata = { ...${JSON.stringify(GH_METADATA)}, url: requested, number };
const files = ${JSON.stringify(GH_FILES)};
const diff = ${JSON.stringify(GH_DIFF)};
function respond() {
  const last = String(args[args.length - 1]);
  if (args[0] === "--version") process.stdout.write("gh version 2.101.0 (2026-01-01)\\nhttps://github.com/cli/cli/releases\\n");
  else if (last === "user") process.stdout.write(JSON.stringify({ login: "octocat", id: 42, name: "Test" }));
  else if (args[0] === "pr") process.stdout.write(JSON.stringify(metadata));
  else if (last.endsWith("/files?per_page=100")) process.stdout.write(JSON.stringify(files));
  else process.stdout.write(diff);
}
const delay = Number(process.env.GH_TEST_DELAY_MS ?? "0");
if (delay > 0 && args[0] === "pr") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
respond();
`;

interface FakeGh {
  /** One line per gh invocation the review actually ran. */
  log: string;
  fail: () => void;
  slow: (milliseconds: number) => void;
}

interface ConnectedPayload {
  mode: string;
  url: string;
  pr: string;
  snapshot: ConnectedSnapshot;
}

function ghCalls(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(line => line !== "");
}

/** Run `body` with a scripted gh on PATH, restoring the environment afterwards. */
async function withFakeGh(body: (gh: FakeGh) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "diffninja-mcp-gh-"));
  const log = join(dir, "calls.log");
  const saved = { path: process.env.PATH, log: process.env.GH_TEST_LOG, fail: process.env.GH_TEST_FAIL, delay: process.env.GH_TEST_DELAY_MS };
  try {
    writeFileSync(join(dir, "gh"), GH_SCRIPT, { mode: 0o755 });
    process.env.PATH = `${dir}${delimiter}${saved.path ?? ""}`;
    process.env.GH_TEST_LOG = log;
    delete process.env.GH_TEST_FAIL;
    delete process.env.GH_TEST_DELAY_MS;
    await body({
      log,
      fail: () => { process.env.GH_TEST_FAIL = "1"; },
      slow: milliseconds => { process.env.GH_TEST_DELAY_MS = String(milliseconds); },
    });
  } finally {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.log === undefined) delete process.env.GH_TEST_LOG; else process.env.GH_TEST_LOG = saved.log;
    if (saved.fail === undefined) delete process.env.GH_TEST_FAIL; else process.env.GH_TEST_FAIL = saved.fail;
    if (saved.delay === undefined) delete process.env.GH_TEST_DELAY_MS; else process.env.GH_TEST_DELAY_MS = saved.delay;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Loopback listeners this process holds. Node releases a closed handle's record
 * two check-phase turns later, so the count is read after letting those run:
 * a session that leaked a listener still shows up, one that closed does not.
 */
async function listeningServers(): Promise<number> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  return process.getActiveResourcesInfo().filter(entry => entry === "TCPServerWrap").length;
}

/** Child processes this process holds right now; the scripted gh shows up here. */
function runningChildren(): number {
  return process.getActiveResourcesInfo().filter(entry => entry === "ProcessWrap").length;
}

/** Wait for `condition`, letting the event loop run between checks and never sleeping. */
async function awaitCondition(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200_000 && !condition(); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (!condition()) throw new Error(`Timed out waiting for ${what}.`);
}

/** The loaded state a served session reports, read through its own loopback API. */
async function connectedState(url: string): Promise<{ status: string; snapshot: ConnectedSnapshot } | null> {
  const response = await loopback(url + "api/state");
  if (response === null || response.status !== 200) return null;
  // SAFETY: this loopback server answers with the connected state it serves to its own page.
  return JSON.parse(response.body) as { status: string; snapshot: ConnectedSnapshot };
}

function connectedOf(result: CallToolResult): ConnectedPayload {
  // SAFETY: this payload is produced by our connected review server; the tests
  // below assert its fields and equality with the structured protocol payload.
  return JSON.parse(textOf(result)) as ConnectedPayload;
}

interface JsonRpcContent { type: string; text: string }
interface ToolResult { content?: JsonRpcContent[]; isError?: boolean }
/** An inbound JSON-RPC response; notifications the server sends carry no id and are ignored. */
interface JsonRpcMessage {
  id?: number;
  result?: ToolResult;
  error?: { code: number; message: string };
}
interface InitializeParams { protocolVersion: string; capabilities: Record<string, never>; clientInfo: { name: string; version: string } }
interface ReviewCallParams { name: string; arguments: { pr: string } }

/**
 * A raw stdio MCP peer: one JSON-RPC message per line, exactly as the transport
 * frames it. Driving the real binary this way means any stray diagnostic on
 * stdout would land in `noise` instead of the protocol, and the child's exit is
 * observed directly, so a page that outlives the connection fails the test.
 */
class StdioReviewPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (message: JsonRpcMessage) => void>();
  readonly noise: string[] = [];
  stderr = "";
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ["--import", "tsx", resolve("src/review/mcp-cli.ts")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  async initialize(): Promise<void> {
    const params: InitializeParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diffninja-stdio-test", version: "0.1.0" } };
    await this.request("initialize", params);
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async callReview(): Promise<ConnectedPayload> {
    const message = await this.request("tools/call", { name: "review_diff", arguments: { pr: GH_URL } });
    const error = message.error;
    if (error !== undefined) throw new Error(`tools/call failed: ${error.message}`);
    const text = (message.result?.content ?? []).map(part => part.text).join("\n");
    // SAFETY: the review server answers tools/call with a connected payload in its text content.
    return JSON.parse(text) as ConnectedPayload;
  }

  /** Close the client end of the pipe, the way a finishing MCP client does. */
  hangUp(): void {
    this.child.stdin.end();
  }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  private request(method: string, params: InitializeParams | ReviewCallParams): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const pending = new Promise<JsonRpcMessage>(resolve => { this.waiting.set(id, resolve); });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return pending;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") this.accept(line);
    }
  }

  private accept(line: string): void {
    let message: JsonRpcMessage;
    try {
      // SAFETY: the stdio transport writes one serialized JSON-RPC message per line.
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Anything else on stdout is a diagnostic that would corrupt a real client.
      this.noise.push(line);
      return;
    }
    const id = message.id;
    if (id === undefined) return;
    const waiting = this.waiting.get(id);
    if (waiting === undefined) return;
    this.waiting.delete(id);
    waiting(message);
  }
}

describe("review_diff connected pull request mode", () => {
  test("a pull request link returns a loaded loopback review page", async () => {
    await withFakeGh(async ({ log }) => {
      blockNetwork();
      const client = await connectReview();

      const result = await review(client, { pr: GH_URL, diff: patch, repo: "/ignored-local-repo", mock: true });

      expect(result.isError).toBeFalsy();
      const payload = connectedOf(result);
      expect(result.structuredContent).toEqual(payload);
      expect(payload).toMatchObject({ mode: "connected", pr: GH_URL });
      expect(payload.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(payload.snapshot).toMatchObject({ url: GH_URL, owner: "octocat", repo: "hello", number: 7, state: "OPEN" });
      expect(payload.snapshot.unavailableReason).toBeUndefined();
      expect(payload.snapshot.lines).toEqual([
        { path: "app.ts", line: 1, side: "RIGHT", text: "keep()", kind: "context" },
        { path: "app.ts", line: 2, side: "LEFT", text: "gone()", kind: "delete" },
        { path: "app.ts", line: 2, side: "RIGHT", text: "added()", kind: "add" },
        { path: "app.ts", line: 3, side: "RIGHT", text: "more()", kind: "add" },
        { path: "app.ts", line: 4, side: "RIGHT", text: "last()", kind: "context" },
      ]);

      // The page is bound to that pull request, not an empty lister.
      const page = await loopback(payload.url);
      expect(page?.status).toBe(200);
      expect(page?.body).toContain("<title>diffninja connected review</title>");
      expect(await connectedState(payload.url)).toMatchObject({ status: "ready", snapshot: { number: 7 } });

      // The load went through the real gh runner with the link it was given, and
      // connected review never sends source anywhere of its own.
      expect(ghCalls(log).some(line => line.startsWith(`pr view ${GH_URL} --json`))).toBe(true);
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("free text and diff fields carrying the same link reuse one live session", async () => {
    await withFakeGh(async ({ log }) => {
      blockNetwork();
      const client = await connectReview();

      const fromText = connectedOf(await review(client, { input: `Please review ${GH_URL} today.` }));
      const loads = ghCalls(log).filter(line => line.startsWith("pr view")).length;
      // A link with a trailing path and fragment still names the same review.
      const fromDiff = connectedOf(await review(client, { diff: `${GH_URL}/files#discussion_r1` }));

      expect(fromText).toMatchObject({ mode: "connected", pr: GH_URL });
      expect(fromDiff.pr).toBe(GH_URL);
      expect(fromDiff.url).toBe(fromText.url);
      expect((await loopback(fromText.url))?.status).toBe(200);
      // One load served both calls: the session stays alive for the connection.
      expect(ghCalls(log).filter(line => line.startsWith("pr view")).length).toBe(loads);
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("each pull request keeps its own bound page on one connection", async () => {
    await withFakeGh(async ({ log }) => {
      blockNetwork();
      const client = await connectReview();
      const otherUrl = GH_URL.replace("/pull/7", "/pull/8");

      const first = connectedOf(await review(client, { pr: GH_URL }));
      const second = connectedOf(await review(client, { pr: otherUrl }));

      // A second pull request is loaded and served on its own page: answering it
      // with the first page would put the wrong diff in front of the reviewer.
      expect(second.pr).toBe(otherUrl);
      expect(second.url).not.toBe(first.url);
      expect((await connectedState(first.url))?.snapshot.number).toBe(7);
      expect((await connectedState(second.url))?.snapshot.number).toBe(8);
      expect((await loopback(first.url))?.status).toBe(200);
      expect((await loopback(second.url))?.status).toBe(200);
      expect(ghCalls(log).some(line => line.startsWith(`pr view ${otherUrl} --json`))).toBe(true);

      // Asking for it again reuses that page instead of loading it twice.
      const loads = ghCalls(log).filter(line => line.startsWith("pr view")).length;
      const repeat = connectedOf(await review(client, { pr: otherUrl }));
      expect(repeat.url).toBe(second.url);
      expect(ghCalls(log).filter(line => line.startsWith("pr view")).length).toBe(loads);
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("closing the MCP connection closes every served page", async () => {
    await withFakeGh(async () => {
      blockNetwork();
      const baseline = await listeningServers();
      const { client, close } = await openReview();
      const payload = connectedOf(await review(client, { pr: GH_URL }));
      expect((await loopback(payload.url))?.status).toBe(200);
      expect(await listeningServers()).toBeGreaterThan(baseline);

      await close();

      expect(await listeningServers()).toBe(baseline);
      expect(await loopback(payload.url)).toBeNull();
      expect(await connectedState(payload.url)).toBeNull();
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("shutdown during an in-flight load leaves no listener behind", async () => {
    await withFakeGh(async ({ slow }) => {
      blockNetwork();
      slow(300);
      const idleChildren = runningChildren();
      const baseline = await listeningServers();
      const { client, close } = await openReview();

      // Wait for the load to reach the scripted gh, which is still blocked, so the
      // connection closes while that load is genuinely in flight.
      const pending = review(client, { pr: GH_URL }).then(
        result => ({ result, failure: null }),
        (failure: Error) => ({ result: null, failure }),
      );
      await awaitCondition(() => runningChildren() > idleChildren, "the gh invocation to start");
      await close();

      // Either the closed connection swallows the answer or the load is refused;
      // neither may leave a servable page behind.
      const outcome = await pending;
      if (outcome.result !== null) {
        expect(outcome.result.isError).toBe(true);
        expect(textOf(outcome.result)).toMatch(/shutting down/i);
      }
      expect(await listeningServers()).toBe(baseline);
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("rejects malformed, conflicting, and mixed pull request inputs without running gh", async () => {
    await withFakeGh(async ({ log }) => {
      blockNetwork();
      const client = await connectReview();
      const cases: Array<{ args: NonNullable<CallToolRequest["params"]["arguments"]>; expected: RegExp }> = [
        { args: { input: "No pull request in this message." }, expected: /pull request link/i },
        { args: { pr: "https://github.com/octocat/hello/pull/7x" }, expected: /pull request/i },
        { args: { input: `${GH_URL} and https://github.com/octocat/hello/pull/8` }, expected: /pull request/i },
      ];

      for (const { args, expected } of cases) {
        const result = await review(client, args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(textOf(result)).toMatch(expected);
        expect(result.structuredContent).toBeUndefined();
      }
      expect(ghCalls(log)).toEqual([]);
      expect(fetchAttempts).toEqual([]);
    });
  });

  test("reports a refused load and opens no listener", async () => {
    await withFakeGh(async ({ fail }) => {
      blockNetwork();
      fail();
      const baseline = await listeningServers();
      const client = await connectReview();

      const result = await review(client, { pr: GH_URL });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not authenticated for github\.com/);
      expect(result.structuredContent).toBeUndefined();
      expect(await listeningServers()).toBe(baseline);
      expect(fetchAttempts).toEqual([]);
    });
  });

  // A leaked loopback listener would keep the child alive past its client, so
  // the whole test is bounded by vitest's own timeout rather than a clock wait.
  test("the stdio server serves the page and exits when the client hangs up", async () => {
    await withFakeGh(async () => {
      const peer = new StdioReviewPeer(process.env);
      try {
        await peer.initialize();
        const payload = await peer.callReview();
        expect(payload.mode).toBe("connected");
        expect((await loopback(payload.url))?.status).toBe(200);

        peer.hangUp();
        const exit = await peer.exit;

        expect(exit).toEqual({ code: 0, signal: null });
        expect(peer.noise).toEqual([]);
        expect(peer.stderr).toBe("");
        expect(await loopback(payload.url)).toBeNull();
      } finally {
        peer.kill();
      }
    });
  }, 30_000);
});
