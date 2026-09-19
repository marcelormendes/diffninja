import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function connectReview(): Promise<Client> {
  const server = createReviewServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "diffninja-mcp-test", version: "0.1.0" });
  // Both ends must start together: an initialize request sent before the server
  // transport starts would be queued with nothing to flush it.
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function review(client: Client, args: NonNullable<CallToolRequest["params"]["arguments"]>) {
  return CallToolResultSchema.parse(await client.callTool({ name: "review_diff", arguments: args }));
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
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["diff", "from", "mock", "repo", "to"]);
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
