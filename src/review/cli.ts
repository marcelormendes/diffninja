#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDiff } from "../run.js";
import type { DiffNode } from "../types.js";
import { parseDiff, gitDiff } from "./input.js";
import type { GitDiffInput } from "./input.js";
import { reviewUnits } from "./pipeline.js";
import { renderReview } from "./html.js";
import type { ReviewReport } from "./types.js";

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

function touches(node: DiffNode, file: string): boolean {
  return node.file === file || node.children.some(child => touches(child, file));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    diff: { type: "string" }, stdin: { type: "boolean" }, from: { type: "string" }, to: { type: "string" },
    repo: { type: "string" }, out: { type: "string" }, mock: { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(help); return; }
  const range = values.from !== undefined || values.to !== undefined;
  if (Number(values.diff !== undefined) + Number(!!values.stdin) + Number(range) !== 1) throw new Error("Choose exactly one input: --diff, --stdin, or --from with --to. Use --help.");
  if (range && (!values.from || !values.to)) throw new Error("Git range requires both --from and --to.");
  const warnings: string[] = [];
  let text: string, source: string;
  let snapshots: GitDiffInput | undefined;
  const cwd = resolve(values.repo ?? process.cwd());
  if (range) {
    snapshots = gitDiff(cwd, values.from!, values.to!);
    text = snapshots.diff; source = `${values.from} → ${values.to} (${snapshots.from.slice(0, 8)} → ${snapshots.to.slice(0, 8)})`;
  } else {
    if (values.stdin) {
      process.stdin.setEncoding("utf8");
      const chunks: string[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      text = chunks.join("");
    } else {
      text = await readFile(values.diff!, "utf8");
    }
    source = values.stdin ? "Standard input" : values.diff!;
    warnings.push("Patch-only review. Full files and repository call flows are unavailable.");
  }
  const units = parseDiff(text);
  const callFlow: string[] = [];
  if (snapshots && units.length) {
    try {
      const flow = runDiff({ cwd, from: snapshots.from, to: snapshots.to, maxDepth: 4, color: false, locs: true });
      callFlow.push(...flow.trees.map(tree => tree.ascii));
      for (const unit of units) unit.callFlow = flow.trees.filter(tree => touches(tree.tree, unit.file)).map(tree => tree.ascii);
      warnings.push("Call flows are syntactic, not a type checker. Dynamic calls and parse failures may be absent. An empty flow is not evidence of safety.");
    } catch {
      warnings.push("Call-flow analysis failed. Review is based on the diff only. Inspect repository context manually.");
    }
  }
  const result = await reviewUnits(units, { mock: values.mock });
  const report: ReviewReport = { title: "Focused PR review", source, mode: values.mock ? "mock" : "live", createdAt: new Date().toISOString(),
    ...result, callFlow, warnings: [...warnings, ...result.warnings] };
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
