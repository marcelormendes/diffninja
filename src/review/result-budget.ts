import type { ConnectedSnapshot } from "./github.js";
import type { ReviewItem, ReviewReport } from "./types.js";

/**
 * The most JSON one copy of a `review_diff` result may hold. The result travels
 * twice, as text content and as structured content, and MCP clients built on the
 * SDK drop the connection at 10 MiB per message: a 20,000-line pull request
 * produced 12 MB, which made the tool unusable for an ordinary large change.
 *
 * Only the copy sent to the agent is trimmed. The server keeps the whole report
 * for the pages and for validating what the agent sends back, and every trim is
 * named in the result's warnings so the agent knows what it was not shown.
 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** Room left for the fields a result adds around the report (ids, next steps). */
const RESERVED_BYTES = 64 * 1024;
/** Author claims kept when the result is over budget: they are navigation aids, not the review. */
const KEPT_CLAIMS = 20;

export interface Bounded {
  readonly snapshot: ConnectedSnapshot | undefined;
  readonly report: ReviewReport;
}

type Stage = (current: Bounded) => { readonly next: Bounded; readonly note: string } | undefined;

const sizeOf = (current: Bounded): number => Buffer.byteLength(JSON.stringify({ snapshot: current.snapshot, report: current.report }), "utf8");

const stages: readonly Stage[] = [
  ({ snapshot, report }) => snapshot === undefined || snapshot.lines.length === 0 ? undefined : {
    next: { snapshot: { ...snapshot, lines: [] }, report },
    note: `snapshot.lines (a line-by-line copy of the diff, ${snapshot.lines.length} lines) was left out; the hunks in report.items carry every line`,
  },
  ({ snapshot, report }) => report.callFlow.length === 0 && report.callFlows.length === 0 ? undefined : {
    next: { snapshot, report: { ...report, callFlow: [], callFlows: [] } },
    note: "the call-flow trees (callFlow, callFlows) were left out",
  },
  ({ snapshot, report }) => {
    const intent = report.evidence?.intent;
    if (report.evidence === undefined || intent === undefined || intent.claims.length <= KEPT_CLAIMS) return undefined;
    return {
      next: { snapshot, report: { ...report, evidence: { ...report.evidence, intent: { ...intent, claims: intent.claims.slice(0, KEPT_CLAIMS) } } } },
      note: `only the first ${KEPT_CLAIMS} of ${intent.claims.length} statements from the pull request text were kept`,
    };
  },
  ({ snapshot, report }) => {
    if (!report.items.some((item) => item.callFlow !== undefined || item.contextNodes !== undefined)) return undefined;
    const items = report.items.map(({ callFlow: _flow, contextNodes: _nodes, ...rest }): ReviewItem => rest);
    return { next: { snapshot, report: { ...report, items } }, note: "the per-hunk call context (callFlow, contextNodes) was left out" };
  },
];

interface Omission {
  readonly next: Bounded;
  readonly omitted: number;
}

/** Replace the diff text of the last (lowest-ranked) items until the result fits, keeping every item's header and facts. */
function omitDiffs(current: Bounded, budget: number): Omission {
  const items = [...current.report.items];
  let omitted = 0;
  let next: Bounded = current;
  for (let index = items.length - 1; index >= 0 && sizeOf(next) > budget; index -= 1) {
    const item = items[index];
    if (item === undefined || item.diff.length < 2000) continue;
    const lines = item.diff.split("\n").length;
    items[index] = { ...item, diff: `${item.header}\n[The ${lines} lines of this hunk were left out to keep this result under ${MAX_RESULT_BYTES / 1024 / 1024} MiB. Read them in the repository or on the review page.]` };
    omitted += 1;
    next = { snapshot: current.snapshot, report: { ...current.report, items: [...items] } };
  }
  return { next, omitted };
}

/**
 * The report (and, for a connected review, its snapshot) as the agent is sent
 * it: whole while it fits, otherwise trimmed in a fixed order, from the parts an
 * agent needs least to the hunks ranked last, with each trim recorded in
 * `warnings`.
 */
export function boundedForAgent(snapshot: ConnectedSnapshot | undefined, report: ReviewReport, budget: number = MAX_RESULT_BYTES): Bounded {
  const limit = budget - RESERVED_BYTES;
  let current: Bounded = { snapshot, report };
  if (sizeOf(current) <= limit) return current;
  const notes: string[] = [];
  for (const stage of stages) {
    const result = stage(current);
    if (result === undefined) continue;
    current = result.next;
    notes.push(result.note);
    if (sizeOf(current) <= limit) break;
  }
  if (sizeOf(current) > limit) {
    const { next, omitted } = omitDiffs(current, limit);
    current = next;
    if (omitted > 0) notes.push(`${omitted} of the lowest-ranked hunks have their diff text left out`);
  }
  const warning = `This result was over ${budget / 1024 / 1024} MiB, more than a client accepts in one message, so it was trimmed: ${notes.join("; ")}. The review page has the complete report.`;
  return { snapshot: current.snapshot, report: { ...current.report, warnings: [...current.report.warnings, warning] } };
}
