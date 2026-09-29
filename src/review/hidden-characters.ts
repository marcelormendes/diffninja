/**
 * Characters that change how text is drawn or that draw nothing at all. In code
 * they let what a reviewer reads differ from what a compiler reads (Trojan
 * Source, CVE-2021-42574), and in prose they hide instructions. A review tool
 * shows them as visible markers instead of letting the browser act on them.
 *
 * Every Unicode bidirectional control (the left-to-right and right-to-left marks,
 * embeddings, overrides and isolates, and the Arabic letter mark) and the whole
 * plane-14 block (the tag characters, the supplementary variation selectors, and
 * the unassigned code points between them) are always shown. The
 * other invisible characters (joiners, zero-width spaces, fillers, variation
 * selectors, marks) are also how emoji, Persian, Indic, Mongolian, and Hangul
 * text is written, so one is shown only where no such script surrounds it:
 * neither neighbour is a visible character of a script, so a run of them
 * between ASCII letters is shown whole. A byte order mark right after a diff
 * line's `+`, `-`, or space is left alone; anywhere else, a path or an id
 * included, it is shown.
 */
const ALWAYS = "\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u206F\\u{E0000}-\\u{E0FFF}";
const BESIDE_ASCII = "\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200D\\u2060-\\u2065\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0\\uFFF0-\\uFFF8\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}";
const BYTE_ORDER_MARK = "\\uFEFF";
/**
 * One visible character of a script: a non-ASCII letter, mark, digit, symbol,
 * or punctuation that is not itself invisible. A space such as U+00A0 is not
 * one, so it cannot shield a hidden character in ASCII code.
 */
const SCRIPT = `(?![\\x00-\\x7F${ALWAYS}${BESIDE_ASCII}${BYTE_ORDER_MARK}]|\\p{Default_Ignorable_Code_Point})[\\p{L}\\p{M}\\p{N}\\p{S}\\p{P}]`;

/** Matches one hidden character at a time, so each match is one code point to mark. */
export const HIDDEN_CHARACTER_SOURCE = `[${ALWAYS}]|(?<!${SCRIPT})[${BESIDE_ASCII}](?!${SCRIPT})|(?<!${SCRIPT}|(?:^|\\n)[+\\- ])${BYTE_ORDER_MARK}(?!${SCRIPT})`;

/**
 * Every character of both tiers, with no lookaround, for a browser too old to compile
 * {@link HIDDEN_CHARACTER_SOURCE} (lookbehind arrived in Safari 16.4). It marks the
 * joiners of emoji and Persian text too, which reads worse but shows everything.
 */
export const HIDDEN_CHARACTER_FALLBACK_SOURCE = `[${ALWAYS}${BESIDE_ASCII}${BYTE_ORDER_MARK}]`;

const hidden = new RegExp(HIDDEN_CHARACTER_SOURCE, "gu");
const anyHidden = new RegExp(HIDDEN_CHARACTER_SOURCE, "u");

/** `U+202E`, at least four hex digits. */
function codePoint(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The text with each hidden character replaced by a visible `⟦U+XXXX⟧` marker. */
export function visibleControls(text: string): string {
  return text.replace(hidden, (character) => `⟦${codePoint(character)}⟧`);
}

/** Whether the text holds a character {@link visibleControls} would mark. */
function hasHiddenControls(text: string): boolean {
  return anyHidden.test(text);
}

/** The distinct hidden characters in the text, as sorted code points. */
export function hiddenControlsIn(text: string): string[] {
  const points = new Set<string>();
  for (const match of text.matchAll(hidden)) points.add(codePoint(match[0]));
  return [...points].sort();
}

/** Whether the quote at `index` of a JSON text is escaped: an odd run of backslashes precedes it. */
function escapedAt(json: string, index: number): boolean {
  let backslashes = 0;
  while (json[index - 1 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * A copy of a JSON value with every string in it, keys included, passed
 * through {@link visibleControls}. Every review result goes through it on its
 * way to the agent: the pull request's words are written by other people, and
 * a hidden character would carry text or reorder it without the reader seeing
 * it. Each string is marked on its own, not the JSON text as a whole, so the
 * start of a string and its line breaks read the way they do in the string
 * itself. The literals are found by scanning for quotes, not by a regular
 * expression, which overflows its stack on a string of a few million
 * characters.
 */
export function withVisibleControls<Payload>(payload: Payload): Payload {
  const json = JSON.stringify(payload);
  // Whatever one string of it would mark, the JSON text marks too: escapes are ASCII.
  if (!hasHiddenControls(json)) return payload;
  const parts: string[] = [];
  let copied = 0;
  for (let open = json.indexOf('"'); open >= 0;) {
    let close = json.indexOf('"', open + 1);
    while (escapedAt(json, close)) close = json.indexOf('"', close + 1);
    const literal = json.slice(open, close + 1);
    if (hasHiddenControls(literal)) {
      // SAFETY: a JSON string literal parses to a string.
      parts.push(json.slice(copied, open), JSON.stringify(visibleControls(JSON.parse(literal) as string)));
      copied = close + 1;
    }
    open = json.indexOf('"', close + 1);
  }
  parts.push(json.slice(copied));
  // SAFETY: only the contents of JSON strings changed, so the text parses to the same shape.
  return JSON.parse(parts.join("")) as Payload;
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
