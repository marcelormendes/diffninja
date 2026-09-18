export type ReviewStatus = "attention" | "uncertain" | "low" | "passed";
export interface ReviewUnit {
  id: string;
  file: string;
  header: string;
  diff: string;
  added: number;
  removed: number;
  oldStart: number;
  newStart: number;
  special?: string;
}
export interface Judgment {
  risk: number; // 0..3, probability-weighted rubric index
  bug: number;
  needsHuman: number;
  category: string;
  confidence: number;
}
export interface ReviewItem extends ReviewUnit {
  status: ReviewStatus;
  priority: number; // 0..100
  reasons: string[];
  judgment?: Judgment;
}
export interface ReviewReport {
  title: string;
  source: string;
  mode: "live" | "mock";
  createdAt: string;
  items: ReviewItem[];
  callFlow: string[];
  warnings: string[];
  modelCalls: number;
}
export interface ReviewOptions {
  mock?: boolean;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}
