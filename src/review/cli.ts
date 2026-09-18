#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reviewDiff } from "./service.js";
import { renderReview } from "./html.js";

const help = `diffninja. Focused local PR review.

  diffninja --diff change.patch [--mock] [--out review.html]
  git diff main...HEAD | diffninja --stdin [--mock]
  diffninja --repo /path/to/repo --from main --to HEAD [--mock]

Options:
  --diff PATH    Read a unified diff file.
  --stdin        Read pasted or piped unified diff text.
  --from REF     Base commit. Requires --to.
  --to REF       Head commit. Compares endpoints, not merge base.
  --repo PATH    Repository for git range. Defaults to current directory.
  --out PATH     HTML output. JSON is written next to it. Default: review.html
  --mock         Explicit offline demo. Not a real Jev review.
  --help         Show this help.

Live mode sends changed hunks and relevant call flows to TypeSafe.
Set TYPESAFE_API_KEY from https://console.typesafe.ai.
Reports contain source code. Keep them private. No merge approval is given.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    diff: { type: "string" }, stdin: { type: "boolean" }, from: { type: "string" }, to: { type: "string" },
    repo: { type: "string" }, out: { type: "string" }, mock: { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(help); return; }
  const range = values.from !== undefined || values.to !== undefined;
  if (Number(values.diff !== undefined) + Number(!!values.stdin) + Number(range) !== 1) throw new Error("Choose exactly one input: --diff, --stdin, or --from with --to. Use --help.");
  if (range && (!values.from || !values.to)) throw new Error("Git range requires both --from and --to.");
  let input: Parameters<typeof reviewDiff>[0];
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
}

main().catch(error => { console.error(`diffninja: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
