import { resolve } from "node:path";
import { runDiff } from "../run.js";
import type { DiffNode } from "../types.js";
import { parseDiff, gitDiff } from "./input.js";
import { reviewUnits } from "./pipeline.js";
import type { ReviewOptions, ReviewReport } from "./types.js";

export type ReviewInput =
  | { diff: string; source: string }
  | { repo: string; from: string; to: string };

function touches(node: DiffNode, file: string): boolean {
  return node.file === file || node.children.some(child => touches(child, file));
}

/** Shared report orchestration; transports own input reading and output persistence. */
export async function reviewDiff(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewReport> {
  const warnings: string[] = [];
  const cwd = "repo" in input ? resolve(input.repo) : undefined;
  const snapshots = "repo" in input ? gitDiff(cwd!, input.from, input.to) : undefined;
  const text = "diff" in input ? input.diff : snapshots!.diff;
  const source = "diff" in input ? input.source
    : `${input.from} → ${input.to} (${snapshots!.from.slice(0, 8)} → ${snapshots!.to.slice(0, 8)})`;
  if (!snapshots) warnings.push("Patch-only review. Full files and repository call flows are unavailable.");
  const units = parseDiff(text);
  const callFlow: string[] = [];
  if (snapshots && units.length) {
    try {
      const flow = runDiff({ cwd: cwd!, from: snapshots.from, to: snapshots.to, maxDepth: 4, color: false, locs: true });
      callFlow.push(...flow.trees.map(tree => tree.ascii));
      for (const unit of units) unit.callFlow = flow.trees.filter(tree => touches(tree.tree, unit.file)).map(tree => tree.ascii);
      warnings.push("Call flows are syntactic, not a type checker. Dynamic calls and parse failures may be absent. An empty flow is not evidence of safety.");
    } catch {
      warnings.push("Call-flow analysis failed. Review is based on the diff only. Inspect repository context manually.");
    }
  }
  const result = await reviewUnits(units, options);
  return { title: "Focused PR review", source, mode: options.mock ? "mock" : "live", createdAt: new Date().toISOString(),
    ...result, callFlow, warnings: [...warnings, ...result.warnings] };
}
