import { resolve } from "node:path";
import { runDiff } from "../run.js";
import type { DiffNode, DiffTreeResult, Snapshot } from "../types.js";
import { parseDiff, gitDiff } from "./input.js";
import { reviewUnits } from "./pipeline.js";
import { buildCallFlows, reportOrderedTextHunkFiles, CALL_FLOW_MAX_DEPTH } from "./call-flow.js";
import { buildCallContext } from "./call-context.js";
import type { ContextSources } from "./call-context.js";
import type { CallFlowNodeDetail } from "./call-flow.js";
import { definitionReader } from "./source.js";
import type { DefinitionDetail } from "./source.js";
import type { CallFlowAvailability, ReviewOptions, ReviewReport } from "./types.js";

export type ReviewInput =
  | { diff: string; source: string }
  | { repo: string; from: string; to: string };

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
  let trees: DiffTreeResult[] = [];
  // Definition source comes from the snapshot the definition resolved in: the
  // `to` revision, except for a removed call, whose only definition is the
  // `from` one. Definitions outside the diff, callers and callees alike, are
  // read the same way. Unreadable definitions stay absent rather than guessed.
  // One reader serves the structured call flows and the keyed node context, so
  // each snapshot file is read once per revision.
  let nodeDetail: CallFlowNodeDetail | undefined;
  let contextSources: ContextSources = {};
  if (snapshots) {
    const readDefinition = definitionReader(cwd!);
    const from: Snapshot = { kind: "commit", ref: snapshots.from };
    const to: Snapshot = { kind: "commit", ref: snapshots.to };
    nodeDetail = (node: DiffNode): DefinitionDetail => {
      const definition = node.definition;
      if (!definition) return {};
      return readDefinition(definition, node.status === "removed" ? from : to);
    };
    // A node carries its definition whole or not at all, so an unreadable
    // span yields no source rather than a shorter one.
    contextSources = {
      before: definition => readDefinition(definition, from).source?.text ?? null,
      after: definition => readDefinition(definition, to).source?.text ?? null,
    };
  }
  // A patch carries no repository, so the only honest answer is that call flows
  // need a git range. Every other value is decided by what analysis returned.
  let callFlowAvailability: CallFlowAvailability = snapshots ? "no-changes" : "needs-git-range";
  if (snapshots && units.length) {
    try {
      const flow = runDiff({
        cwd: cwd!, from: snapshots.from, to: snapshots.to, maxDepth: CALL_FLOW_MAX_DEPTH, color: false, locs: true,
        onIndexes(before, after) {
          const context = buildCallContext(units, before, after, contextSources);
          for (const unit of units) {
            const entry = context.get(unit.id);
            // Absent, not empty: a hunk with no context carries neither field,
            // exactly as the report treated a hunk with no blocks before.
            unit.callFlow = entry === undefined || entry.entries.length === 0 ? undefined : entry.entries;
            unit.contextNodes = entry === undefined || entry.nodes.length === 0 ? undefined : entry.nodes;
          }
        },
      });
      trees = flow.trees;
      callFlow.push(...trees.map(tree => tree.ascii));
      warnings.push("Call flows are syntactic, not a type checker. Dynamic calls and parse failures may be absent. An empty flow is not evidence of safety.");
    } catch {
      for (const unit of units) {
        delete unit.callFlow;
        delete unit.contextNodes;
      }
      callFlowAvailability = "failed";
      warnings.push("Call-flow analysis failed. Review is based on the diff only. Inspect repository context manually.");
    }
  }
  const result = await reviewUnits(units, options);
  // Structured flows are grouped per changed file in report order, after
  // ranking, so the HTML can order files by the severity of their worst hunk.
  const callFlows = buildCallFlows(reportOrderedTextHunkFiles(result.items, units), trees, nodeDetail);
  if (callFlows.length > 0) callFlowAvailability = "available";
  return { title: "Focused PR review", source, mode: options.mock ? "mock" : "live", createdAt: new Date().toISOString(),
    ...result, callFlow, callFlows, callFlowAvailability, warnings: [...warnings, ...result.warnings] };
}
