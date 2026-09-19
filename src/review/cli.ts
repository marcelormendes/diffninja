#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reviewDiff } from "./service.js";
import { renderReview } from "./html.js";
import { serveConnected, type ConnectedSession } from "./connected.js";
import { ConnectedReview } from "./github.js";
import { detectPullRequest } from "./pr-input.js";

const help = `diffninja. Focused local PR review.

  diffninja --diff change.patch [--mock] [--out review.html]
  git diff main...HEAD | diffninja --stdin [--mock]
  diffninja --repo /path/to/repo --from main --to HEAD [--mock]
  diffninja <pr-url>          Connected, human-authored review of a GitHub PR.
  diffninja <pr-url> --static [--mock] [--out review.html]
  diffninja serve [<pr-url>] [--open]   Advanced connected-review alias.

A github.com pull request URL may appear anywhere: as an argument, inside pasted
text, or as --pr URL. It selects connected review, which reads the pull request
from GitHub and opens the review page automatically, unless --static or --export is given.
A pull request URL takes precedence over --diff, --stdin, and --from with --to.

Options:
  --pr URL       GitHub pull request URL to review. --pull-request is the long form.
  --static       Export a static report instead of serving a PR. Alias: --export.
  --diff PATH    Read a unified diff file.
  --stdin        Read pasted or piped unified diff text.
  --from REF     Base commit. Requires --to.
  --to REF       Head commit. Compares endpoints, not merge base.
  --repo PATH    Repository for git range. Defaults to current directory.
  --out PATH     HTML output. JSON is written next to it. Default: review.html
  --mock         Explicit offline demo, for exported reports. Connected review
                 always reads the pull request from GitHub.
  --open         Open the HTML report, or the connected review page, in the browser.
  --help         Show this help.

Live mode sends changed hunks and relevant call flows to TypeSafe.
Set TYPESAFE_API_KEY from https://console.typesafe.ai.
Reports contain source code. Keep them private. No merge approval is given.
`;

/**
 * The pull request named anywhere in the arguments, or undefined when none was
 * meant. Text that was clearly passed as an input but names no pull request is
 * an error, never a silent fallback to another mode.
 */
function pullRequestFrom(raw: readonly string[], explicit: readonly (string | undefined)[], positionals: readonly string[]): string | undefined {
  const url = detectPullRequest(raw);
  if (url !== undefined) return url;
  const flagged = explicit.find(value => value !== undefined);
  if (flagged !== undefined) {
    // An empty value is a different mistake from a value that names no pull
    // request; `Got: ` with nothing after it would read like a bug.
    const detail = flagged.trim() === "" ? "The value was empty." : `Got: ${flagged}`;
    throw new Error(`--pr needs a GitHub pull request URL, such as https://github.com/owner/repo/pull/123. ${detail}`);
  }
  if (positionals.length > 0) throw new Error(`No GitHub pull request found in: ${positionals.join(" ")}. Pass a URL such as https://github.com/owner/repo/pull/123.`);
  return undefined;
}

/** Close the connected session when the user stops diffninja. */
function onShutdown(server: ConnectedSession["server"]): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}

/** Connected review of one pull request: bind it first, then serve the page. */
async function servePullRequest(url: string): Promise<void> {
  const review = new ConnectedReview();
  await review.load(url);
  const session = await serveConnected(review);
  console.log(`Connected review: ${session.url}\nLoaded ${url}. Stop with Ctrl+C.`);
  onShutdown(session.server);
  await openInBrowser(session.url);
}

async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    const args = process.argv.slice(3);
    const { values, positionals } = parseArgs({ args, options: {
      open: { type: "boolean" }, help: { type: "boolean" }, pr: { type: "string" }, "pull-request": { type: "string" },
      static: { type: "boolean" }, export: { type: "boolean" },
    }, strict: true, allowPositionals: true });
    if (values.help) { console.log(help); return; }
    if (values.static || values.export) throw new Error("serve answers connected review; export a report with diffninja <pr-url> --static instead.");
    const url = pullRequestFrom(args, [values.pr, values["pull-request"]], positionals);
    if (url !== undefined) { await servePullRequest(url); return; }
    const { server, url: sessionUrl } = await serveConnected();
    console.log(`Connected review: ${sessionUrl}\nOpen an explicit github.com PR URL in the browser. Stop with Ctrl+C.`);
    onShutdown(server);
    if (values.open) await openInBrowser(sessionUrl);
    return;
  }
  const args = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args, options: {
    diff: { type: "string" }, stdin: { type: "boolean" }, from: { type: "string" }, to: { type: "string" },
    repo: { type: "string" }, out: { type: "string" }, mock: { type: "boolean" }, open: { type: "boolean" }, help: { type: "boolean" },
    pr: { type: "string" }, "pull-request": { type: "string" }, static: { type: "boolean" }, export: { type: "boolean" },
  }, strict: true, allowPositionals: true });
  if (values.help) { console.log(help); return; }
  const prUrl = pullRequestFrom(args, [values.pr, values["pull-request"]], positionals);
  const wantsExport = values.static === true || values.export === true;
  let input: Parameters<typeof reviewDiff>[0];
  if (prUrl !== undefined && !wantsExport) {
    // The pull request wins over --diff, --stdin, and --from/--to, and no report
    // is written, so an --out that would stay empty is refused rather than ignored.
    if (values.out !== undefined) throw new Error("Connected review writes no report; add --static to export one with --out.");
    if (values.mock) console.error("diffninja: connected review always reads the pull request from GitHub; --mock applies only to --static exports.");
    await servePullRequest(prUrl);
    return;
  }
  if (prUrl !== undefined) {
    // The export runs on GitHub's canonical diff, never on mock text and never
    // on a locally read patch, so an exported report and the served review see
    // exactly the same bytes.
    const review = new ConnectedReview();
    await review.load(prUrl);
    input = { diff: review.getDiff(), source: prUrl };
  } else {
    const range = values.from !== undefined || values.to !== undefined;
    if (Number(values.diff !== undefined) + Number(!!values.stdin) + Number(range) !== 1) throw new Error("Choose exactly one input: --diff, --stdin, or --from with --to. Use --help.");
    if (range && (!values.from || !values.to)) throw new Error("Git range requires both --from and --to.");
    if (range) {
      input = { repo: resolve(values.repo ?? process.cwd()), from: values.from!, to: values.to! };
    } else {
      let text: string;
      if (values.stdin) {
        process.stdin.setEncoding("utf8");
        const chunks: string[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        text = chunks.join("");
      } else {
        text = await readFile(values.diff!, "utf8");
      }
      input = { diff: text, source: values.stdin ? "Standard input" : values.diff! };
    }
  }
  const report = await reviewDiff(input, { mock: values.mock });
  const output = resolve(values.out ?? "review.html");
  const jsonOutput = output + ".json";
  if (values.diff && [output, jsonOutput].includes(resolve(values.diff))) throw new Error("Output must not overwrite the input diff.");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderReview(report), { mode: 0o600 });
  await writeFile(jsonOutput, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const status of ["attention", "uncertain", "low", "passed"] as const) {
    console.log(`${status}: ${report.items.filter(item => item.status === status).length}`);
  }
  console.log(`${values.mock ? "MOCK DEMO. No live judgments." : "Live Jev review."} API calls: ${report.modelCalls}`);
  console.log(pathToFileURL(output).href);
  console.log(`JSON: ${jsonOutput}`);
  if (values.open) {
    await openInBrowser(pathToFileURL(output).href);
  }
}

/** Open a URL in the default browser. Best effort: logs instead of throwing. */
function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve) => {
    execFile(opener, args, { timeout: 10_000, windowsHide: true }, (error) => {
      if (error) {
        console.error(`diffninja: could not open the browser (${error.message})`);
      }
      resolve();
    });
  });
}

main().catch(error => { console.error(`diffninja: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
