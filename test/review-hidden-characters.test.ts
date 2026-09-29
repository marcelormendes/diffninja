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
    for (const plain of ["const é = 'ü';", "日本語 テキスト", "tabs\tand\nnewlines"]) expect(visibleControls(plain)).toBe(plain);
  });

  const hex = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  const span = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const ALWAYS = [0x061c, ...span(0x202a, 0x202e), ...span(0x2066, 0x206f), ...span(0xe0000, 0xe007f), ...span(0xe0100, 0xe01ef)];
  const BESIDE_ASCII = [0x00ad, 0x034f, 0x115f, 0x1160, ...span(0x180b, 0x180f), ...span(0x200b, 0x200f), ...span(0x2060, 0x2064), 0x2800, 0x3164, ...span(0xfe00, 0xfe0f), 0xfeff, 0xffa0];
  const PERSIAN = ["\u0645", "\u06CC"];

  test("bidirectional controls, the tag block and the supplementary variation selectors are shown everywhere, even inside another script", () => {
    for (const point of ALWAYS) {
      const character = String.fromCodePoint(point);
      expect(visibleControls(`${PERSIAN[0]}${character}${PERSIAN[1]}`), hex(point)).toBe(`${PERSIAN[0]}⟦${hex(point)}⟧${PERSIAN[1]}`);
      expect(hiddenControlsIn(`x${character}`), hex(point)).toEqual([hex(point)]);
    }
  });

  test("the other invisible characters are shown beside ASCII, at the edges, and in runs, and left to the scripts that write with them", () => {
    for (const point of BESIDE_ASCII) {
      const character = String.fromCodePoint(point);
      const marker = `⟦${hex(point)}⟧`;
      expect(visibleControls(`utils${character}.ts`), hex(point)).toBe(`utils${marker}.ts`);
      expect(visibleControls(`x ${character}`), hex(point)).toBe(`x ${marker}`);
      // Doubling one between ASCII letters does not hide it behind its twin.
      expect(visibleControls(`a${character}${character}b`), hex(point)).toBe(`a${marker}${marker}b`);
      expect(visibleControls(`${PERSIAN[0]}${character}${PERSIAN[1]}`), hex(point)).toBe(`${PERSIAN[0]}${character}${PERSIAN[1]}`);
    }
  });

  const BENIGN = [
    "coder \u{1F469}\u200D\u{1F4BB} family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "heart on fire \u2764\uFE0F\u200D\u{1F525} rainbow flag \u{1F3F3}\uFE0F\u200D\u{1F308}",
    "red heart \u2764\uFE0F keycap 1\uFE0F\u20E3",
    "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    "\u0915\u094D\u200D\u0937",
    "\uFEFFexport const first = 1;",
    "@@ -0,0 +1,2 @@\n+\uFEFFexport const a = 1;\n+export const b = 2;",
  ];

  test("emoji sequences, Persian and Devanagari joiners, and a byte order mark that opens a line stay as written", () => {
    for (const text of BENIGN) {
      expect(visibleControls(text)).toBe(text);
      expect(hiddenControlsIn(text)).toEqual([]);
    }
  });

  test("a change that adds them draws no Trojan Source warning", async () => {
    const lines = ["\uFEFFexport const team = \"\u{1F469}\u200D\u{1F4BB}\";", "export const love = \"\u2764\uFE0F\";", "export const want = \"\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645\";"];
    const diff = ["diff --git a/i18n.ts b/i18n.ts", "new file mode 100644", "--- /dev/null", "+++ b/i18n.ts", `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
    const report = await reviewDiff({ diff, source: "test" }, {});
    expect(report.warnings.filter((text) => text.includes("Trojan Source"))).toEqual([]);
    const page = renderReview(report);
    expect(page).not.toContain('class="code code-hidden"');
    expect(page).not.toContain("⟦U+");
  });

  test("a space that is not ASCII, or an invisible character not listed, does not shield a hidden one in ASCII code", () => {
    expect(visibleControls("let isAdmin\u200D\u00A0= true;")).toBe("let isAdmin⟦U+200D⟧\u00A0= true;");
    expect(visibleControls('if (op === "a\u00A0\u200F<\u200F\u00A0b") grant();')).toBe('if (op === "a\u00A0⟦U+200F⟧<⟦U+200F⟧\u00A0b") grant();');
    expect(visibleControls("const { timeout,\u2009\u3164} = req.query;")).toBe("const { timeout,\u2009⟦U+3164⟧} = req.query;");
    expect(visibleControls('if (level != "user\u200B\u2065") admin();')).toBe('if (level != "user⟦U+200B⟧\u2065") admin();');
  });

  test("hiddenControlsIn keeps no copy per match: 12 MiB of zero-width spaces is one small scan", () => {
    const text = ZWSP.repeat(4_000_000);
    const before = process.memoryUsage().rss;
    expect(hiddenControlsIn(text)).toEqual(["U+200B"]);
    // Collecting every match first grew the process by about 800 MiB here.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
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
    const start = page.indexOf("var HIDDEN;");
    const end = page.indexOf("function make(");
    expect(start).toBeGreaterThan(0);
    // Run just the marker function, as the browser would define it.
    const visible: (value: string | number) => string = new Function(`${page.slice(start, end)}; return visible;`)();
    expect(visible(`a${RLO}b${ZWSP}`)).toBe("a⟦U+202E⟧b⟦U+200B⟧");
    expect(visible(42)).toBe("42");
    // The same tiers as the server: a Hangul filler between ASCII letters is shown, an emoji's joiner is not.
    expect(visible("a\u3164b")).toBe("a⟦U+3164⟧b");
    expect(visible("\u{1F469}\u200D\u{1F4BB}")).toBe("\u{1F469}\u200D\u{1F4BB}");
    expect(visible("timeout,\u00A0\u3164")).toBe("timeout,\u00A0⟦U+3164⟧");
    // Text set through make/setText, and the diff's code cells, all pass through it.
    expect(page).toContain("node.textContent = visible(textValue)");
    expect(page).toContain("node.textContent = value === undefined || value === null ? '' : visible(value)");
    expect(page).toContain("var shown = visible(text);");
  });

  test("a browser that cannot compile the lookbehind still marks every hidden character", () => {
    const page = renderConnectedPage({ csrf: "c".repeat(64), nonce: "n", base: "/b/" });
    const script = page.slice(page.indexOf("var HIDDEN;"), page.indexOf("function make("));
    // An engine without lookbehind refuses the source while it is compiled, as Safari before 16.4 does.
    const NoLookbehind = function (source: string, flags: string): RegExp {
      if (source.includes("(?<")) throw new SyntaxError("Invalid regular expression: invalid group specifier name");
      return new RegExp(source, flags);
    };
    const visible: (value: string) => string = new Function("RegExp", `${script}; return visible;`)(NoLookbehind);
    expect(visible(`a${RLO}b${ZWSP}`)).toBe("a⟦U+202E⟧b⟦U+200B⟧");
    expect(visible("a\u3164b")).toBe("a⟦U+3164⟧b");
    expect(visible("\u{1F469}\u200D\u{1F4BB}")).toBe("\u{1F469}⟦U+200D⟧\u{1F4BB}");
  });
});
