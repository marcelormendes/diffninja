import type { ReviewContextNode } from "./types.js";

/** Source evidence is snapshot-bound; syntactic relationships are not runtime proof. */
export interface EvidenceExcerpt {
  id: string;
  label: string;
  file: string;
  line: number;
  endLine?: number;
  ref: string;
  text: string;
  role: "change" | "caller" | "contract" | "related" | "test";
}
export interface AutomaticFinding {
  id: string;
  kind: "unused-error-result" | "duplicate-body" | "broken-reference";
  title: string;
  scope: string;
  limitation: string;
  unitIds: string[];
  evidence: EvidenceExcerpt[];
}
export interface CheckCoverage {
  kind: AutomaticFinding["kind"];
  status: "checked" | "partial" | "not-checked";
  detail: string;
}
export interface ReviewAgendaEntry {
  id: string;
  title: string;
  reason: string;
  priority: number;
  unitIds: string[];
  findingIds: string[];
  evidence: EvidenceExcerpt[];
  context: ReviewContextNode[];
}
export interface PullRequestIntent {
  title: string;
  body: string;
  url?: string;
  baseRef?: string;
  headRef?: string;
}
export interface IntentClaim {
  text: string;
  origin: "title" | "author" | "generated-summary";
  status: "evidence-linked" | "not-established";
  unitIds: string[];
  explanation: string;
}
export interface IntentCrossCheck {
  verdict: "not-established" | "contradicted" | "supported-within-checked-scope";
  summary: string;
  claims: IntentClaim[];
  obligations: string[];
}
export interface ReviewEvidence {
  findings: AutomaticFinding[];
  checks: CheckCoverage[];
  agenda: ReviewAgendaEntry[];
  intent: IntentCrossCheck;
}
