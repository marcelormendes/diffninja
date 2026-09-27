/**
 * The reviewing agent's business explanation of a change: what each function
 * does for the product in plain words, the business processes the change
 * touches drawn as steps and decisions, and the business rules it adds, changes,
 * or removes.
 *
 * diffninja never writes any of this. It lists the functions a reader meets in
 * the call flows and around each hunk (`functionsOf`), and the host agent's
 * model, which read the code, explains them. Everything here is mechanical:
 * the list is a pure function of the report, and the checks bound shape and
 * size, require plain one-line prose instead of code names, and make every
 * reference (a function, a hunk, a next step) point at something that exists.
 * Nothing here judges whether the explanation is right; the pages show it
 * attributed to the client that wrote it, as its reading.
 */

import { testLikeFile } from "./file-role.js";
import type { CallFlowNode, ReviewReport } from "./types.js";

/** Most functions one review asks the agent to explain; changed code first. */
export const MAX_EXPLAINED_FUNCTIONS = 40;
/** Most processes one explanation draws: the flows a pull request actually touches. */
export const MAX_PROCESSES = 4;
/** Most steps one process draws; past this a diagram stops being readable. */
export const MAX_PROCESS_STEPS = 16;
export const MIN_PROCESS_STEPS = 2;
/** Most business rules one explanation lists. */
export const MAX_RULES = 12;
/** Most outgoing arrows one step has: a decision's branches, not a switch table. */
export const MAX_STEP_EXITS = 4;

export const MAX_PURPOSE_CHARS = 200;
export const MAX_TITLE_CHARS = 80;
export const MAX_STEP_CHARS = 90;
export const MAX_DETAIL_CHARS = 200;
export const MAX_RULE_CHARS = 200;
export const MAX_BRANCH_CHARS = 24;

export type ExplanationChange = "unchanged" | "added" | "changed" | "removed";
export type StepKind = "start" | "action" | "decision" | "end";

export const EXPLANATION_CHANGES: readonly ExplanationChange[] = ["unchanged", "added", "changed", "removed"];
export const STEP_KINDS: readonly StepKind[] = ["start", "action", "decision", "end"];

/**
 * One function the agent explains. Its id is readable and deterministic,
 * `<defining file>#<name>`, so an agent can name it from the code alone.
 */
export interface ExplainedFunction {
  readonly id: string;
  /** The function's own name, as the code spells it. */
  readonly name: string;
  /** The file that defines it. */
  readonly file: string;
  /** 1-based definition line at the revision the report read it from. */
  readonly line: number;
  /** True when the definition lives in a test file (by path convention). */
  readonly inTests: boolean;
}

export interface StepExit {
  readonly to: string;
  /** The branch's condition in a word or two, such as "yes", "paid", or "out of stock". */
  readonly when?: string;
}

export interface ProcessStep {
  readonly id: string;
  readonly kind: StepKind;
  /** What happens, as a person would say it. */
  readonly text: string;
  readonly change: ExplanationChange;
  /** Why, or the rule this step applies. */
  detail?: string;
  /** For a changed step: how it worked before this change. */
  before?: string;
  /** Function ids from `report.functions` that carry this step out. */
  functions?: readonly string[];
  /** Hunk ids from `report.items` that change this step. */
  hunks?: readonly string[];
  /** Where the process goes next; omitted on an action or start, it continues to the next step listed. */
  next?: readonly StepExit[];
}

export interface BusinessProcess {
  readonly title: string;
  readonly steps: readonly ProcessStep[];
}

export interface BusinessRule {
  readonly text: string;
  readonly change: ExplanationChange;
  /** For a changed rule: what the rule was before. */
  before?: string;
  hunks?: readonly string[];
}

export interface FunctionPurpose {
  readonly id: string;
  readonly purpose: string;
}

/** The explanation as the agent sends it. */
export interface ExplanationInput {
  readonly functions: readonly FunctionPurpose[];
  readonly processes: readonly BusinessProcess[];
  readonly rules: readonly BusinessRule[];
}

/** The accepted explanation, attributed to the MCP client that wrote it. */
export interface AgentExplanation extends ExplanationInput {
  readonly explainedBy: string;
  readonly explainedAt: string;
}

/** The explanation's counts, as finish_review and record_explanation report them. */
export interface ExplanationCounts {
  readonly functions: number;
  readonly processes: number;
  readonly steps: number;
  readonly rules: number;
}

/** A function's name without its receiver: `self.save` and `Order.save` are the same `save`. */
function shortName(name: string): string {
  const bare = name.replace(/^(?:before|after):/, "");
  const segments = bare.split(/[.:#]+/).filter((segment) => segment !== "");
  return segments.length === 0 ? bare : segments[segments.length - 1];
}

export function functionId(file: string, name: string): string {
  return `${file}#${shortName(name)}`;
}

/** The function id a call-flow node's resolved definition has, or undefined when it resolved none. */
export function nodeFunctionId(node: CallFlowNode): string | undefined {
  return node.source === undefined ? undefined : functionId(node.source.file, node.key);
}

/**
 * Every function a reader meets in this report, once, capped at
 * {@link MAX_EXPLAINED_FUNCTIONS}: the definitions around each hunk in report
 * order (the changed code, its callers and callees), then the resolved
 * definitions in the call flows. Calls with no definition in the repository
 * (library and framework calls) are not listed: there is nothing of the
 * project's own to explain. Functions outside test files come first, so a cap
 * cuts test helpers before product code.
 */
export function functionsOf(report: Pick<ReviewReport, "items" | "callFlows">): ExplainedFunction[] {
  const found = new Map<string, ExplainedFunction>();
  const add = (file: string, name: string, line: number) => {
    const id = functionId(file, name);
    if (found.has(id) || shortName(name) === "") return;
    found.set(id, { id, name: shortName(name), file, line, inTests: testLikeFile(file) });
  };
  for (const item of report.items) {
    for (const node of item.contextNodes ?? []) add(node.file, node.key, node.line);
  }
  const walk = (node: CallFlowNode) => {
    if (node.source !== undefined) add(node.source.file, node.key, node.source.line);
    node.children.forEach(walk);
  };
  for (const entry of report.callFlows) entry.trees.forEach(walk);
  const all = [...found.values()];
  return [...all.filter((fn) => !fn.inTests), ...all.filter((fn) => fn.inTests)].slice(0, MAX_EXPLAINED_FUNCTIONS);
}

const CONTROL_CHARACTERS = /[^\P{Cc}]/u;
/** Markdown or HTML a person would not type into one line of plain explanation. */
const SCAFFOLDING = /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)|(?:\*\*|__|```|~~~|<\/?[a-z][^>]*>|!?\[[^\]]*\]\()/i;
/** Code a reader would have to decode: a call, a backtick span, a snake_case name, or a source path. */
const CODE_LIKE = [
  { pattern: /`/, what: "a code span" },
  // Glued to its parenthesis, as code writes it; prose puts a space before one.
  { pattern: /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/, what: "a function call" },
  { pattern: /\b[a-z][a-z0-9]*_[a-z0-9_]*[a-z0-9]\b/, what: "a snake_case name" },
  // A path needs a directory, so product names such as Node.js stay prose.
  { pattern: /\b[\w.-]+\/[\w./-]*\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|kts|rs|cs|php|swift|scala|c|cc|cpp|h|hpp|m|ex|exs|lua|pl|sol|zig|hs|ml)\b/, what: "a source file path" },
];

/** Why one field is not plain prose, or undefined when it is. */
function proseProblem(text: string, max: number): string | undefined {
  if (text.trim() === "") return "is empty";
  if (CONTROL_CHARACTERS.test(text)) return "must be one line of plain text, with no line breaks, tabs, or control characters";
  if (text.trim().length > max) return `is longer than ${max} characters`;
  if (SCAFFOLDING.test(text)) return "uses Markdown or HTML formatting; write plain prose";
  for (const { pattern, what } of CODE_LIKE) {
    const match = pattern.exec(text);
    if (match !== null) return `reads like code (${what}: "${match[0]}"); say what it does for the business or the user in plain words, not the code's names`;
  }
  return undefined;
}

function checkProse(where: string, text: string | undefined, max: number, required: boolean): void {
  if (text === undefined) {
    if (required) throw new Error(`${where} is missing.`);
    return;
  }
  const problem = proseProblem(text, max);
  if (problem !== undefined) throw new Error(`${where} ${problem}.`);
}

function checkHunks(where: string, hunks: readonly string[] | undefined, items: ReadonlySet<string>): void {
  hunks?.forEach((id, index) => {
    if (!items.has(id)) throw new Error(`${where}.hunks[${index}] names a hunk this review does not have; use an items[].id.`);
  });
}

function checkChange(where: string, change: string, before: string | undefined): void {
  if (!EXPLANATION_CHANGES.some((known) => known === change)) {
    throw new Error(`${where}.change must be one of ${EXPLANATION_CHANGES.join(", ")}.`);
  }
  if (before !== undefined && change !== "changed") throw new Error(`${where}.before is only for a changed ${where.includes("rules") ? "rule" : "step"}.`);
}

function checkProcess(process: BusinessProcess, at: number, functions: ReadonlySet<string>, items: ReadonlySet<string>): void {
  const where = `processes[${at}]`;
  checkProse(`${where}.title`, process.title, MAX_TITLE_CHARS, true);
  const steps = process.steps;
  if (steps.length < MIN_PROCESS_STEPS || steps.length > MAX_PROCESS_STEPS) {
    throw new Error(`${where} has ${steps.length} steps; draw ${MIN_PROCESS_STEPS} to ${MAX_PROCESS_STEPS}.`);
  }
  const ids = new Set<string>();
  steps.forEach((step, index) => {
    if (ids.has(step.id)) throw new Error(`${where}.steps[${index}] repeats the step id ${step.id}.`);
    ids.add(step.id);
  });
  steps.forEach((step, index) => {
    const at = `${where}.steps[${index}]`;
    if (!STEP_KINDS.includes(step.kind)) throw new Error(`${at}.kind must be one of ${STEP_KINDS.join(", ")}.`);
    checkProse(`${at}.text`, step.text, MAX_STEP_CHARS, true);
    checkProse(`${at}.detail`, step.detail, MAX_DETAIL_CHARS, false);
    checkChange(at, step.change, step.before);
    checkProse(`${at}.before`, step.before, MAX_DETAIL_CHARS, false);
    step.functions?.forEach((id, fn) => {
      if (!functions.has(id)) throw new Error(`${at}.functions[${fn}] is not a function this review lists; use an id from functions.`);
    });
    checkHunks(at, step.hunks, items);
    const exits = step.next ?? [];
    if (exits.length > MAX_STEP_EXITS) throw new Error(`${at} has ${exits.length} exits; a step has at most ${MAX_STEP_EXITS}.`);
    const targets = new Set<string>();
    exits.forEach((exit, index) => {
      if (!ids.has(exit.to)) throw new Error(`${at}.next[${index}] goes to ${exit.to}, which is not a step of this process.`);
      if (targets.has(exit.to)) throw new Error(`${at}.next[${index}] repeats an exit to ${exit.to}.`);
      targets.add(exit.to);
      checkProse(`${at}.next[${index}].when`, exit.when, MAX_BRANCH_CHARS, step.kind === "decision");
    });
    if (step.kind === "decision" && exits.length < 2) throw new Error(`${at} is a decision, so it needs at least two next steps, each with when.`);
    if (step.kind === "end" && exits.length > 0) throw new Error(`${at} is an end, so it has no next steps.`);
  });
}

/**
 * Check a whole explanation against the review it explains. It must explain
 * every function the review lists, each once; draw one to
 * {@link MAX_PROCESSES} processes whose steps and exits all resolve; and list at
 * most {@link MAX_RULES} rules, a changed one saying what it was before. The
 * first problem refuses the whole explanation.
 */
export function checkExplanation(report: ReviewReport, input: ExplanationInput): void {
  const listedFunctions = report.functions ?? [];
  const listed = new Map(listedFunctions.map((fn) => [fn.id, fn]));
  const items = new Set(report.items.map((item) => item.id));
  const explained = new Set<string>();
  input.functions.forEach((entry, index) => {
    if (!listed.has(entry.id)) throw new Error(`explanation.functions[${index}] names ${JSON.stringify(entry.id)}, which is not in this review's functions list.`);
    if (explained.has(entry.id)) throw new Error(`explanation.functions[${index}] explains ${entry.id} a second time.`);
    explained.add(entry.id);
    checkProse(`explanation.functions[${index}].purpose`, entry.purpose, MAX_PURPOSE_CHARS, true);
  });
  const missing = listedFunctions.filter((fn) => !explained.has(fn.id));
  if (missing.length > 0) {
    throw new Error(`explanation.functions leaves out ${missing.length} of ${listedFunctions.length} functions, starting with ${missing[0].id}; explain every function the review lists, in one plain sentence each.`);
  }
  if (input.processes.length < 1 || input.processes.length > MAX_PROCESSES) {
    throw new Error(`explanation.processes has ${input.processes.length} processes; draw 1 to ${MAX_PROCESSES}: the business flows this change touches.`);
  }
  const functions = new Set(listed.keys());
  input.processes.forEach((process, index) => checkProcess(process, index, functions, items));
  if (input.rules.length > MAX_RULES) throw new Error(`explanation.rules has ${input.rules.length} rules; list at most ${MAX_RULES}.`);
  input.rules.forEach((rule, index) => {
    const where = `explanation.rules[${index}]`;
    checkProse(`${where}.text`, rule.text, MAX_RULE_CHARS, true);
    checkChange(where, rule.change, rule.before);
    if (rule.change === "changed") checkProse(`${where}.before`, rule.before, MAX_RULE_CHARS, true);
    checkHunks(where, rule.hunks, items);
  });
}

/** Trim every text field and drop empty optional lists, so the pages render exactly what was checked. */
export function normalizeExplanation(input: ExplanationInput, explainedBy: string): AgentExplanation {
  const processes = input.processes.map((process): BusinessProcess => ({
    title: process.title.trim(),
    steps: process.steps.map(normalizeStep),
  }));
  const rules = input.rules.map((rule): BusinessRule => {
    const kept: BusinessRule = { text: rule.text.trim(), change: rule.change };
    if (rule.before !== undefined) kept.before = rule.before.trim();
    if (rule.hunks !== undefined && rule.hunks.length > 0) kept.hunks = [...rule.hunks];
    return kept;
  });
  return {
    functions: input.functions.map(({ id, purpose }) => ({ id, purpose: purpose.trim() })),
    processes,
    rules,
    explainedBy,
    explainedAt: new Date().toISOString(),
  };
}

function normalizeStep(step: ProcessStep): ProcessStep {
  const kept: ProcessStep = { id: step.id, kind: step.kind, text: step.text.trim(), change: step.change };
  if (step.detail !== undefined) kept.detail = step.detail.trim();
  if (step.before !== undefined) kept.before = step.before.trim();
  if (step.functions !== undefined && step.functions.length > 0) kept.functions = [...step.functions];
  if (step.hunks !== undefined && step.hunks.length > 0) kept.hunks = [...step.hunks];
  if (step.next !== undefined && step.next.length > 0) {
    kept.next = step.next.map((exit) => (exit.when === undefined ? { to: exit.to } : { to: exit.to, when: exit.when.trim() }));
  }
  return kept;
}

export function explanationCounts(input: ExplanationInput): ExplanationCounts {
  return {
    functions: input.functions.length,
    processes: input.processes.length,
    steps: input.processes.reduce((total, process) => total + process.steps.length, 0),
    rules: input.rules.length,
  };
}

/** The agent's purpose for each function id, empty when there is no explanation. */
export function purposesOf(report: Pick<ReviewReport, "agentExplanation">): Map<string, string> {
  return new Map((report.agentExplanation?.functions ?? []).map((entry) => [entry.id, entry.purpose]));
}

/**
 * Where each step goes, with the implicit exits made explicit: a start or action
 * step with no `next` continues to the step listed after it. A decision always
 * lists its own exits, and an end has none.
 */
export function exitsOf(process: BusinessProcess): Map<string, readonly StepExit[]> {
  const exits = new Map<string, readonly StepExit[]>();
  process.steps.forEach((step, index) => {
    const following = process.steps[index + 1];
    if (step.next !== undefined && step.next.length > 0) exits.set(step.id, step.next);
    else if (step.kind !== "end" && step.kind !== "decision" && following !== undefined) exits.set(step.id, [{ to: following.id }]);
    else exits.set(step.id, []);
  });
  return exits;
}

/** Greedy word wrap; a word longer than the line gets a line of its own. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

/** At most `maxLines` wrapped lines; the last one ends in an ellipsis when text was cut. */
export function wrapPurpose(text: string, width: number, maxLines: number): string[] {
  const lines = wrapWords(text, Math.max(8, width));
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = last.length + 1 > width ? `${last.slice(0, Math.max(1, width - 1))}\u2026` : `${last}\u2026`;
  return kept;
}
