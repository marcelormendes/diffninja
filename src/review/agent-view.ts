import type { ChangeFacts } from "./change-facts.js";
import type { IntentClaim, ReviewAgendaEntry } from "./evidence-types.js";
import type { ExplainedFunction } from "./explanation.js";
import type { ConnectedSnapshot } from "./github.js";
import { STATUS_REASON } from "./pipeline.js";
import type { QuestionKind, ReviewQuestion } from "./questions.js";
import type { ReviewContextNode, ReviewItem, ReviewReport, ReviewStatus } from "./types.js";

/**
 * The review as the reviewing agent reads it, which is not the review the pages
 * draw. Claude Code, for one, sends a tool result to its model only when it is
 * under 25,000 tokens and otherwise saves it to a file the model reads in
 * pieces; a report of a six-hunk pull request used to be 258,000 characters,
 * nine tenths of it call flows and definitions the agent almost never read. So
 * the agent is sent what it reviews with (every hunk's diff, reasons, facts and
 * history, the questions, the functions list, the project context) and nothing
 * twice, and asks for the rest with read_items. The server keeps the whole
 * report: the pages, finish_review's checks, and read_items all use it.
 *
 * Same report, same view: nothing here depends on time, order of calls, or the
 * client.
 */

/** What an agent reads in one tool result: Claude Code counts no tokens up to 50,000 characters (it estimates four per token against a 12,500-token threshold). */
export const AGENT_RESULT_CHARS = 45_000;
/** Most ids one read_items call takes. */
export const MAX_READ_ITEMS = 50;

/** The facts of one hunk as the agent is sent them: only the "yes" answers, and no cited lines, which `reasons` already quotes. */
export interface AgentFacts {
  readonly language: ChangeFacts["language"];
  readonly inert: ChangeFacts["inert"];
  readonly importsOnly?: boolean;
  readonly answers: ChangeFacts["answers"];
}

/** A hunk without its call context; `header` only when the diff does not start with it. */
export type AgentItem = Omit<ReviewItem, "callFlow" | "contextNodes" | "header" | "facts"> & {
  header?: string;
  facts?: AgentFacts;
};

/** A hunk left out of a result too large to send whole: enough to place it in the order and ask for it. */
export interface AgentItemIndex {
  readonly id: string;
  readonly file: string;
  readonly status: ReviewStatus;
  readonly priority: number;
  readonly added: number;
  readonly removed: number;
  readonly leftOut: true;
}

/** Text that would repeat on every item, question, or claim, said once. */
export interface AgentGuide {
  /** What each status means, for every status an item of this report has; `reasons` leaves it out. */
  readonly statuses: Partial<Record<ReviewStatus, string>>;
  facts?: string;
  /** The instructions every question of one kind shares, left out of each one's text. */
  questions?: Partial<Record<QuestionKind, string>>;
  /** What each claim status means, left out of each claim. */
  claims?: Partial<Record<IntentClaim["status"], string>>;
}

/** A listed function: its id is `<file>#<name>`, so the two are not said again; `inTests` only when it is true. */
export interface AgentFunction {
  readonly id: ExplainedFunction["id"];
  name?: ExplainedFunction["name"];
  file?: ExplainedFunction["file"];
  readonly line: ExplainedFunction["line"];
  inTests?: true;
}

export type AgentReport = Omit<ReviewReport, "items" | "callFlow" | "callFlows" | "questions" | "evidence" | "functions"> & {
  items: Array<AgentItem | AgentItemIndex>;
  functions?: AgentFunction[];
  questions: ReviewQuestion[];
  evidence?: AgentEvidence;
  guide: AgentGuide;
  /** Set when hunks were left out to fit: how many, and how to read them. */
  paging?: { readonly inFull: number; readonly leftOut: number; readonly next: string };
};

type AgentEvidence = Omit<NonNullable<ReviewReport["evidence"]>, "agenda" | "intent"> & {
  agenda: Array<Omit<ReviewAgendaEntry, "evidence" | "context">>;
  intent: Omit<NonNullable<ReviewReport["evidence"]>["intent"], "claims"> & { claims: Array<Omit<IntentClaim, "explanation"> & Partial<Pick<IntentClaim, "explanation">>> };
};

export type AgentSnapshot = Omit<ConnectedSnapshot, "lines">;

const FACTS_GUIDE = "An item's facts.answers lists only the questions answered yes on its changed lines, and each yes quotes the changed line it rests on in the item's reasons. A question it leaves out was answered no, which never claims absence elsewhere. An item whose facts.language is null was not read, so nothing was answered and it reads uncertain.";
const PAGING_NEXT = `Call read_items with this reviewId and the ids of the items marked leftOut, at most ${MAX_READ_ITEMS} per call: it returns them in full, and says which did not fit so you can ask again.`;
/** Author claims kept when the result is over budget: they are navigation aids, not the review. */
const KEPT_CLAIMS = 20;
/** Review agenda entries kept when the result is over budget: past the first few they point at hunks the items already list. */
const KEPT_AGENDA = 20;
/**
 * The agenda's "read the remaining changes in this file" entries only list hunks
 * that items carries whole, so the agent is not sent them (nor is the connected
 * page, see connected-analysis.ts).
 */
const FILE_AGENDA = "agenda:hunks:";
/** Room a fitted view keeps for the warning and the paging note it gains: fixed sentences and a few counts. */
const FITTING_NOTES_CHARS = 800;
/** A shared tail shorter than this is left in every question: hoisting it would not pay for its key. */
const MIN_GUIDE_CHARS = 80;

/** Characters of the JSON a client reads; Claude Code measures a result by its string length. */
const charsOf = (value: AgentView | AgentItem | AgentItemIndex | FullItem | ReviewContextNode | string): number => JSON.stringify(value).length;

function agentFacts({ evidence: _evidence, answers, ...rest }: ChangeFacts): AgentFacts {
  return { ...rest, answers: Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer !== "no")) };
}

function agentItem(item: ReviewItem): AgentItem {
  const { callFlow: _flow, contextNodes: _nodes, header, facts, ...rest } = item;
  const shown: AgentItem = { ...rest, reasons: item.reasons.filter((reason) => reason !== STATUS_REASON[item.status]) };
  // Only a diff that does not open with its header (a binary or metadata change) needs it said apart.
  if (item.diff !== header && !item.diff.startsWith(`${header}\n`)) shown.header = header;
  if (facts !== undefined) shown.facts = agentFacts(facts);
  return shown;
}

function agentFunction({ id, name, file, line, inTests }: ExplainedFunction): AgentFunction {
  const shown: AgentFunction = { id, line };
  if (id !== `${file}#${name}`) Object.assign(shown, { name, file });
  if (inTests) shown.inTests = true;
  return shown;
}

function indexOf(item: AgentItem | AgentItemIndex): AgentItemIndex {
  return { id: item.id, file: item.file, status: item.status, priority: item.priority, added: item.added, removed: item.removed, leftOut: true };
}

/**
 * Where the text every question of a kind ends with starts, at a sentence: the
 * guide is said once and each question keeps the sentence that names its hunk.
 * Undefined when the kind is asked once or its questions share no long tail.
 */
function sharedTail(texts: readonly string[]): string | undefined {
  const [first] = texts;
  if (first === undefined || texts.length < 2) return undefined;
  let common = first.length;
  for (const text of texts.slice(1)) {
    let length = 0;
    while (length < common && length < text.length && text[text.length - 1 - length] === first[first.length - 1 - length]) length += 1;
    common = length;
  }
  for (let start = first.length - common + 2; start <= first.length - MIN_GUIDE_CHARS; start += 1) {
    const boundary = first.slice(start - 2, start);
    if (boundary === ". " || boundary === "? ") return first.slice(start);
  }
  return undefined;
}

/** Questions with their shared tails cut, and the tails by kind. */
interface GuidedQuestions {
  readonly questions: ReviewQuestion[];
  readonly guides: Partial<Record<QuestionKind, string>>;
}

function questionGuides(questions: readonly ReviewQuestion[]): GuidedQuestions {
  const guides: Partial<Record<QuestionKind, string>> = {};
  for (const kind of new Set(questions.map((question) => question.kind))) {
    const tail = sharedTail(questions.filter((question) => question.kind === kind).map((question) => question.text));
    if (tail !== undefined) guides[kind] = tail;
  }
  const shown = questions.map((question) => {
    const tail = guides[question.kind];
    return tail === undefined ? question : { ...question, text: question.text.slice(0, -tail.length).trimEnd() };
  });
  return { questions: shown, guides };
}

/** Claims without the explanation their status shares, and those explanations by status. */
interface GuidedClaims {
  readonly claims: AgentEvidence["intent"]["claims"];
  readonly guides: Partial<Record<IntentClaim["status"], string>>;
}

function claimGuides(claims: readonly IntentClaim[]): GuidedClaims {
  const guides: Partial<Record<IntentClaim["status"], string>> = {};
  for (const status of new Set(claims.map((claim) => claim.status))) {
    const explanations = new Set(claims.filter((claim) => claim.status === status).map((claim) => claim.explanation));
    if (explanations.size === 1) guides[status] = [...explanations][0];
  }
  const shown = claims.map(({ explanation, ...claim }) => (guides[claim.status] === undefined ? { ...claim, explanation } : claim));
  return { claims: shown, guides };
}

/**
 * The report without what the agent does not review with and without repeats:
 * call flows and definitions (read_items has them), each fact's cited line
 * (its reason quotes it), each status's meaning, each shared question and claim
 * explanation, a function's file and name (its id holds both), and the
 * agenda's excerpts and per-file entries for hunks the items carry whole. With a
 * snapshot, `pr` goes too, since the snapshot carries the same title and body.
 */
export function agentReport(report: ReviewReport, connected: boolean): AgentReport {
  const { items, callFlow: _flow, callFlows: _flows, questions, evidence, pr, functions, ...rest } = report;
  const statuses: Partial<Record<ReviewStatus, string>> = {};
  for (const item of items) if (item.reasons.includes(STATUS_REASON[item.status])) statuses[item.status] = STATUS_REASON[item.status];
  const asked = questionGuides(questions);
  const guide: AgentGuide = { statuses };
  if (items.some((item) => item.facts !== undefined)) guide.facts = FACTS_GUIDE;
  if (Object.keys(asked.guides).length > 0) guide.questions = asked.guides;
  const shown: AgentReport = { ...rest, items: items.map(agentItem), questions: asked.questions, guide };
  if (!connected && pr !== undefined) shown.pr = pr;
  if (functions !== undefined) shown.functions = functions.map(agentFunction);
  if (evidence !== undefined) {
    const linked = claimGuides(evidence.intent.claims);
    if (Object.keys(linked.guides).length > 0) guide.claims = linked.guides;
    shown.evidence = {
      ...evidence,
      agenda: evidence.agenda.filter((entry) => !entry.id.startsWith(FILE_AGENDA)).map(({ evidence: _excerpts, context: _context, ...entry }) => entry),
      intent: { ...evidence.intent, claims: linked.claims },
    };
  }
  return shown;
}

export interface AgentView {
  readonly snapshot: AgentSnapshot | undefined;
  readonly report: AgentReport;
}

/**
 * Fit the view under `budget` characters, the notes it gains included, cheapest first: the author's claims
 * past the first few, the agenda past the first few, then whole hunks from the
 * lowest-ranked up, each kept as an entry the order can still name and marked
 * leftOut, with `paging` saying how to read them; a hunk left out on the way
 * that fits once a larger one above it is out is put back. Every hunk stays listed, so a
 * change of thousands of hunks can stay over the limit; the caller's hard
 * limit decides whether it is sent at all.
 */
export function fitAgentView(view: AgentView, budget: number): AgentView {
  let current = view;
  let size = charsOf(current);
  if (size <= budget) return current;
  const limit = budget - FITTING_NOTES_CHARS;
  const notes: string[] = [];
  const evidence = current.report.evidence;
  if (evidence !== undefined && evidence.intent.claims.length > KEPT_CLAIMS) {
    notes.push(`only the first ${KEPT_CLAIMS} of ${evidence.intent.claims.length} statements from the pull request text were kept`);
    current = { ...current, report: { ...current.report, evidence: { ...evidence, intent: { ...evidence.intent, claims: evidence.intent.claims.slice(0, KEPT_CLAIMS) } } } };
    size = charsOf(current);
  }
  const agenda = current.report.evidence;
  if (size > limit && agenda !== undefined && agenda.agenda.length > KEPT_AGENDA) {
    notes.push(`only the first ${KEPT_AGENDA} of ${agenda.agenda.length} review agenda entries were kept; items lists every hunk`);
    current = { ...current, report: { ...current.report, evidence: { ...agenda, agenda: agenda.agenda.slice(0, KEPT_AGENDA) } } };
    size = charsOf(current);
  }
  const whole = current.report.items;
  const items = [...whole];
  const saving = whole.map((item) => charsOf(item) - charsOf(indexOf(item)));
  let leftOut = 0;
  // Each hunk is measured once and the size kept by subtraction, so thousands of hunks are not serialized again per hunk.
  for (let index = items.length - 1; index >= 0 && size > limit; index -= 1) {
    items[index] = indexOf(whole[index]!);
    size -= saving[index]!;
    leftOut += 1;
  }
  // A hunk too large to fit must not take the smaller ones ranked below it along: each is put back, best-ranked first, while it fits.
  for (let index = 0; index < items.length && leftOut > 0; index += 1) {
    if (!("leftOut" in items[index]!) || size + saving[index]! > limit) continue;
    items[index] = whole[index]!;
    size += saving[index]!;
    leftOut -= 1;
  }
  const fitted: AgentReport = { ...current.report, items };
  if (leftOut > 0) {
    fitted.paging = { inFull: items.length - leftOut, leftOut, next: PAGING_NEXT };
    notes.push(`${leftOut} of the ${items.length} hunks, the lowest-ranked and those too large to fit, are listed by id only (marked leftOut); read_items returns them`);
  }
  fitted.warnings = [...current.report.warnings, `This result was over ${AGENT_RESULT_CHARS.toLocaleString("en-US")} characters, more than an agent reads in one tool result, so ${notes.join("; ")}. The review page has the complete report.`];
  return { ...current, report: fitted };
}

/** A hunk as read_items returns it: as the report holds it, with its call context only when asked. */
export type FullItem = Omit<ReviewItem, "callFlow" | "contextNodes"> & Partial<Pick<ReviewItem, "callFlow" | "contextNodes">>;

export interface ReadItems {
  readonly items: FullItem[];
  /** Asked for and not sent, in the order asked: they did not fit in this result. */
  readonly notReturned: string[];
  /** What was cut from a hunk too large to send whole. */
  readonly trimmed: string[];
}

/**
 * The asked hunks in full, in the order asked, as many as fit in `limit`
 * characters, and at least the first: a hunk that alone is over the limit loses
 * its least important context nodes, then its last call-flow blocks, then the
 * end of its diff, and says so. An id the review does not have, or one asked
 * twice, refuses the whole call.
 */
export function readItems(items: readonly ReviewItem[], ids: readonly string[], context: boolean, limit: number): ReadItems {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (!byId.has(id)) throw new Error(`ids[${index}] is not an item of this review; use the ids in the review_diff result's items.`);
    if (seen.has(id)) throw new Error(`ids[${index}] repeats an id; name each item once.`);
    seen.add(id);
  });
  const sent: FullItem[] = [];
  const trimmed: string[] = [];
  let size = 0;
  let index = 0;
  for (; index < ids.length; index += 1) {
    const { callFlow, contextNodes, ...rest } = byId.get(ids[index]!)!;
    let item: FullItem = rest;
    if (context) item = { ...rest, callFlow, contextNodes };
    // The comma between items counts too.
    if (size + charsOf(item) + 1 > limit) {
      if (sent.length > 0) break;
      const cut = cutToFit(item, limit);
      item = cut.item;
      if (cut.note !== undefined) trimmed.push(cut.note);
    }
    sent.push(item);
    size += charsOf(item) + 1;
  }
  return { items: sent, notReturned: ids.slice(index), trimmed };
}

/** One hunk cut to fit a read, and what was cut. */
interface CutItem {
  readonly item: FullItem;
  readonly note?: string;
}

/**
 * A hunk cut under `limit`: its last context nodes first (the report lists the
 * most related first), then its last call-flow blocks, then the end of its diff.
 * Each part is measured once and the size kept by subtraction.
 */
function cutToFit(item: FullItem, limit: number): CutItem {
  let size = charsOf(item);
  const nodes = [...(item.contextNodes ?? [])];
  const flow = [...(item.callFlow ?? [])];
  while (size > limit && nodes.length > 0) size -= charsOf(nodes.pop()!) + 1;
  while (size > limit && flow.length > 0) size -= charsOf(flow.pop()!) + 1;
  let next: FullItem = { ...item };
  if (item.contextNodes !== undefined) next.contextNodes = nodes;
  if (item.callFlow !== undefined) next.callFlow = flow;
  const parts: string[] = [];
  if (item.contextNodes !== undefined && nodes.length < item.contextNodes.length) parts.push(`${item.contextNodes.length - nodes.length} of its ${item.contextNodes.length} context nodes, the least related`);
  if (item.callFlow !== undefined && flow.length < item.callFlow.length) parts.push(`${item.callFlow.length - flow.length} of its ${item.callFlow.length} call-flow blocks, the last`);
  if (size > limit) {
    const lines = item.diff.split("\n");
    const note = (left: number) => `\n[${left} more lines of this hunk were left out to fit; read them in the repository at ${item.file}.]`;
    // A line costs its escaped text and the escaped line break before it.
    let kept = lines.length;
    while (kept > 1 && size + charsOf(note(lines.length - kept)) > limit) {
      kept -= 1;
      size -= charsOf(lines[kept]!);
    }
    next = { ...next, diff: lines.slice(0, kept).join("\n") + note(lines.length - kept) };
    parts.push(`the last ${lines.length - kept} of its ${lines.length} diff lines`);
  }
  if (parts.length === 0) return { item: next };
  return { item: next, note: `${item.id} was too large to send whole, so it leaves out ${parts.join(", ")}.` };
}
