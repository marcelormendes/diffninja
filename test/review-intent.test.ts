import { describe, expect, it } from "vitest";
import { commentThen, crossCheckIntent } from "../src/review/intent.js";
import { parseDiff } from "../src/review/input.js";

const units = parseDiff("--- a/consumer.ts\n+++ b/consumer.ts\n@@ -1 +1 @@\n-export function consumeJob() {}\n+export function consumeJob() { return 'not implemented'; }\n");

describe("intent evidence boundaries", () => {
  it("does not certify fulfillment merely because implementation names match the promise", () => {
    const result = crossCheckIntent({ title: "Implement job consumer", body: "Process every job successfully." }, units, [], []);
    expect(result.claims[0].unitIds).toContain(units[0].id);
    expect(result.verdict).toBe("not-established");
    expect(result.claims.every(claim => claim.status !== "not-established" || claim.unitIds.length === 0)).toBe(true);
  });

  it("keeps generated release-note assertions separate from author requirements", () => {
    const result = crossCheckIntent({ title: "Consumers", body: [
      "## Describe your changes", "Do not lose failed jobs.",
      "<!-- This is an auto-generated comment: release notes by a bot -->",
      "## Summary by CodeRabbit", "* Added comprehensive job consumer test coverage.",
      "<!-- end of auto-generated comment -->", "Report failed jobs.",
    ].join("\n") }, units, [], []);
    expect(result.claims.map(claim => claim.origin)).toEqual(["title", "author", "generated-summary", "author"]);
    expect(result.verdict).toBe("not-established");
  });

  it("does not link unrelated background prose through grammatical words", () => {
    const unrelated = parseDiff("--- a/render.ts\n+++ b/render.ts\n@@ -1 +1 @@\n-export function render() {}\n+export function render() { throw new Error('that is not supported'); }\n");
    const result = crossCheckIntent({ title: "", body: "The branch was reverted because that issue was not related." }, unrelated, [], []);
    expect(result.claims[0].status).toBe("not-established");
    expect(result.claims[0].unitIds).toEqual([]);
  });

  it("does not invent an intended outcome when only a patch is supplied", () => {
    const result = crossCheckIntent(undefined, units, [], []);
    expect(result.verdict).toBe("not-established");
    expect(result.claims).toEqual([]);
  });

  it("retains nested requirements and scopes an explicitly generated heading", () => {
    const result = crossCheckIntent({ title: "", body: [
      "## Requirements", "### Failures", "Retry failed jobs.",
      "## AI-generated summary", "All failure cases are handled.",
      "## Author acceptance", "Do not lose a failed job.",
    ].join("\n") }, units, [], []);
    expect(result.claims.map(claim => [claim.text, claim.origin])).toEqual([
      ["Retry failed jobs.", "author"],
      ["All failure cases are handled.", "generated-summary"],
      ["Do not lose a failed job.", "author"],
    ]);
  });

  // Detects the comment tests `<!--.*keyword` rescanning a line from every `<!--` (65,000 characters
  // of them, the most GitHub allows in a body, took 2 to 9 s per review), and any change that makes
  // them match a different set of lines than those regexes did.
  it("finds a generated-comment marker in linear time, on the same lines the regexes did", () => {
    const pieces = ["<!--", "<!-", "auto-generated", "release notes", "end of auto-generated", "Release Notes", "\u017Fo", " ", "x", "\r", "\u2028", "\u2029", "-->"];
    let seed = 987654;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let round = 0; round < 30_000; round++) {
      let line = "";
      for (let count = next() % 9; count > 0; count--) line += pieces[next() % pieces.length];
      expect(commentThen(line, /auto-generated|release notes/iu), JSON.stringify(line)).toBe(/<!--.*(?:auto-generated|release notes)/iu.test(line));
      expect(commentThen(line, /end of auto-generated/iu), JSON.stringify(line)).toBe(/<!--.*end of auto-generated/iu.test(line));
    }
    const claims = (body: string) => {
      const started = performance.now();
      crossCheckIntent({ title: "Consumers", body }, units, [], []);
      return performance.now() - started;
    };
    claims("x".repeat(65_000));
    const ordinary = claims("x".repeat(65_000));
    const hostile = claims("<!--".repeat(16_250));
    expect(hostile, `${Math.round(hostile)} ms against ${Math.round(ordinary)} ms`).toBeLessThan(Math.max(4 * ordinary, 500));
  });
});
