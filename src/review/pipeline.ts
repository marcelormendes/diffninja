/**
 * Hunk routing and ranking for a diffninja review run.
 *
 * Everything here is local and deterministic: no model is called, nothing leaves
 * the machine, and the same input always produces the same report. Every input
 * unit comes back as exactly one ReviewItem:
 *
 *   - a unit the input parser marked special (binary, rename, mode, symbolic
 *     link, submodule) and a unit with no diff text go to manual review;
 *   - an exact no-op hunk and a blank-only change to a .md/.txt document pass;
 *   - every other hunk gets its local change facts ({@link changeFactsOf}): a
 *     formatting- or comment-only change passes, a file type diffninja cannot
 *     read is `uncertain` for a human to read, a code or configuration change
 *     outside a test file is `attention`, documentation is `attention` when it
 *     changes an instruction, a link, or a limit and `low` otherwise, and a
 *     test-file change is `attention` only when it changes a limit, discards a
 *     failure, or weakens a gate, `low` otherwise.
 *
 * Priority orders hunks within the report: a fixed base, a weight for a change
 * that is not inert, and the heaviest fact of the boundary group (what the
 * change says or bounds), of the failure group (failures, gates,
 * permissions), and of the surface group (public declarations, schema, stored
 * data). Each group contributes its maximum, never a sum.
 *
 * The report order puts manual work first, then the read hunks by priority —
 * those outside test files before those in test files — and the passes last;
 * input order breaks ties. Status is a label to filter on and never reorders it.
 */

import {
  CHANGE_FACT_QUESTIONS,
  changeFactsOf,
  factQuestionsFor,
  type ChangeFactQuestion,
  type ChangeFacts,
} from "./change-facts.js";
import { testLikeFile } from "./file-role.js";
import type { ReviewItem, ReviewStatus, ReviewUnit } from "./types.js";

/** Priority every read hunk starts from. */
export const BASE_PRIORITY = 5;

/** Weight of a change that is not inert: the code, or the text, really differs. */
export const CHANGED_PRIORITY = 10;

/** Weight of each fact when it is `yes`; `no` adds nothing. */
export const FACT_PRIORITY = {
  comparisonChanged: 6,
  limitChanged: 15,
  validationChanged: 6,
  failurePropagated: 3,
  failureDeferred: 6,
  failureDiscarded: 15,
  contractChanged: 10,
  dataChanged: 15,
  instructionChanged: 10,
  referenceChanged: 6,
  gateWeakened: 15,
  permissionChanged: 15,
  pinChanged: 6,
} satisfies Record<ChangeFactQuestion, number>;

/** What the change says or bounds: conditions, limits, checks, instructions, links, pins. */
const BOUNDARY_FACTS = [
  "comparisonChanged", "limitChanged", "validationChanged", "instructionChanged", "referenceChanged", "pinChanged",
] as const;
/** What happens when things fail, or who may do what: failures, CI gates, permissions. */
const FAILURE_FACTS = [
  "failurePropagated", "failureDeferred", "failureDiscarded", "gateWeakened", "permissionChanged",
] as const;

/** What others build on or what is stored: public declarations, schema, and data. */
const SURFACE_FACTS = ["contractChanged", "dataChanged"] as const;

/** Facts strong enough to raise a test-file hunk to attention on their own. */
const TEST_FILE_ATTENTION_FACTS = ["limitChanged", "failureDiscarded", "gateWeakened"] as const;

/** Fixed priorities for hunks the facts do not rank. */
export const MANUAL_REVIEW_PRIORITY = 70;
export const TRIVIAL_PRIORITY = 5;

/**
 * Report position of one item: manual work, then read hunks outside test files,
 * then read hunks in test files, then passes. Test files come after the code they
 * exercise because a regression test changes as much as its fix does; which file
 * is a test is a path fact. Documentation is not demoted: prose can be normative.
 */
export const REPORT_PLACEMENT = {
  manual: 0,
  read: 1,
  readTest: 2,
  passed: 3,
} satisfies Record<"manual" | "read" | "readTest" | "passed", number>;

/** Reason attached to a read hunk the report lists after the non-test hunks. */
export const TEST_FILE_ORDER_REASON =
  "read after the hunks outside test files: the path looks like a test file (a path convention, " +
  "not coverage), and its priority orders it among the other test hunks";

const FACT_LABEL = {
  comparisonChanged: "comparison changed",
  limitChanged: "limit changed",
  validationChanged: "input check changed",
  failurePropagated: "failure handed to the caller",
  failureDeferred: "failure deferred or retried",
  failureDiscarded: "failure discarded",
  contractChanged: "public contract or declaration changed",
  dataChanged: "schema or stored data changed",
  instructionChanged: "instruction to readers changed",
  referenceChanged: "link or reference changed",
  gateWeakened: "CI gate weakened",
  permissionChanged: "permission or secret access changed",
  pinChanged: "version pin changed",
} satisfies Record<ChangeFactQuestion, string>;

const STATUS_REASON = {
  attention:
    "attention: code or configuration outside a test file changed, documentation changed an instruction, link, or limit, or a test changed a limit, discarded a failure, or weakened a gate",
  uncertain: "uncertain: diffninja does not read this file type, so no facts were established and a person reads it",
  low: "low: a test-file change, or a documentation change with no instruction, link, or limit change",
  passed: "passed: the text is identical once comments and layout are ignored",
} satisfies Record<ReviewStatus, string>;

export interface ReviewPipelineResult {
  readonly items: ReviewItem[];
  /** Run-level notices for the report; per-hunk detail stays in `reasons`. */
  readonly warnings: string[];
}

function clampPriority(priority: number): number {
  return Math.max(0, Math.min(100, Math.round(priority)));
}

/** Added and removed lines, and how many of them are not blank. */
function countChangedLines(diff: string) {
  let added = 0;
  let removed = 0;
  let nonBlank = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) {
      added += 1;
      if (line.slice(1).trim() !== "") nonBlank += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      if (line.slice(1).trim() !== "") nonBlank += 1;
    }
  }
  return { added, removed, nonBlank };
}

/**
 * Pass rules that need no facts: a hunk with no added or removed lines, and a
 * blank-only change to a text document (.md/.txt).
 */
function deterministicPassReason(unit: ReviewUnit): string | null {
  const changed = countChangedLines(unit.diff);
  if (changed.added === 0 && changed.removed === 0) {
    return "exact no-op: the hunk adds and removes no lines";
  }
  if (changed.nonBlank > 0) return null;
  const path = unit.file.toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".txt")) {
    return `blank-only change to a text document (${changed.added} added, ${changed.removed} removed blank line(s))`;
  }
  return null;
}

function manualReason(unit: ReviewUnit): string | null {
  if (unit.special !== undefined && unit.special !== "") {
    return `special unit (${unit.special}): the diff carries no reviewable text, so a person reviews it`;
  }
  if (unit.diff.trim() === "") return "no diff text was supplied for this hunk; a person reviews it";
  return null;
}

function statusOf(unit: ReviewUnit, facts: ChangeFacts): ReviewStatus {
  if (facts.language === null) return "uncertain";
  if (facts.inert) return "passed";
  const yes = (question: ChangeFactQuestion) => facts.answers[question] === "yes";
  if (testLikeFile(unit.file)) return TEST_FILE_ATTENTION_FACTS.some(yes) ? "attention" : "low";
  // Prose matters when it tells a reader something new to do, follow, or rely on.
  if (facts.language === "prose") return factQuestionsFor("prose").some(yes) ? "attention" : "low";
  return "attention";
}

function priorityOf(facts: ChangeFacts): number {
  if (facts.inert) return TRIVIAL_PRIORITY;
  const heaviest = (group: readonly ChangeFactQuestion[]) =>
    Math.max(0, ...group.filter((question) => facts.answers[question] === "yes").map((question) => FACT_PRIORITY[question]));
  return clampPriority(BASE_PRIORITY + CHANGED_PRIORITY + heaviest(BOUNDARY_FACTS) + heaviest(FAILURE_FACTS) + heaviest(SURFACE_FACTS));
}

/** One sentence per established fact, citing the changed line it rests on. */
function reasonsOf(unit: ReviewUnit, facts: ChangeFacts, status: ReviewStatus): string[] {
  const reasons: string[] = [];
  for (const question of CHANGE_FACT_QUESTIONS) {
    const evidence = facts.evidence[question];
    if (facts.answers[question] === "yes" && evidence !== undefined) {
      reasons.push(`${FACT_LABEL[question]} — ${evidence.side} line: ${evidence.text}`);
    }
  }
  reasons.push(STATUS_REASON[status]);
  if (status !== "passed" && facts.language !== null && testLikeFile(unit.file)) reasons.push(TEST_FILE_ORDER_REASON);
  return reasons;
}

function readItem(unit: ReviewUnit): ReviewItem {
  const facts = changeFactsOf(unit);
  const status = statusOf(unit, facts);
  return { ...unit, status, priority: priorityOf(facts), reasons: reasonsOf(unit, facts, status), facts };
}

/** Where an item belongs in the report; see {@link REPORT_PLACEMENT}. */
export function placementOf(item: ReviewItem): number {
  if (item.status === "passed") return REPORT_PLACEMENT.passed;
  if (item.facts === undefined) return REPORT_PLACEMENT.manual;
  return item.facts.language !== null && testLikeFile(item.file) ? REPORT_PLACEMENT.readTest : REPORT_PLACEMENT.read;
}

/** Route, read, and order every unit. Deterministic: no network, no model, no randomness. */
export function reviewUnits(units: readonly ReviewUnit[]): ReviewPipelineResult {
  const items = units.map((unit, index) => {
    const manual = manualReason(unit);
    if (manual !== null) {
      return { index, item: { ...unit, status: "uncertain" as const, priority: MANUAL_REVIEW_PRIORITY, reasons: [manual] } };
    }
    const pass = deterministicPassReason(unit);
    if (pass !== null) {
      return { index, item: { ...unit, status: "passed" as const, priority: TRIVIAL_PRIORITY, reasons: [pass] } };
    }
    return { index, item: readItem(unit) };
  });
  items.sort(
    (left, right) =>
      placementOf(left.item) - placementOf(right.item) ||
      right.item.priority - left.item.priority ||
      left.index - right.index,
  );
  return { items: items.map((entry) => entry.item), warnings: [] };
}
