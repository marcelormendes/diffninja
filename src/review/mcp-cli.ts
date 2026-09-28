#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReviewServer } from "./mcp.js";
import { registryLatest } from "./update-check.js";

try {
  if (process.argv.length > 2) throw new Error("diffninja-mcp accepts no arguments. Configure it as a stdio MCP server; pass inputs to review_diff.");
  // The one thing read from the environment: npm's own opt-out for update notices.
  const server = createReviewServer(process.env["NO_UPDATE_NOTIFIER"] === undefined ? { latestVersion: registryLatest } : {});
  // Closing the connection is what closes its connected review pages, and this
  // transport cannot tell that the client hung up its end of the pipe, so EOF
  // here is what ends the session. A signal still terminates the process the
  // usual way, which takes the listener down with it.
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch(() => {});
  };
  process.stdin.once("end", shutdown).once("close", shutdown);
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`diffninja-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
