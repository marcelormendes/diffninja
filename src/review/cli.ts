#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runSetup, setupHelp } from "./setup.js";

/**
 * diffninja runs inside an agent CLI through its MCP server; this command only
 * registers that server. Reviews are requested from the agent, which calls the
 * `review_diff` tool and, for a pull request link, returns the connected review
 * page. There is no terminal review path, so any other invocation says how to
 * get one instead of guessing what was meant.
 */
const help = `diffninja. Pull request review inside your coding agent.

  diffninja setup [--cli claude,codex,omp,pi] [--uninstall] [--dry-run] [--no-install]
                  Register the diffninja MCP server on every detected agent CLI.
  diffninja --help

After setup, ask your agent to review a GitHub pull request link, a diff, or a git
range. The agent calls the review_diff tool; a pull request link opens a connected
review page where you read the change, comment inline, and submit the review
yourself. diffninja has no terminal review mode.
`;

const NO_TERMINAL_REVIEW =
  "diffninja reviews run inside an agent CLI (Claude Code, Codex, pi, ...) through MCP. " +
  "Run `diffninja setup` to register it, then ask your agent to review a pull request link, a diff, or a git range. " +
  "See `diffninja --help`.";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(help);
    return;
  }
  if (command !== "setup") throw new Error(NO_TERMINAL_REVIEW);
  const { values, positionals } = parseArgs({ args, options: {
    cli: { type: "string" }, uninstall: { type: "boolean" },
    "dry-run": { type: "boolean" }, "no-install": { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: true });
  if (values.help) { console.log(setupHelp); return; }
  if (positionals.length > 0) throw new Error("setup takes no positional arguments. Use --help.");
  await runSetup({
    clis: values.cli === undefined ? undefined : values.cli.split(",").map((part) => part.trim()).filter((part) => part !== ""),
    uninstall: values.uninstall === true,
    dryRun: values["dry-run"] === true,
    noInstall: values["no-install"] === true,
  });
}

main().catch(error => { console.error(`diffninja: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
