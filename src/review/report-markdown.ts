/**
 * A short Markdown summary of a finished review, for a person who cannot open
 * the pages on the agent's machine: a web or phone client of an agent that runs
 * somewhere else. The agent shows it in its reply, so the person's chat client
 * renders it.
 *
 * Nothing here may make that client load or link to anything. Text written by
 * the pull request's author or taken from the diff (title, paths) goes only
 * inside code spans, where Markdown builds no link, image, or HTML. The agent's
 * own text (summary, comments, rules) can still be steered by what it read, so
 * it gets every Markdown character escaped and any web address put in a code
 * span. The one link is the pull request's own page on github.com, rebuilt from
 * checked parts. Hidden characters are shown as ⟦U+XXXX⟧ markers throughout.
 */
import { visibleControls } from "./hidden-characters.js";
import { pullRequestOf } from "./pull-request-ref.js";
import type { ReviewReport, ReviewStatus, SuggestedComment } from "./types.js";

/** Hunks the summary lists in reading order; the full report has the rest. */
export const MARKDOWN_HUNKS = 10;
/** Business rules the summary lists. */
export const MARKDOWN_RULES = 8;
/** Longest piece of quoted text (a title, a path) before it is cut. */
const MAX_QUOTED_CHARS = 200;

const STATUS_WORD = {
  attention: "needs attention",
  uncertain: "uncertain",
  low: "low risk",
  passed: "passed",
} satisfies Record<ReviewStatus, string>;

/** Where the full report and the draft review were written, when the person turned report files on. */
export interface ReportFileLocations {
  readonly report: string;
  readonly draftReview?: string;
}

export interface MarkdownOptions {
  readonly files?: ReportFileLocations;
  /** Why no file was written, when one was asked for. */
  readonly fileProblem?: string;
}

/** Cut text to `max` characters, marking the cut. */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * A code span holding `text` literally. The fence is one backtick longer than
 * the longest run inside, and a space pads text that starts or ends with a
 * backtick or a space, which CommonMark then strips, so nothing can close the
 * span early.
 */
export function mdCode(text: string, max = MAX_QUOTED_CHARS): string {
  const shown = clip(visibleControls(text).replace(/[\r\n]+/g, " "), max);
  if (shown === "") return "(empty)";
  const longest = Math.max(0, ...(shown.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(shown) ? " " : "";
  return `${fence}${pad}${shown}${pad}${fence}`;
}

/** Every character that can open Markdown or HTML: links, images, emphasis, code, tags, tables, entities, math. */
const MARKDOWN_SIGNIFICANT = /[\\`*_[\]<>!#|~&$]/g;
/** A web address a client could turn into a link by itself (GFM autolinks). */
const WEB_ADDRESS = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;

/**
 * The agent's own text, shown as written but inert: every Markdown character
 * escaped, so it builds no link, image, tag, or emphasis, and every web address
 * in a code span, so no client turns it into a link.
 */
export function mdProse(text: string): string {
  const shown = visibleControls(text).replace(/\s+/g, " ").trim();
  let out = "";
  let last = 0;
  for (const match of shown.matchAll(WEB_ADDRESS)) {
    out += shown.slice(last, match.index).replace(MARKDOWN_SIGNIFICANT, "\\$&");
    out += mdCode(match[0]);
    last = match.index + match[0].length;
  }
  return out + shown.slice(last).replace(MARKDOWN_SIGNIFICANT, "\\$&");
}

/** A fenced block for a command, fenced longer than any backtick run inside it. */
function mdBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${visibleControls(text)}\n${fence}`;
}

/** A path quoted for a POSIX shell: single quotes, with each single quote closed, escaped and reopened. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The command that creates the draft review from its file. It runs only when the person runs it. */
export function draftReviewCommand(owner: string, repo: string, number: number, file: string): string {
  return `gh api --hostname github.com --method POST repos/${owner}/${repo}/pulls/${number}/reviews --input ${shellQuote(file)}`;
}

function sideWord(comment: SuggestedComment): string {
  return comment.side === "RIGHT" ? "new" : "old";
}

/**
 * The Markdown summary of a finished review. It stays a few kilobytes at most:
 * the goal, the comments that block the merge, the first hunks in reading
 * order, the business rules, and how to finish the review without the page.
 */
export function renderReportMarkdown(report: ReviewReport, options: MarkdownOptions = {}): string {
  const pr = pullRequestOf(report);
  const lines: string[] = [];
  const heading = pr === undefined
    ? `## diffninja review: ${mdCode(report.title || "untitled diff")}`
    : `## diffninja review of ${mdCode(`${pr.owner}/${pr.repo}#${pr.number}`)}: ${mdCode(report.title || "untitled pull request")}`;
  lines.push(heading, "");

  const summary = report.agentSummary;
  if (summary !== undefined) {
    lines.push(`**Goal**, as ${mdProse(summary.summarizedBy)} read the pull request's own title and description (a reading, not a verified claim): ${mdProse(summary.text)}`, "");
  }

  // A static report has nothing to post its comments to, so they are notes, and
  // it says nothing when there are none.
  const comments = report.agentComments?.comments ?? [];
  if (pr !== undefined || comments.length > 0) {
    const by = report.agentComments === undefined ? "the reviewing agent" : mdProse(report.agentComments.suggestedBy);
    const yours = pr === undefined ? "There is no pull request to post them to; they are notes for you" : "None is posted; each is yours to add, edit, or drop";
    if (comments.length === 0) {
      lines.push(`**Comments that block the merge:** none, in ${by}'s reading.`, "");
    } else {
      lines.push(`**Comments that block the merge** (${comments.length}), suggested by ${by}. ${yours}:`, "");
      comments.forEach((comment, index) => {
        lines.push(`${index + 1}. ${mdCode(comment.path)} line ${comment.line} (${sideWord(comment)} side): ${mdProse(comment.body)}`);
        lines.push(`   - Why it blocks (${comment.evidence === "ran" ? "reproduced" : "traced by reading"}): ${mdProse(comment.scenario)}`);
        lines.push(`   - Not a problem if: ${mdProse(comment.unlessTrue)}`);
      });
      lines.push("");
    }
  }

  if (report.items.length > 0) {
    const shown = report.items.slice(0, MARKDOWN_HUNKS);
    const whose = report.agentOrder === undefined ? "diffninja's order" : `the order ${mdProse(report.agentOrder.orderedBy)} recommends`;
    const more = report.items.length > shown.length ? `, first ${shown.length} of ${report.items.length}` : "";
    lines.push(`**Read the hunks in this order** (${whose}${more}):`, "");
    shown.forEach((item, index) => {
      lines.push(`${index + 1}. ${mdCode(`${item.file}:${item.newStart}`)} +${item.added} -${item.removed}, ${STATUS_WORD[item.status]}`);
    });
    lines.push("");
  } else {
    lines.push("No hunks were reviewed in this diff.", "");
  }

  const rules = report.agentExplanation?.rules ?? [];
  if (rules.length > 0) {
    const shown = rules.slice(0, MARKDOWN_RULES);
    const more = rules.length > shown.length ? `, first ${shown.length} of ${rules.length}` : "";
    lines.push(`**Business rules this change touches**, as ${mdProse(report.agentExplanation!.explainedBy)} explains them${more}:`, "");
    for (const rule of shown) {
      const before = rule.change === "changed" && rule.before !== undefined ? ` (before: ${mdProse(rule.before)})` : "";
      lines.push(`- ${rule.change}: ${mdProse(rule.text)}${before}`);
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push(`diffninja has ${report.warnings.length} ${report.warnings.length === 1 ? "warning" : "warnings"} about this review; the full report lists ${report.warnings.length === 1 ? "it" : "them"}.`, "");
  }

  if (options.files !== undefined) {
    lines.push(`**Full report:** one HTML file, readable only by your user on the agent's machine. Open it in a browser there, or copy it to your device. It loads nothing from the network.`, "", mdBlock(options.files.report), "");
  } else if (options.fileProblem !== undefined) {
    lines.push(`**Full report:** no file was written. ${mdProse(options.fileProblem)}`, "");
  }

  if (pr !== undefined) {
    lines.push("**To finish your review without the review page:**", "");
    lines.push(`- On GitHub: open <${pr.url}/files>, read the changes, mark each file Viewed there, add the comments above that you agree with on the lines named, and submit.`);
    if (options.files?.draftReview !== undefined) {
      lines.push(
        "- Or, from a terminal on the agent's machine, as yourself: this command puts the comments above into a draft review on GitHub. Only you can see the draft; nothing is published until you open the pull request and submit it there. Read the draft file before you run it.",
        "",
        mdBlock(draftReviewCommand(pr.owner, pr.repo, pr.number, options.files.draftReview)),
      );
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
