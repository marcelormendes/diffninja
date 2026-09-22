import type { IntentClaim, IntentCrossCheck, PullRequestIntent, ReviewAgendaEntry, AutomaticFinding } from "./evidence-types.js";
import type { ReviewUnit } from "./types.js";

const STOP_WORDS: Record<string, true> = Object.fromEntries("a about after all also an and any are as at be because been before being both but by can code could did do does during each either for from had has have if in into is it may might more most must no nor not of on only or other our over pr same should so some such than that the their them then there these they this those through to too under until up use using very was we were what when where which while who why will with would you your added add implementing implement introduced introduce updated update functionality capabilities comprehensive test tests coverage".split(" ").map(word => [word, true]));

function terms(text: string): Set<string> {
  return new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]+/g)?.filter(word => !Object.hasOwn(STOP_WORDS, word)).map(word => word.replace(/(?:ing|ies|s)$/u, "")).filter(word => word.length > 2) ?? []);
}

/** Keep author claims separate from generated release notes; never execute PR text. */
function statements(pr: PullRequestIntent): { text: string; origin: IntentClaim["origin"] }[] {
  const claims: { text: string; origin: IntentClaim["origin"] }[] = [];
  if (pr.title.trim()) claims.push({ text: pr.title.trim(), origin: "title" });
  let generatedComment = false;
  let generatedHeadingDepth: number | undefined;
  let comment = false;
  let relevant = true;
  for (const raw of pr.body.split(/\r?\n/u)) {
    if (/<!--.*(?:auto-generated|release notes)/iu.test(raw)) generatedComment = true;
    if (/<!--.*end of auto-generated/iu.test(raw)) { generatedComment = false; generatedHeadingDepth = undefined; continue; }
    const heading = /^(#{1,6})\s/u.exec(raw);
    if (heading) {
      const depth = heading[1].length;
      if (generatedHeadingDepth !== undefined && depth <= generatedHeadingDepth) generatedHeadingDepth = undefined;
      if (!generatedComment && /(?:ai[- ]generated|auto[- ]generated|summary by .*(?:bot|coderabbit|copilot))/iu.test(raw)) generatedHeadingDepth = depth;
      relevant = generatedComment || generatedHeadingDepth !== undefined || !/(?:branch.*naming|pull request.*naming|what type of pr|what gif)/iu.test(raw);
      continue;
    }
    if (raw.includes("<!--")) comment = true;
    if (comment) { if (raw.includes("-->")) comment = false; continue; }
    const text = raw.trim().replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/u, "");
    if (!relevant || !text || /^<|^!\[|^\*\*[^*]+\*\*$/u.test(text)) continue;
    claims.push({ text, origin: generatedComment || generatedHeadingDepth !== undefined ? "generated-summary" : "author" });
  }
  return claims;
}

/** Links are discovery aids, never a semantic entailment or a passing test. */
export function crossCheckIntent(pr: PullRequestIntent | undefined, units: readonly ReviewUnit[], agenda: readonly ReviewAgendaEntry[], findings: readonly AutomaticFinding[]): IntentCrossCheck {
  if (!pr || (!pr.title.trim() && !pr.body.trim())) return {
    verdict: "not-established",
    summary: "Expected outcome not established: no PR title or description was supplied. Review the changed behavior and obtain explicit requirements before deciding whether this PR achieves its goal.",
    claims: [],
    obligations: ["Provide the expected behavior, including failure and boundary cases. No intended outcome was inferred from the diff."],
  };
  const indexed = units.map(unit => ({ unit, terms: terms(unit.file + "\n" + unit.diff.split("\n").filter(line => line.startsWith("+")).join("\n")) }));
  const claims = statements(pr).map<IntentClaim>(claim => {
    const wanted = [...terms(claim.text)];
    const matches = indexed.map(({ unit, terms: actual }) => ({ unit, count: wanted.reduce((count, term) => count + (actual.has(term) ? 1 : 0), 0) }))
      .filter(({ count }) => count >= Math.min(2, wanted.length) && wanted.length > 0)
      .sort((a, b) => b.count - a.count || a.unit.file.localeCompare(b.unit.file) || a.unit.newStart - b.unit.newStart);
    return { ...claim, status: matches.length ? "evidence-linked" : "not-established", unitIds: matches.slice(0, 8).map(({ unit }) => unit.id),
      explanation: matches.length
        ? "Changed code shares the named concepts below. These are navigation matches, not proof that the requirement is implemented correctly; inspect behavior and executable acceptance evidence."
        : "No direct changed-code match was found. This is missing evidence, not proof that the claim is false." };
  });
  const obligations = [
    "Confirm the intended success, partial-failure, and boundary outcomes. The PR text and static code do not establish end-to-end fulfillment.",
    ...agenda.slice(0, 5).map(entry => entry.title),
  ];
  if (claims.some(claim => claim.origin === "generated-summary")) obligations.push("Generated release notes are claims, not author-confirmed requirements or test-execution evidence.");
  if (findings.length) obligations.push("Resolve the automatic findings below within their stated scope; an unused error field or matching body alone does not prove that the intended outcome fails.");
  return { verdict: "not-established", summary: "Implementation evidence is linked below, but achievement of the expected outcome is not established. Resolve the review decisions and verify the explicit behavior before concluding that the PR delivers its goal.", claims, obligations };
}
