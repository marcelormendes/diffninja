import { describe, expect, test } from "vitest";
import { renderConnectedPage } from "../src/review/connected-html.js";
import { escapeHtml } from "../src/review/escape-html.js";
import { hiddenControlsByFile, hiddenControlsIn, visibleControls } from "../src/review/hidden-characters.js";
import { renderReview } from "../src/review/html.js";
import { reviewDiff } from "../src/review/service.js";

const RLO = "‮";
const LRI = "⁦";
const PDI = "⁩";
const ZWSP = "​";
const TAG_A = "\u{E0061}";

describe("hidden and bidirectional control characters", () => {
  test("are replaced by visible code point markers, and ordinary text is untouched", () => {
    expect(visibleControls(`if (admin${RLO} ${LRI}) {${PDI}`)).toBe("if (admin⟦U+202E⟧ ⟦U+2066⟧) {⟦U+2069⟧");
    expect(visibleControls(`a${ZWSP}b${TAG_A}`)).toBe("a⟦U+200B⟧b⟦U+E0061⟧");
    for (const plain of ["const é = 'ü';", "日本語 テキスト", "emoji 👩‍💻 stays", "tabs\tand\nnewlines"]) {
      // U+200D joins the emoji sequence above, and is one of the characters that is shown.
      expect(visibleControls(plain)).toBe(plain.replace("‍", "⟦U+200D⟧"));
    }
  });

  test("hiddenControlsIn lists each distinct one once, sorted", () => {
    expect(hiddenControlsIn(`${RLO}${ZWSP}${RLO}x${LRI}`)).toEqual(["U+200B", "U+202E", "U+2066"]);
    expect(hiddenControlsIn("plain")).toEqual([]);
  });

  test("hiddenControlsByFile looks only at lines the change adds or removes", () => {
    const diff = ["@@ -1,3 +1,3 @@", ` context ${ZWSP}`, `-old ${RLO}`, `+new ${LRI}`].join("\n");
    expect(hiddenControlsByFile([{ file: "a.ts", diff }, { file: "b.ts", diff: "@@ -1 +1 @@\n-x\n+y" }])).toEqual(new Map([["a.ts", ["U+202E", "U+2066"]]]));
  });

  test("escapeHtml, which every server-rendered page uses, shows them instead of passing them on", () => {
    expect(escapeHtml(`<b>${RLO}</b>`)).toBe("&lt;b&gt;⟦U+202E⟧&lt;/b&gt;");
    expect(escapeHtml(`x${ZWSP}`)).not.toContain(ZWSP);
  });

  test("a review of a change that adds one warns which file and which characters, and both pages show the markers", async () => {
    const diff = [
      "diff --git a/auth.ts b/auth.ts", "--- a/auth.ts", "+++ b/auth.ts", "@@ -1,3 +1,3 @@",
      " export function isAdmin(role: string) {",
      `-  return role === "user";`,
      `+  return role === "user${RLO}" && false; // ${LRI}admin${PDI}`,
      " }",
    ].join("\n");
    const report = await reviewDiff({ diff, source: "test" }, {});
    const warning = report.warnings.find((text) => text.includes("Trojan Source"));
    expect(warning).toContain("auth.ts");
    expect(warning).toContain("U+202E");
    expect(warning).toContain("U+2066");
    const page = renderReview(report);
    expect(page).not.toContain(RLO);
    expect(page).not.toContain(LRI);
    expect(page).toContain("⟦U+202E⟧");
    expect(page).toContain('class="code code-hidden"');
  });

  test("the connected page's script shows them too, for every string it puts on the page", () => {
    const page = renderConnectedPage({ csrf: "c".repeat(64), nonce: "n", base: "/b/" });
    const start = page.indexOf("var HIDDEN = new RegExp(");
    const end = page.indexOf("function make(");
    expect(start).toBeGreaterThan(0);
    // Run just the marker function, as the browser would define it.
    const visible: (value: string | number) => string = new Function(`${page.slice(start, end)}; return visible;`)();
    expect(visible(`a${RLO}b${ZWSP}`)).toBe("a⟦U+202E⟧b⟦U+200B⟧");
    expect(visible(42)).toBe("42");
    // Text set through make/setText, and the diff's code cells, all pass through it.
    expect(page).toContain("node.textContent = visible(textValue)");
    expect(page).toContain("node.textContent = value === undefined || value === null ? '' : visible(value)");
    expect(page).toContain("var shown = visible(text);");
  });
});
