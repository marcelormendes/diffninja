import type { ReviewContextNode, ReviewItem, ReviewReport } from "./types.js";
import type { ProjectContext } from "./history.js";
import type {
  AutomaticFinding,
  CheckCoverage,
  EvidenceExcerpt,
  IntentClaim,
  IntentCrossCheck,
  PullRequestIntent,
  ReviewAgendaEntry,
} from "./evidence-types.js";
import { escapeHtml } from "./escape-html.js";

/**
 * The opening view of a review report: what the pull request says it does, what
 * the gathered evidence actually established, the short reading agenda, and the
 * automatic findings with the source behind them.
 *
 * Every string is a fixed template or escaped report data. The pull request
 * title, description and evidence text are untrusted input: they are escaped
 * into text nodes and never reach the page script. No numeric priority, model
 * probability or judgment value is printed here, and no check is described as
 * passing: a check states the scope it ran over and where its certainty ends,
 * and a finding carries its own limitation.
 *
 * The order is the reading order: outcome first, then the checks that ran and
 * what they did not cover, then the agenda, then the findings the agenda points
 * at. One piece of evidence is rendered once — an excerpt a finding already
 * carries is linked from the agenda instead of repeated, and a definition cited
 * by two agenda entries is shown in the first and linked from the second.
 */
export function renderBrief(report: ReviewReport): string {
  const evidence = report.evidence;
  const ranks = hunkRanks(report.items);
  const claimed = new Set<string>();
  // Finding id → the card that carries it, so an agenda entry links to the
  // finding it cites instead of repeating its evidence.
  const findingsAt = new Map<string, number>();
  if (evidence !== undefined) {
    for (const [index, finding] of evidence.findings.entries()) {
      findingsAt.set(finding.id, index + 1);
      for (const excerpt of finding.evidence) claimed.add(excerptKey(excerpt));
    }
  }
  return [
    '<h2 id="brief-outcome">Expected outcome</h2>',
    '<nav class="ev-links" aria-label="Evidence navigation"><a href="#brief-agenda-h">Read these first</a> · <a href="#brief-findings-h">Automatic findings</a> · <a href="#view-diff" data-view="diff">All hunks</a></nav>',
    report.pr === undefined
      ? '<p class="ev-note">No pull request metadata was recorded for this report.</p>'
      : renderPullRequest(report.pr),
    evidence === undefined
      ? '<p class="ev-note">No intent cross-check was recorded for this report.</p>'
      : renderIntent(evidence.intent, ranks),
    report.project === undefined ? "" : renderProject(report.project),
    evidence === undefined ? "" : renderChecks(evidence.checks),
    evidence === undefined ? "" : renderAgenda(evidence.agenda, ranks, claimed, findingsAt),
    evidence === undefined ? "" : renderFindings(evidence.findings, ranks),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * Repository context the diff does not show: related reverts, contributor
 * guidelines, and sibling-file conventions. Commit subjects and paths are
 * repository text, printed escaped; they are pointers to read, not verdicts.
 */
function renderProject(project: ProjectContext): string {
  const rows: string[] = [];
  for (const revert of project.reverts) {
    const why = revert.reason.kind === "file" ? `touched ${revert.reason.file}` : `shares the word “${revert.reason.term}”`;
    rows.push(`<li><span class="mono">${escapeHtml(revert.commit)}</span> ${escapeHtml(revert.date)} ${escapeHtml(revert.subject)} <span class="ev-note">(revert; ${escapeHtml(why)})</span></li>`);
  }
  for (const path of project.guidelines) rows.push(`<li>Guideline: <span class="mono">${escapeHtml(path)}</span></li>`);
  for (const convention of project.conventions) {
    const names = convention.common.map((entry) => `${entry.name} (${entry.peers}/${convention.peers})`).join(", ");
    rows.push(`<li>New <span class="mono">${escapeHtml(convention.file)}</span> uses none of what most <span class="mono">${escapeHtml(convention.pattern)}</span> files use: <span class="mono">${escapeHtml(names)}</span></li>`);
  }
  const shallow = project.history === "shallow"
    ? '<p class="ev-note">This clone is shallow: line history and reverts before its boundary are missing.</p>'
    : "";
  return [
    '<h2 id="brief-project">Project context</h2>',
    shallow,
    rows.length === 0 ? '<p class="ev-note">No related reverts, guidelines, or sibling conventions were found.</p>' : `<ul>${rows.join("")}</ul>`,
  ].filter((part) => part !== "").join("\n");
}

/**
 * The only external URL the report will ever emit: a github.com pull request
 * link. The URL arrives from whatever API caller produced the report, so it is
 * validated against this exact shape before it becomes an `href`; anything else
 * is printed as escaped text, so a `javascript:`, `data:`, userinfo or
 * off-host URL cannot become a link even if the report is opened locally.
 */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

/** The exact pull request metadata, as untrusted text under its own labels. */
function renderPullRequest(pr: PullRequestIntent): string {
  const range =
    pr.baseRef === undefined || pr.headRef === undefined
      ? ""
      : `<dt>Range</dt><dd class="mono">${escapeHtml(`${pr.baseRef} → ${pr.headRef}`)}</dd>`;
  const url = pr.url ?? "";
  const source =
    url === ""
      ? ""
      : `<dt>Source</dt><dd class="mono">${
          PULL_REQUEST_URL.test(url)
            ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a>`
            : escapeHtml(url)
        }</dd>`;
  return [
    '<h3 id="brief-pr">Pull request</h3>',
    '<dl class="pr-facts">',
    '<dt>Title</dt>',
    `<dd class="pr-title">${pr.title === "" ? '<span class="muted">The pull request has no title.</span>' : escapeHtml(pr.title)}</dd>`,
    source,
    range,
    "</dl>",
    pr.body === ""
      ? '<p class="ev-note">The pull request has no description. Nothing in it states an expected outcome.</p>'
      : [
          '<details class="pr-body">',
          '<summary>PR description — untrusted claims, including any generated notes</summary>',
          `<pre class="pr-text">${escapeHtml(pr.body)}</pre>`,
          "</details>",
        ].join("\n"),
  ].join("\n");
}

/** Verdict, the statements it is about, and the requirements nothing answered. */
function renderIntent(intent: IntentCrossCheck, ranks: Ranks): string {
  const verdict = VERDICT[intent.verdict];
  const claims = intent.claims.map((claim) => renderClaim(claim, ranks)).join("\n");
  return [
    '<h3 id="brief-intent-h">Intent cross-check</h3>',
    `<div class="intent intent-${verdict.tone}">`,
    `<p class="intent-verdict">${badge(verdict.label, verdict.tone, verdict.hint)}</p>`,
    `<p class="intent-summary">${escapeHtml(intent.summary)}</p>`,
    claims === "" ? '<p class="ev-note">No intent statements were extracted; inspect the exact description above.</p>' : `<details class="intent-claims"><summary>Compare ${intent.claims.length} intent statements with changed code</summary><ul class="claims">${claims}</ul></details>`,
    renderObligations(intent.obligations),
    "</div>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderClaim(claim: IntentClaim, ranks: Ranks): string {
  const status = CLAIM_STATUS[claim.status];
  const links = claim.unitIds.length === 0 ? "" : `<p class="claim-links">${hunkLinks(claim.unitIds, "", ranks)}</p>`;
  return [
    '<li class="claim">',
    '<p class="claim-head">',
    `<span class="claim-origin">${escapeHtml(ORIGIN_LABEL[claim.origin])}</span>`,
    badge(status.label, status.tone, status.hint),
    "</p>",
    `<p class="claim-text">${escapeHtml(claim.text)}</p>`,
    claim.explanation === "" ? "" : `<p class="claim-note">${escapeHtml(claim.explanation)}</p>`,
    links,
    "</li>",
  ]
    .filter((part) => part !== "")
    .join("");
}

/** Review decisions and proof obligations still open after static inspection. */
function renderObligations(obligations: readonly string[]): string {
  if (obligations.length === 0) return "";
  return [
    '<details class="obligations">',
    `<summary>${obligations.length} open review decision${obligations.length === 1 ? "" : "s"} and proof obligations</summary>`,
    `<ul>${obligations.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`,
    "</details>",
  ].join("");
}

/** What each check ran over, in the words of the check itself. */
function renderChecks(checks: readonly CheckCoverage[]): string {
  const rows = checks
    .map((check) => {
      const status = CHECK_STATUS[check.status];
      return [
        '<li class="check">',
        '<details><summary class="check-head">',
        `<span class="check-kind">${escapeHtml(KIND_LABEL[check.kind])}</span>`,
        badge(status.label, status.tone, status.hint),
        "</summary>",
        `<p class="check-detail">${escapeHtml(check.detail)}</p>`,
        "</details></li>",
      ].join("");
    })
    .join("\n");
  return [
    '<h3 id="brief-checks-h">Checks and their limits</h3>',
    rows === "" ? '<p class="ev-note">No check reported a result for this pull request.</p>' : `<ul class="checks">${rows}</ul>`,
    // Silence is not a result: a kind that ran is listed above, whatever it found.
    '<p class="ev-note">Each line states the scope its check ran over. A check that is not listed here produced no result for this pull request.</p>',
  ].join("\n");
}

/** The reading agenda, in the order the report ranked it. */
function renderAgenda(
  entries: readonly ReviewAgendaEntry[],
  ranks: Ranks,
  claimed: ReadonlySet<string>,
  findingsAt: ReadonlyMap<string, number>,
): string {
  if (entries.length === 0) {
    return [
      '<h3 id="brief-agenda-h">Read these first</h3>',
      '<p class="ev-note">No reading agenda was produced for this pull request.</p>',
    ].join("\n");
  }
  // A definition two agenda entries cite is shown once and linked after that.
  const contexts = new Map<string, number>();
  const cards = entries.map((entry, index) => renderAgendaEntry(entry, index + 1, ranks, claimed, findingsAt, contexts));
  return [
    '<h3 id="brief-agenda-h">Read these first</h3>',
    `<ol class="agenda">${cards.slice(0, 5).join("\n")}</ol>`,
    cards.length > 5 ? `<details class="supporting-agenda"><summary>${cards.length - 5} more review entries and supporting changes</summary><ol class="agenda" start="6">${cards.slice(5).join("\n")}</ol></details>` : "",
    '<p class="ev-note">Evidence cards are places to read — changed code, direct caller, contract, related code or test — not results.</p>',
  ].join("\n");
}

function renderAgendaEntry(
  entry: ReviewAgendaEntry,
  at: number,
  ranks: Ranks,
  claimed: ReadonlySet<string>,
  findingsAt: ReadonlyMap<string, number>,
  contexts: Map<string, number>,
): string {
  // One excerpt is rendered once; what a finding already carries is linked.
  const shown = entry.evidence.filter((excerpt) => !claimed.has(excerptKey(excerpt)));
  const file = entry.evidence[0]?.file ?? "";
  const links = entry.unitIds.length === 0 ? "" : `<p class="ag-links">${hunkLinks(entry.unitIds, file, ranks)}</p>`;
  const findings = entry.findingIds
    .map((id) => {
      const where = findingsAt.get(id);
      return where === undefined ? "" : `<a class="ag-finding" href="#finding-${where}">Finding ${where}</a>`;
    })
    .filter((link) => link !== "")
    .join("");
  const context = entry.context.map((node) => renderContextNode(node, contexts)).filter((part) => part !== "").join("");
  const linked = linkedRanks(entry.unitIds, file, ranks);
  const evidence = shown.map((excerpt) => renderEvidence(excerpt, ranks, linked)).join("");
  return [
    `<li class="ag-card" id="agenda-${at}">`,
    '<p class="ag-head">',
    `<span class="ag-rank mono" aria-hidden="true">${at}</span>`,
    `<span class="ag-title">${escapeHtml(entry.title)}</span>`,
    findings,
    "</p>",
    entry.reason === "" ? "" : `<p class="ag-reason">${escapeHtml(entry.reason)}</p>`,
    links,
    context === "" ? "" : `<div class="ag-ctx-list">${context}</div>`,
    evidence === "" ? "" : `<ul class="evidence">${evidence}</ul>`,
    "</li>",
  ]
    .filter((part) => part !== "")
    .join("");
}

/** One definition an agenda entry reads: shown once, linked when cited again. */
function renderContextNode(node: ReviewContextNode, seen: Map<string, number>): string {
  const key = `${node.key}\u0000${node.file}\u0000${node.line}`;
  const shown = seen.get(key);
  if (shown !== undefined) {
    return `<a class="ag-ctx-again" href="#ctx-${shown}">${escapeHtml(locationOf(node.file, node.line))} shown above</a>`;
  }
  const at = seen.size + 1;
  seen.set(key, at);
  return [
    `<details class="ag-ctx" id="ctx-${at}">`,
    `<summary class="ag-ctx-sum"><span class="mono">${escapeHtml(locationOf(node.file, node.line))}</span> ${escapeHtml(node.label)}</summary>`,
    node.detail === ""
      ? '<p class="ev-note">No text was captured for this definition.</p>'
      : `<pre class="ev-code ag-ctx-code">${escapeHtml(node.detail)}</pre>`,
    "</details>",
  ].join("");
}

/** The automatic findings, each with the scope it ran over and its own limit. */
function renderFindings(findings: readonly AutomaticFinding[], ranks: Ranks): string {
  if (findings.length === 0) {
    return [
      '<h3 id="brief-findings-h">Automatic findings</h3>',
      '<p class="ev-note">No automatic finding was reported. The checks above state the scope that ran, and an empty list is not a statement about the code.</p>',
    ].join("\n");
  }
  const rendered = new Set<string>();
  const cards = findings
    .map((finding, index) => {
      const linked = linkedRanks(finding.unitIds, finding.evidence[0]?.file ?? "", ranks);
      const evidence = finding.evidence
        .filter((excerpt) => {
          const key = excerptKey(excerpt);
          if (rendered.has(key)) return false;
          rendered.add(key);
          return true;
        })
        .map((excerpt) => renderEvidence(excerpt, ranks, linked))
        .join("");
      return [
        `<li class="finding" id="finding-${index + 1}">`,
        '<p class="finding-head">',
        `<span class="finding-kind">${escapeHtml(KIND_LABEL[finding.kind])}</span>`,
        `<span class="finding-title">${escapeHtml(finding.title)}</span>`,
        "</p>",
        `<p class="finding-scope"><span class="finding-label">Checked</span> ${escapeHtml(finding.scope)}</p>`,
        `<p class="finding-limit"><span class="finding-label">Limit</span> ${escapeHtml(finding.limitation)}</p>`,
        finding.unitIds.length === 0 ? "" : `<p class="finding-hunks">${hunkLinks(finding.unitIds, finding.evidence[0]?.file ?? "", ranks)}</p>`,
        evidence === "" ? "" : `<ul class="evidence">${evidence}</ul>`,
        "</li>",
      ]
        .filter((part) => part !== "")
        .join("");
    })
    .join("\n");
  return ['<h3 id="brief-findings-h">Automatic findings</h3>', `<ul class="findings">${cards}</ul>`].join("\n");
}

/** One change/caller/contract card: where it is, how to reach it, and its text. */
function renderEvidence(
  excerpt: EvidenceExcerpt,
  ranks: Ranks,
  linked: ReadonlySet<number>,
): string {
  return [
    '<li class="ev-card"><details>',
    '<summary class="ev-head">',
    `<span class="ev-role">${escapeHtml(ROLE_LABEL[excerpt.role])}</span>`,
    `<span class="ev-where mono">${escapeHtml(locationOf(excerpt.file, excerpt.line, excerpt.endLine))}</span>`,
    excerpt.ref === "" ? "" : `<span class="ev-ref mono">from ${escapeHtml(/^[0-9a-f]{40,64}$/iu.test(excerpt.ref) ? excerpt.ref.slice(0, 12) : excerpt.ref)}</span>`,
    hunkLinks([], excerpt.file, ranks, linked),
    "</summary>",
    excerpt.label === "" ? "" : `<p class="ev-label">${escapeHtml(excerpt.label)}</p>`,
    excerpt.text === ""
      ? '<p class="ev-note">No source text was captured for this excerpt.</p>'
      : `<pre class="ev-code">${escapeHtml(excerpt.text)}</pre>`,
    "</details></li>",
  ]
    .filter((part) => part !== "")
    .join("");
}

interface Ranks {
  /** Report rank (1-based) per unit id. */
  readonly unit: Map<string, number>;
  /** First rank that touches a file, for evidence without a usable unit id. */
  readonly file: Map<string, number>;
}

function hunkRanks(items: readonly ReviewItem[]): Ranks {
  const unit = new Map<string, number>();
  const file = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const rank = index + 1;
    if (!unit.has(item.id)) unit.set(item.id, rank);
    if (!file.has(item.file)) file.set(item.file, rank);
  }
  return { unit, file };
}

/**
 * The report ranks a card's links resolve to, in order: the hunks it names by
 * unit id, or the first hunk of its file when it names none. A rank another link
 * on the same card already points at is left out, so one card never offers the
 * same hunk twice.
 */
function linksToRanks(
  unitIds: readonly string[],
  file: string,
  ranks: Ranks,
  skip: ReadonlySet<number> = new Set(),
): number[] {
  const found: number[] = [];
  for (const id of unitIds) {
    const rank = ranks.unit.get(id);
    if (rank !== undefined && !found.includes(rank)) found.push(rank);
  }
  if (found.length === 0) {
    const rank = ranks.file.get(file);
    if (rank !== undefined) found.push(rank);
  }
  return found.filter((rank) => !skip.has(rank));
}

/**
 * Links that open a hunk in the diff. The link carries a flag the page script
 * acts on: it clears any hiding filter and focus mode first, so a hunk the
 * current view hides is still reachable.
 */
function hunkLinks(
  unitIds: readonly string[],
  file: string,
  ranks: Ranks,
  skip: ReadonlySet<number> = new Set(),
): string {
  return linksToRanks(unitIds, file, ranks, skip)
    .map((rank) => `<a class="ev-hunk" data-open-hunk href="#item-${rank}">Open hunk #${rank}</a>`)
    .join(" ");
}

/** The ranks a card's own hunk links resolve to, for the evidence inside it. */
function linkedRanks(unitIds: readonly string[], file: string, ranks: Ranks): Set<number> {
  return new Set(linksToRanks(unitIds, file, ranks));
}

/** Evidence is identified by its own id, or by where it was read from. */
function excerptKey(excerpt: EvidenceExcerpt): string {
  return excerpt.id === "" ? `${excerpt.file}:${excerpt.line}:${excerpt.ref}` : excerpt.id;
}

function locationOf(file: string, line: number, endLine?: number): string {
  if (!Number.isFinite(line) || line <= 0) return file;
  if (endLine === undefined || !Number.isFinite(endLine) || endLine <= line) return `${file}:${line}`;
  return `${file}:${line}-${endLine}`;
}

/** One status word, with the reason for it as the tooltip and no color alone. */
function badge(label: string, tone: string, hint: string): string {
  return `<span class="ev-badge ev-badge-${tone}" title="${escapeHtml(hint)}">${escapeHtml(label)}</span>`;
}

const ROLE_LABEL = {
  change: "Changed code",
  caller: "Direct caller",
  contract: "Contract",
  related: "Related code",
  test: "Test",
} satisfies Record<EvidenceExcerpt["role"], string>;

/** Kind names, shared by a check's coverage line and the finding it produces. */
const KIND_LABEL = {
  "unused-error-result": "Unused failure result",
  "duplicate-body": "Duplicate function body",
  "broken-reference": "Broken reference",
} satisfies Record<AutomaticFinding["kind"], string>;

const CHECK_STATUS = {
  checked: { label: "Checked", tone: "done", hint: "the check ran over the whole change" },
  partial: { label: "Partly checked", tone: "warn", hint: "the check ran over part of the change" },
  "not-checked": { label: "Not checked", tone: "warn", hint: "no trusted result is available" },
} satisfies Record<CheckCoverage["status"], Tone>;

const VERDICT = {
  "supported-within-checked-scope": {
    label: "Supported within the checked scope",
    tone: "done",
    hint: "the changed code carries the statement, within the scope the checks covered",
  },
  "not-established": {
    label: "Not established",
    tone: "warn",
    hint: "the gathered evidence neither carries nor contradicts the statement",
  },
  contradicted: {
    label: "Contradicted by a check",
    tone: "warn",
    hint: "a check reports the opposite of the statement",
  },
} satisfies Record<IntentCrossCheck["verdict"], Tone & { label: string; hint: string }>;

const CLAIM_STATUS = {
  "evidence-linked": {
    label: "Evidence linked",
    tone: "done",
    hint: "changed code carries this statement",
  },
  "not-established": {
    label: "Not established",
    tone: "warn",
    hint: "no changed code was linked to this statement",
  },
} satisfies Record<IntentClaim["status"], Tone>;

const ORIGIN_LABEL = {
  title: "PR title",
  author: "Author description",
  "generated-summary": "Generated summary",
} satisfies Record<IntentClaim["origin"], string>;

/** How a status is colored: enough to scan, never a claim of its own. */
type Tone = { readonly label: string; readonly tone: string; readonly hint: string };

export const BRIEF_STYLES = `
.brief { display: flex; flex-direction: column; gap: 7px; }
.brief > h2 { font-size: 13.5px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); margin-top: 7px; }
.brief > h2:first-child { margin-top: 0; }
.brief h3 { font-size: 13px; color: var(--ink-soft); font-weight: 600; }
.pr-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.pr-facts dt { font-size: 12px; color: var(--ink-soft); }
.pr-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pr-title { font-size: 17px; font-weight: 700; }
.pr-body > summary { cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
.pr-text {
  margin: 6px 0 0;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--sunken);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 40vh;
  overflow: auto;
}
.intent { border: 1px solid var(--line); border-left: 5px solid var(--line-strong); border-radius: 6px; padding: 10px 14px; background: var(--panel); }
.intent-done { border-left-color: var(--teal); }
.intent-warn { border-left-color: var(--warn); }
.intent-summary { font-size: 14.5px; overflow-wrap: anywhere; }
.intent-verdict { margin-bottom: 4px; }
.ev-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.ev-badge-done { border-color: var(--teal); color: var(--teal); background: var(--teal-bg); }
.ev-badge-warn { border-color: var(--warn); color: var(--warn); background: var(--warn-bg); }
.claims, .checks, .findings, .evidence { list-style: none; margin: 5px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.claim, .check, .finding, .ev-card { border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; background: var(--panel); }
.claim-head, .check-head, .finding-head, .ev-head, .ag-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
summary.ev-head, summary.check-head { cursor: pointer; }
summary.ev-head::before, summary.check-head::before { content: "+"; font-family: var(--mono); }
details[open] > summary.ev-head::before, details[open] > summary.check-head::before { content: "-"; font-family: var(--mono); }
.claim-origin, .ev-role, .finding-kind, .check-kind { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); }
.claim-text, .ag-title, .finding-title { font-size: 14.5px; font-weight: 600; overflow-wrap: anywhere; }
.claim-note, .ag-reason { font-size: 13px; color: var(--ink-soft); overflow-wrap: anywhere; }
.check-detail, .finding-scope, .finding-limit, .ev-label, .ev-note, .ag-links, .finding-hunks, .claim-links {
  font-size: 12.5px;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
  margin-top: 3px;
}
.finding-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
.ev-where, .ev-ref { font-size: 12px; color: var(--ink-soft); overflow-wrap: anywhere; }
.ev-card { background: var(--sunken); }
.ev-code {
  margin: 6px 0 0;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  max-height: 26vh;
  overflow: auto;
  tab-size: 4;
}
.ev-hunk { font-size: 12px; white-space: nowrap; }
.agenda { list-style: none; counter-reset: agenda; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ag-card { border: 1px solid var(--line); border-left: 5px solid var(--line-strong); border-radius: 6px; padding: 9px 12px; background: var(--panel); }
.ag-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--sunken);
  border: 1px solid var(--line);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-soft);
}
.ag-ctx-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.ag-ctx > summary { cursor: pointer; font-size: 12.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.ag-ctx { border: 1px dashed var(--line-strong); border-radius: 6px; padding: 6px 9px; }
.ag-ctx-again { font-size: 12.5px; }
.obligations { margin-top: 8px; }
.obligations > summary { cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
.obligations ul { margin: 6px 0 0; padding-left: 20px; font-size: 13px; }
.obligations li { overflow-wrap: anywhere; }
@media (max-width: 680px) {
  .pr-facts { grid-template-columns: minmax(0, 1fr); gap: 0 0; }
  .pr-facts dd { margin-bottom: 6px; }
}
`;
