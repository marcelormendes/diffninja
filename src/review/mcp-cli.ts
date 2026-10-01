#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { updateLookupFromEnv } from "./update-check.js";

/**
 * What to say when the server cannot start because the native tree-sitter
 * parser or a bundled grammar does not load, or undefined for any other error.
 * The server imports the parser as it starts, so this is the one place the
 * failure can be explained; the repair is the package's own postinstall script,
 * which npm 12 does not run unless it is allowed.
 */
function nativeLoadHint(message: string): string | undefined {
  if (!message.includes("tree-sitter")) return undefined;
  const script = fileURLToPath(new URL("../../scripts/ensure-native-grammar.mjs", import.meta.url));
  return `the native tree-sitter parser does not load on this machine (${message.split("\n")[0]}). ` +
    `Rebuild it with \`node ${JSON.stringify(script)}\` (needs a C/C++ toolchain and Python), or run \`npx -y diffninja@latest setup\` again.`;
}

try {
  if (process.argv.length > 2) throw new Error("diffninja-mcp accepts no arguments. Configure it as a stdio MCP server; pass inputs to review_diff.");
  // Update notices are off unless DIFFNINJA_UPDATE_CHECK=1; nothing else asks the network for anything.
  const latestVersion = updateLookupFromEnv();
  // Imported here rather than at the top so that a parser that does not load is reported below with its fix.
  const { createReviewServer } = await import("./mcp.js");
  const server = createReviewServer(latestVersion === undefined ? {} : { latestVersion });
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(`diffninja-mcp: ${nativeLoadHint(message) ?? message}`);
  process.exitCode = 1;
}
