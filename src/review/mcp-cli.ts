#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReviewServer } from "./mcp.js";

try {
  if (process.argv.length > 2) throw new Error("diffninja-mcp accepts no arguments. Configure it as a stdio MCP server; pass inputs to review_diff.");
  await createReviewServer().connect(new StdioServerTransport());
} catch (error) {
  console.error(`diffninja-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
