import { resolve } from "node:path";
import { runDiff } from "../run.js";
import { readSnapshotFile } from "../git.js";
import type { DiffNode, DiffTreeResult, Snapshot } from "../types.js";
import { parseDiff, gitDiff } from "./input.js";
import { reviewUnits } from "./pipeline.js";
import { buildCallFlows, reportOrderedTextHunkFiles, CALL_FLOW_MAX_DEPTH } from "./call-flow.js";
import { buildCallContext } from "./call-context.js";
import type { ContextSources } from "./call-context.js";
import type { CallFlowNodeDetail } from "./call-flow.js";
import { definitionReader } from "./source.js";
import type { DefinitionDetail } from "./source.js";
import type { CallFlowAvailability, ReviewOptions, ReviewReport, ReviewUnit } from "./types.js";
import { buildReviewEvidence } from "./evidence.js";
import { crossCheckIntent } from "./intent.js";
import { checkReferences } from "./reference-check.js";
import { moduleResolver } from "./module-resolution.js";
import { reviewQuestions } from "./questions.js";
import { readProjectContext } from "./history.js";
import type { ProjectContext } from "./history.js";

export type ReviewInput =
  | { diff: string; source: string }
  | { repo: string; from: string; to: string; diff?: string; source?: string };

/** Context width may differ, but source-enriched patches must describe the same changed lines. */
function changedLineIdentity(units: readonly ReviewUnit[]): string {
  const changes: string[] = [];
  for (const unit of units) {
    if (unit.special) continue;
    let oldLine = unit.oldStart, newLine = unit.newStart;
    for (const line of unit.diff.split("\n").slice(1)) {
      if (line.startsWith("+")) changes.push(JSON.stringify([unit.file, "+", newLine++, line.slice(1)]));
      else if (line.startsWith("-")) changes.push(JSON.stringify([unit.file, "-", oldLine++, line.slice(1)]));
      else if (line.startsWith(" ")) { oldLine++; newLine++; }
    }
  }
  return changes.sort().join("\n");
}

/** Most whole context nodes one hunk carries in the report. */
export const REPORT_CONTEXT_NODES = 8;
/** Most call-flow block characters one hunk carries in the report. */
export const REPORT_CALL_FLOW_CHARS = 24_000;

/** Keep the highest-priority context of one hunk, whole, and say what was left out. */
export function boundReportContext(unit: ReviewUnit): void {
  if (unit.contextNodes !== undefined && unit.contextNodes.length > REPORT_CONTEXT_NODES) {
    unit.contextNodes = unit.contextNodes.slice(0, REPORT_CONTEXT_NODES);
  }
  if (unit.callFlow === undefined) return;
  const kept: string[] = [];
  let used = 0;
  for (const block of unit.callFlow) {
    if (used + block.length > REPORT_CALL_FLOW_CHARS && kept.length > 0) break;
    kept.push(block);
    used += block.length;
  }
  const omitted = unit.callFlow.length - kept.length;
  if (omitted > 0) kept.push(`omitted call-flow blocks=${omitted} reason=report-size-limit chars=${REPORT_CALL_FLOW_CHARS}`);
  unit.callFlow = kept;
}

/** Shared report orchestration; transports own input reading and output persistence. */
export async function reviewDiff(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewReport> {
  const warnings: string[] = [];
  const cwd = "repo" in input ? resolve(input.repo) : undefined;
  const snapshots = "repo" in input ? gitDiff(cwd!, input.from, input.to) : undefined;
  const text = input.diff ?? snapshots!.diff;
  const source = input.source ?? ("repo" in input
    ? `${input.from} → ${input.to} (${snapshots!.from.slice(0, 8)} → ${snapshots!.to.slice(0, 8)})`
    : "Patch");
  if (!snapshots) warnings.push("Patch-only review. Full files and repository call flows are unavailable.");
  const units = parseDiff(text);
  if (snapshots && input.diff !== undefined && changedLineIdentity(units) !== changedLineIdentity(parseDiff(snapshots.diff))) {
    throw new Error("The supplied patch does not match the immutable repository range; refusing mismatched source evidence.");
  }
  if (snapshots && options.pr?.headRef !== undefined && options.pr.headRef !== snapshots.to) {
    throw new Error("The PR head does not match the source snapshot; refusing mismatched intent evidence.");
  }
  let evidence = buildReviewEvidence(units);
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
          evidence = buildReviewEvidence(units, {
            before, after, sources: contextSources, baseRef: snapshots.from, headRef: snapshots.to,
            resolveImport: moduleResolver(file => readSnapshotFile(cwd!, { kind: "commit", ref: snapshots.to }, file)),
          });
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
      evidence = buildReviewEvidence(units);
      warnings.push("Call-flow analysis failed. Review is based on the diff only. Inspect repository context manually.");
    }
  }
  if (options.referenceProject !== undefined) {
    if (!snapshots) throw new Error("Reference checking requires a repository and immutable git range.");
    const references = await checkReferences(cwd!, snapshots.from, snapshots.to, units, options.referenceProject);
    evidence.findings.push(...references.findings);
    evidence.agenda.unshift(...references.findings.map(finding => ({
      id: `agenda-${finding.id}`, title: "Check the newly unresolved reference",
      reason: finding.title, priority: 100, unitIds: finding.unitIds,
      findingIds: [finding.id], evidence: finding.evidence, context: [],
    })));
    evidence.checks = evidence.checks.map(check => check.kind === "broken-reference" ? references.check : check);
  }
  // Analysis above used every context node; the report carries a bounded share of
  // it per hunk, so a change to a widely used type cannot produce a report of tens
  // of megabytes (one real hunk had thousands of callers).
  for (const unit of units) boundReportContext(unit);
  // History, guidelines, and conventions come from the local repository only.
  const project: ProjectContext | undefined = snapshots
    ? readProjectContext(cwd!, snapshots.from, snapshots.to, units, options.pr?.title ?? "")
    : undefined;
  const result = reviewUnits(units);
  // Structured flows are grouped per changed file in report order, after
  // ranking, so the HTML can order files by the severity of their worst hunk.
  const callFlows = buildCallFlows(reportOrderedTextHunkFiles(result.items, units), trees, nodeDetail);
  if (callFlows.length > 0) callFlowAvailability = "available";
  const report: ReviewReport = { title: options.pr?.title || "Focused PR review", source, createdAt: new Date().toISOString(),
    pr: options.pr,
    evidence: { ...evidence, intent: crossCheckIntent(options.pr, units, evidence.agenda, evidence.findings) },
    ...result, callFlow, callFlows, callFlowAvailability, warnings: [...warnings, ...result.warnings],
    questions: reviewQuestions(result.items, options.pr, project) };
  if (project !== undefined) report.project = project;
  return report;
}
