import { describe, expect, test } from "vitest";
import { renderReview } from "../src/review/html.js";
import type { ReviewItem, ReviewReport } from "../src/review/types.js";

function report(items: ReviewItem[], mode: "live" | "mock" = "live"): ReviewReport {
  return { title: "Checkout review", source: "main to feature", mode, createdAt: "2026-09-18T10:00:00Z", items,
    callFlow: [], warnings: [], modelCalls: 0 };
}
function item(status: ReviewItem["status"]): ReviewItem {
  return { id: status, file: `${status}.ts`, header: "@@ -1 +1 @@", diff: `-before_${status}\n+after_${status}`,
    added: 1, removed: 1, oldStart: 1, newStart: 1, status, priority: 50, reasons: ["Review boundary handling"] };
}

describe("review HTML", () => {
  test("untrusted fields remain text rather than executable markup", () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    const unit = { ...item("attention"), file: attack, header: attack, diff: `+${attack}`, special: attack,
      reasons: [attack], callFlow: [attack], judgment: { risk: 1, bug: 0.1, needsHuman: 0.2, confidence: 0.8, category: attack } };
    const html = renderReview({ ...report([unit]), title: attack, source: attack, createdAt: attack, warnings: [attack], callFlow: [attack] });
    expect(html).not.toMatch(/<(script|img|iframe)\b/i);
    expect(html).not.toContain(attack);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  test("every hunk starts open so the full diff is visible", () => {
    const statuses = ["attention", "uncertain", "low", "passed"] as const;
    const html = renderReview(report(statuses.map(item)));
    const cards = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].filter(match => match[2].includes("after_"));
    expect(cards).toHaveLength(4);
    for (const [index, status] of statuses.entries()) {
      expect(cards[index][2]).toContain(`after_${status}`);
      expect(/\bopen\b/.test(cards[index][1])).toBe(true);
    }
  });

  test("shows Noul probabilities on a percentage scale, not the risk rubric", () => {
    const unit = { ...item("uncertain"), judgment: { risk: 2.5, bug: 0.72, needsHuman: 0.81, confidence: 0.4, category: "logic" } };
    const html = renderReview(report([unit]));
    expect(html).toContain("2.5 / 3");
    expect(html).toContain("72%");
    expect(html).toContain("81%");
    expect(html).not.toContain("0.7 / 3");
  });

  test("mock reports cannot be mistaken for live judgments", () => {
    const mock = renderReview(report([item("attention")], "mock"));
    expect(mock).toMatch(/mock mode, not a review/i);
    expect(renderReview(report([]))).not.toMatch(/mock mode, not a review/i);
    expect(mock).not.toMatch(/<script\b|<link\b|@import/i);
  });
});
