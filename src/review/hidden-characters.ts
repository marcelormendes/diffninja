/**
 * Characters that change how text is drawn or that draw nothing at all: bidirectional
 * overrides, embeddings, isolates and marks, zero-width and joiner characters, the
 * invisible operators, and the Unicode tag block. In code they let what a reviewer
 * reads differ from what a compiler reads (Trojan Source, CVE-2021-42574), and in
 * prose they hide instructions. A review tool shows them as visible markers instead
 * of letting the browser act on them.
 */
export const HIDDEN_CHARACTER_SOURCE = "[\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\u{E0000}-\\u{E007F}]";

const hidden = new RegExp(HIDDEN_CHARACTER_SOURCE, "gu");

/** `U+202E`, at least four hex digits. */
function codePoint(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The text with each hidden character replaced by a visible `⟦U+XXXX⟧` marker. */
export function visibleControls(text: string): string {
  return text.replace(hidden, (character) => `⟦${codePoint(character)}⟧`);
}

/** The distinct hidden characters in the text, as sorted code points. */
export function hiddenControlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(hidden)].map((match) => codePoint(match[0])))].sort();
}

interface ChangedText {
  readonly file: string;
  readonly diff: string;
}

/** For each file, the distinct hidden characters on lines the change adds or removes (not on context it merely shows). */
export function hiddenControlsByFile(units: readonly ChangedText[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const unit of units) {
    for (const line of unit.diff.split("\n")) {
      if (!line.startsWith("+") && !line.startsWith("-")) continue;
      for (const point of hiddenControlsIn(line)) {
        const points = found.get(unit.file) ?? new Set<string>();
        points.add(point);
        found.set(unit.file, points);
      }
    }
  }
  return new Map([...found].map(([file, points]) => [file, [...points].sort()]));
}
