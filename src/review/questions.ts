/**
 * Questions for the reviewing agent's own model.
 *
 * diffninja calls no model. Where a judgment needs meaning rather than syntax —
 * does this change what callers observe, does a test exercise it, does a test
 * change weaken it, does the documentation match the code, does the hunk serve
 * the stated goal — the report asks the agent that requested it. Questions are
 * fixed templates bound to specific hunks, generated deterministically from the
 * facts, each with a closed set of options that always includes `cannot-tell`.
 *
 * Answers are recorded through the `record_answers` tool, validated against
 * these options, attributed to the answering MCP client, and shown beside the
 * hunk. They never change a status, a priority, or the report order: an answer
 * is another reader's view, not a verdict.
 */

import { factQuestionsFor } from "./change-facts.js";
import type { PullRequestIntent } from "./evidence-types.js";
import { testLikeFile } from "./file-role.js";
import type { ProjectContext } from "./history.js";
import type { ReviewItem } from "./types.js";

/** Most questions one report asks; hunks earlier in the report are asked first. */
export const MAX_REVIEW_QUESTIONS = 36;
/** Most revert and removed-fix questions one report asks; the rest stay in the project context. */
export const MAX_HISTORY_QUESTIONS = 3;

export const QUESTION_OPTIONS = {
  behaviorChange: ["changes-behavior", "no-behavior-change", "cannot-tell"],
  testCoverage: ["exercised", "not-exercised", "cannot-tell"],
  testWeakened: ["weakens", "does-not-weaken", "cannot-tell"],
  docMatchesCode: ["matches", "contradicts", "cannot-tell"],
  intentFit: ["serves", "supports", "unrelated", "contradicts", "cannot-tell"],
  undoesFix: ["keeps-its-purpose", "undoes-it", "cannot-tell"],
  repeatsRevert: ["reintroduces-it", "different-change", "cannot-tell"],
  followsGuidelines: ["follows", "breaks-a-rule", "not-covered", "cannot-tell"],
  followsConvention: ["should-follow", "differs-for-a-reason", "cannot-tell"],
} as const;

export type QuestionKind = keyof typeof QUESTION_OPTIONS;

export interface QuestionAnswer {
  readonly choice: string;
  /** The MCP client that recorded it, as it named itself; never a model identity claim. */
  readonly answeredBy: string;
  readonly answeredAt: string;
}

export interface ReviewQuestion {
  /** Stable within one report: `q1`, `q2`, … in report order. */
  readonly id: string;
  readonly kind: QuestionKind;
  /** The hunks the question is about; the first is the one it is asked beside. */
  readonly unitIds: readonly string[];
  readonly text: string;
  readonly options: readonly string[];
  answer?: QuestionAnswer;
}

/** Removed assertions or added skips: the shapes a weakened test takes. */
const ASSERTION_LINE = /\b(?:expect|assert\w*|should)\b|\bt\.\w+\(|\bself\.assert\w*\(/;
const SKIP_LINE = /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|describe)\(|@(?:pytest\.mark\.)?skip\b|\.only\(/;

function hunkName(item: ReviewItem): string {
  return `${item.file} ${item.header.split(" @@")[0]} @@`;
}

function changedLines(item: ReviewItem, marker: "+" | "-"): string[] {
  return item.diff.split("\n").filter((line) => line.startsWith(marker) && !line.startsWith(marker.repeat(3))).map((line) => line.slice(1));
}

/** A test hunk that removes an assertion or adds a skip or an exclusive `.only`. */
function mayWeakenTest(item: ReviewItem): boolean {
  return changedLines(item, "-").some((line) => ASSERTION_LINE.test(line)) || changedLines(item, "+").some((line) => SKIP_LINE.test(line));
}

function isRead(item: ReviewItem): boolean {
  // Import-only hunks are wiring: whatever they enable is asked where it is used.
  return item.facts !== undefined && item.facts.language !== null && item.status !== "passed" && item.facts.importsOnly !== true;
}

/** The questions for one report, in report order, at most {@link MAX_REVIEW_QUESTIONS}. */
export function reviewQuestions(items: readonly ReviewItem[], intent?: PullRequestIntent, project?: ProjectContext): ReviewQuestion[] {
  const drafts: Omit<ReviewQuestion, "id">[] = [];
  const ask = (kind: QuestionKind, unitIds: readonly string[], text: string) =>
    drafts.push({ kind, unitIds, text, options: QUESTION_OPTIONS[kind] });
  const tests = items.filter((item) => isRead(item) && testLikeFile(item.file));
  const goal = intent?.title.trim() ?? "";

  // Project questions first: there are few, and each needs the agent to read beyond the diff.
  const firstRead = items.find((item) => isRead(item) && !testLikeFile(item.file)) ?? items.find(isRead);
  if (project !== undefined && firstRead !== undefined) {
    for (const revert of project.reverts.slice(0, MAX_HISTORY_QUESTIONS)) {
      const reason = revert.reason;
      const owner = reason.kind === "file" ? items.find((item) => item.file === reason.file && isRead(item)) : undefined;
      ask(
        "repeatsRevert",
        [(owner ?? firstRead).id],
        `Commit ${revert.commit} (${revert.date}) was a revert: "${revert.subject}". Read it (git show ${revert.commit}). ` +
          "Does this change reintroduce what was reverted, or a close variant of it?",
      );
    }
    if (project.guidelines.length > 0) {
      ask(
        "followsGuidelines",
        [firstRead.id],
        `This repository has contributor guidelines: ${project.guidelines.join(", ")}. Read the ones that apply to the changed files. ` +
          "Does the change follow them (process, versioning or preview rules, style, tests, documentation)?",
      );
    }
    for (const convention of project.conventions) {
      const owner = items.find((item) => item.file === convention.file) ?? firstRead;
      const names = convention.common.map((entry) => `${entry.name} (${entry.peers}/${convention.peers})`).join(", ");
      ask(
        "followsConvention",
        [owner.id],
        `Most files matching ${convention.pattern} use ${names}; the new ${convention.file} uses none of them. ` +
          "Read two or three of those files. Should the new file follow their pattern?",
      );
    }
  }

  let fixQuestions = 0;
  for (const item of items) {
    if (!isRead(item)) continue;
    const language = item.facts!.language!;
    // Tests and their snapshots change with the code they check; asked about in code only.
    const origin = testLikeFile(item.file) ? undefined : item.history?.origins.find((entry) => entry.notable);
    if (origin !== undefined && fixQuestions < MAX_HISTORY_QUESTIONS) {
      fixQuestions += 1;
      ask(
        "undoesFix",
        [item.id],
        `${hunkName(item)} removes or rewrites ${origin.lines} line(s) last changed by ${origin.commit} (${origin.date}) "${origin.subject}". ` +
          `Read that commit (git show ${origin.commit}). Does this hunk undo what it did, without keeping its purpose some other way?`,
      );
    }
    if (testLikeFile(item.file)) {
      if (mayWeakenTest(item)) {
        ask("testWeakened", [item.id], `Does this change to ${hunkName(item)} weaken what the test checks (a removed or loosened assertion, a skipped or exclusive test)?`);
      }
      continue;
    }
    if (language === "prose") {
      const yes = factQuestionsFor("prose").filter((question) => item.facts!.answers[question] === "yes");
      if (yes.includes("instructionChanged") || yes.includes("limitChanged")) {
        ask("docMatchesCode", [item.id], `Does what ${hunkName(item)} now tells readers match how the code actually behaves?`);
      }
    } else if (item.status === "attention") {
      ask(
        "behaviorChange",
        [item.id],
        `Taken on its own, does ${hunkName(item)} change what callers, users, or operators of this code observe or must provide? ` +
          "Answer no-behavior-change when the hunk only adds or renames a declaration (a new function, type, field, " +
          "import, or injected dependency) that other hunks put to use: the use is asked about where it happens.",
      );
      if (language !== "config") {
        ask(
          "testCoverage",
          [item.id, ...tests.map((test) => test.id)],
          tests.length > 0
            ? `Does any test changed in this diff exercise the behavior ${hunkName(item)} changes?`
            : `No test file changed in this diff. Does an existing test exercise the behavior ${hunkName(item)} changes?`,
        );
      }
    }
    if (goal !== "" && item.status === "attention") {
      ask(
        "intentFit",
        [item.id],
        `How does ${hunkName(item)} relate to the stated goal: "${goal}"? ` +
          "serves: it makes the change the goal describes. supports: it does not make that change itself, but a " +
          "change that does relies on it (a helper, type, query, wiring, or refactor) or it is a related fix for the " +
          "same problem. unrelated: neither. contradicts: it works against the goal.",
      );
    }
  }
  return drafts.slice(0, MAX_REVIEW_QUESTIONS).map((draft, index) => ({ id: `q${index + 1}`, ...draft }));
}
