import type { ConnectedSnapshot } from "./github.js";
import { withVisibleControls } from "./hidden-characters.js";
import type { ReviewItem, ReviewReport } from "./types.js";

/**
 * The most JSON one copy of a `review_diff` result may hold. The result travels
 * twice, as text content and as structured content, and MCP clients built on the
 * SDK drop the connection at 10 MiB per message: a 20,000-line pull request
 * produced 12 MB, which made the tool unusable for an ordinary large change.
 * The text copy is itself a JSON string inside the message, so it is measured
 * escaped once more: a change full of escaped quotes nearly doubles in it.
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
/** Review agenda entries kept when the result is over budget: past the first few they point at hunks the items already list. */
const KEPT_AGENDA = 20;

export interface Bounded {
  readonly snapshot: ConnectedSnapshot | undefined;
  readonly report: ReviewReport;
}

type Stage = (current: Bounded) => { readonly next: Bounded; readonly note: string } | undefined;

/** Bytes of the value as the text copy carries it. Escaping is per character, so an item adds exactly its own escaped length to the whole. */
const bytesOf = (value: Bounded | ReviewItem): number => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");
const sizeOf = (current: Bounded): number => bytesOf({ snapshot: current.snapshot, report: current.report });

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
    const evidence = report.evidence;
    if (evidence === undefined || evidence.agenda.length <= KEPT_AGENDA) return undefined;
    return {
      next: { snapshot, report: { ...report, evidence: { ...evidence, agenda: evidence.agenda.slice(0, KEPT_AGENDA) } } },
      note: `only the first ${KEPT_AGENDA} of ${evidence.agenda.length} review agenda entries were kept; report.items lists every hunk`,
    };
  },
  ({ snapshot, report }) => {
    if (!report.items.some((item) => item.callFlow !== undefined || item.contextNodes !== undefined)) return undefined;
    const items = report.items.map(({ callFlow: _flow, contextNodes: _nodes, ...rest }): ReviewItem => rest);
    return { next: { snapshot, report: { ...report, items } }, note: "the per-hunk call context (callFlow, contextNodes) was left out" };
  },
];

function withoutDiff(item: ReviewItem): ReviewItem {
  const lines = item.diff.split("\n").length;
  return { ...item, diff: `${item.header}\n[The ${lines} lines of this hunk were left out to keep this result under ${MAX_RESULT_BYTES / 1024 / 1024} MiB. Read them in the repository or on the review page.]` };
}

function withoutFacts({ facts: _facts, history: _history, ...rest }: ReviewItem): ReviewItem {
  return { ...rest, reasons: [] };
}

interface Trim {
  readonly next: Bounded;
  readonly size: number;
  readonly trimmed: number;
}

/**
 * Replace items by a smaller form, from the last (lowest-ranked) up, until the
 * result fits. Each item is measured once, and the size is kept by subtracting
 * what each replacement saves, so a change of thousands of hunks is not
 * serialized again per hunk. An item the smaller form would not shrink is kept.
 */
function trimItems(current: Bounded, size: number, limit: number, smaller: (item: ReviewItem) => ReviewItem): Trim {
  const items = [...current.report.items];
  let left = size;
  let trimmed = 0;
  for (let index = items.length - 1; index >= 0 && left > limit; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    const replacement = smaller(item);
    const saved = bytesOf(item) - bytesOf(replacement);
    if (saved <= 0) continue;
    items[index] = replacement;
    left -= saved;
    trimmed += 1;
  }
  return { next: { snapshot: current.snapshot, report: { ...current.report, items } }, size: left, trimmed };
}

/**
 * The report (and, for a connected review, its snapshot) as the agent is sent
 * it: with hidden characters shown as markers, whole while it fits, otherwise
 * trimmed in a fixed order, from the parts an agent needs least to the hunks
 * ranked last, with each trim recorded in `warnings`. The markers come first
 * because they are what is sent: a 3-byte zero-width space becomes a 12-byte
 * marker, so a budget taken before them undercounts.
 */
export function boundedForAgent(snapshot: ConnectedSnapshot | undefined, report: ReviewReport, budget: number = MAX_RESULT_BYTES): Bounded {
  const limit = budget - RESERVED_BYTES;
  let current: Bounded = withVisibleControls({ snapshot, report });
  let size = sizeOf(current);
  if (size <= limit) return current;
  const notes: string[] = [];
  for (const stage of stages) {
    const result = stage(current);
    if (result === undefined) continue;
    current = result.next;
    size = sizeOf(current);
    notes.push(result.note);
    if (size <= limit) break;
  }
  if (size > limit) {
    const diffs = trimItems(current, size, limit, withoutDiff);
    current = diffs.next;
    size = diffs.size;
    if (diffs.trimmed > 0) notes.push(`${diffs.trimmed} of the lowest-ranked hunks have their diff text left out`);
  }
  if (size > limit) {
    const facts = trimItems(current, size, limit, withoutFacts);
    current = facts.next;
    size = facts.size;
    if (facts.trimmed > 0) notes.push(`${facts.trimmed} of the lowest-ranked hunks have their facts, reasons, and history left out`);
  }
  // Every hunk must stay listed for the agent to order it, so past this point a
  // result only shrinks by losing hunks; saying so beats a dropped connection.
  if (size > limit) {
    const hunks = report.items.length === 1 ? "1 hunk" : `${report.items.length} hunks`;
    throw new Error(`This result is too large to send: with every diff, fact, and reason left out, the review of this change's ${hunks} is still ${(size / 1024 / 1024).toFixed(1)} MiB, over the ${budget / 1024 / 1024} MiB a client accepts in one message. Review the change in parts, with a narrower git range or a diff of fewer files.`);
  }
  const warning = `This result was over ${budget / 1024 / 1024} MiB, and the message carries it twice, so it was trimmed to stay under what a client accepts: ${notes.join("; ")}. The review page has the complete report.`;
  return { snapshot: current.snapshot, report: { ...current.report, warnings: [...current.report.warnings, warning] } };
}
