/**
 * The local analysis of a connected pull request, as the connected page shows it.
 *
 * The connected page reviews the canonical GitHub patch; this is the same
 * deterministic analysis a static review produces for that patch — status,
 * priority, change facts with their cited lines, the reading agenda, and the
 * questions for the agent with any answers recorded — reduced to what the page
 * renders. It is bound to one snapshot id, so a page never shows analysis of a
 * revision other than the one it reviews. Nothing here is model output: the
 * facts are lexical, and an answer is a closed-set choice attributed to the
 * MCP client that recorded it.
 */

import { CHANGE_FACT_QUESTIONS, type ChangeFactQuestion } from "./change-facts.js";
import { verdictOf, type QuestionKind, type Verdict } from "./questions.js";
import type { ReviewItem, ReviewReport, ReviewStatus, SuggestedComment } from "./types.js";

/** Most agenda entries the page lists; the full report has the rest. */
export const CONNECTED_AGENDA_LIMIT = 5;

const FACT_LABEL = {
  comparisonChanged: "comparison changed",
  limitChanged: "limit changed",
  validationChanged: "input check changed",
  failurePropagated: "failure handed to the caller",
  failureDeferred: "failure deferred or retried",
  failureDiscarded: "failure discarded",
  contractChanged: "public contract or declaration changed",
  dataChanged: "schema or stored data changed",
  queryChanged: "database query changed",
  instructionChanged: "instruction to readers changed",
  referenceChanged: "link or reference changed",
  gateWeakened: "CI gate weakened",
  permissionChanged: "permission or secret access changed",
  pinChanged: "version pin changed",
} satisfies Record<ChangeFactQuestion, string>;

export interface ConnectedFact {
  readonly label: string;
  readonly side: "added" | "removed";
  readonly text: string;
}

export interface ConnectedQuestion {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly text: string;
  readonly options: readonly string[];
  choice?: string;
  answeredBy?: string;
  /** The short label the page shows for the recorded answer. */
  verdict?: Verdict;
}

export interface ConnectedHunk {
  readonly id: string;
  readonly file: string;
  readonly header: string;
  readonly added: number;
  readonly removed: number;
  /** First line to scroll to, on the side the diff shows it: the new side unless the hunk only removes. */
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly status: ReviewStatus;
  readonly facts: readonly ConnectedFact[];
  /** One fixed sentence when the hunk was not read: a metadata unit or an unread file type. */
  note?: string;
  readonly questions: readonly ConnectedQuestion[];
}

/** Whether the analysis had a local clone's definitions and call flows. */
export interface ConnectedScope {
  readonly source: "repository" | "patch";
  readonly note: string;
}

export interface ConnectedAnalysis {
  readonly available: true;
  readonly scope: ConnectedScope;
  readonly snapshotId: string;
  readonly reviewId: string;
  readonly reportUrl: string;
  readonly counts: Readonly<Record<ReviewStatus, number>>;
  readonly agenda: readonly { readonly title: string; readonly reason: string }[];
  /** Whose order `hunks` follow: the reviewing agent's once it recorded one, otherwise diffninja's. */
  readonly order: ConnectedOrder;
  /** Every hunk, in report order. */
  readonly hunks: readonly ConnectedHunk[];
  readonly questions: { readonly total: number; readonly answered: number };
  /** Line comments the reviewing agent suggested, for the human to add to their review or not. */
  /** Changed files that have call-flow diagrams, for the page's "Call flow" buttons; empty for a patch-only analysis. */
  readonly callFlowFiles: readonly string[];
  suggestions?: { readonly suggestedBy: string; readonly comments: readonly SuggestedComment[] };
}

export type ConnectedOrder = { readonly source: "agent"; readonly orderedBy: string } | { readonly source: "diffninja" };

export interface ConnectedAnalysisUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type ConnectedAnalysisView = ConnectedAnalysis | ConnectedAnalysisUnavailable;

/** Where the page scrolls to for one hunk. */
interface HunkLanding {
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
}

/** The first line a reader should land on: the first changed line, on its own side. */
function landingOf(item: ReviewItem): HunkLanding {
  let oldLine = item.oldStart;
  let newLine = item.newStart;
  for (const text of item.diff.split("\n").slice(1)) {
    if (text.startsWith("+")) return { line: newLine, side: "RIGHT" };
    if (text.startsWith("-")) return { line: oldLine, side: "LEFT" };
    if (text.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { line: item.newStart, side: "RIGHT" };
}

function noteOf(item: ReviewItem): string | undefined {
  if (item.facts === undefined && item.status !== "passed") {
    return "Not read by diffninja (binary, rename, mode, or other metadata-only change). Check it yourself.";
  }
  if (item.facts?.language === null) return "diffninja does not read this file type. Read this hunk yourself.";
  if (item.facts?.inert === true) return "Formatting or comments only.";
  if (item.facts?.importsOnly === true) return "Imports only: read where the imported names are used.";
  return undefined;
}

/** Changed files with at least one call-flow tree, in report order. */
export function callFlowFilesOf(report: ReviewReport): string[] {
  const changed = new Set(report.items.map((item) => item.file));
  return report.callFlows.filter((entry) => entry.trees.length > 0 && changed.has(entry.file)).map((entry) => entry.file);
}

export function connectedAnalysisOf(
  report: ReviewReport,
  snapshotId: string,
  reviewId: string,
  reportUrl: string,
  scope: ConnectedScope,
): ConnectedAnalysis {
  const questionsByUnit = new Map<string, ConnectedQuestion[]>();
  for (const question of report.questions) {
    const view: ConnectedQuestion = { id: question.id, kind: question.kind, text: question.text, options: question.options };
    if (question.answer !== undefined) {
      view.choice = question.answer.choice;
      view.answeredBy = question.answer.answeredBy;
      const verdict = verdictOf(question.kind, question.answer.choice);
      if (verdict !== undefined) view.verdict = verdict;
    }
    const owner = question.unitIds[0];
    if (owner === undefined) continue;
    const list = questionsByUnit.get(owner) ?? [];
    list.push(view);
    questionsByUnit.set(owner, list);
  }
  const counts = { attention: 0, uncertain: 0, low: 0, passed: 0 };
  const hunks = report.items.map((item): ConnectedHunk => {
    counts[item.status] += 1;
    const facts: ConnectedFact[] = [];
    for (const question of CHANGE_FACT_QUESTIONS) {
      const evidence = item.facts?.evidence[question];
      if (item.facts?.answers[question] === "yes" && evidence !== undefined) {
        facts.push({ label: FACT_LABEL[question], side: evidence.side, text: evidence.text });
      }
    }
    const landing = landingOf(item);
    const hunk: ConnectedHunk = {
      id: item.id,
      file: item.file,
      header: item.header,
      added: item.added,
      removed: item.removed,
      line: landing.line,
      side: landing.side,
      status: item.status,
      facts,
      questions: questionsByUnit.get(item.id) ?? [],
    };
    const note = noteOf(item);
    if (note !== undefined) hunk.note = note;
    return hunk;
  });
  const answered = report.questions.filter((question) => question.answer !== undefined).length;
  const analysis: ConnectedAnalysis = {
    available: true,
    scope,
    snapshotId,
    reviewId,
    reportUrl,
    counts,
    // The hunk list already covers "read the remaining changes in <file>" entries.
    agenda: (report.evidence?.agenda ?? [])
      .filter((entry) => !entry.id.startsWith("agenda:hunks:"))
      .slice(0, CONNECTED_AGENDA_LIMIT)
      .map((entry) => ({ title: entry.title, reason: entry.reason })),
    order: report.agentOrder === undefined ? { source: "diffninja" } : { source: "agent", orderedBy: report.agentOrder.orderedBy },
    hunks,
    questions: { total: report.questions.length, answered },
    callFlowFiles: callFlowFilesOf(report),
  };
  if (report.agentComments !== undefined) {
    analysis.suggestions = { suggestedBy: report.agentComments.suggestedBy, comments: report.agentComments.comments };
  }
  return analysis;
}
