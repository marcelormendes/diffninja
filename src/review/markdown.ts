/**
 * The pull request description, parsed once with `marked` and reduced to a
 * closed set of nodes.
 *
 * The connected page never sets markup: every string that comes from GitHub
 * reaches the DOM through `textContent`. So the Markdown is parsed here, on the
 * server, and what crosses the wire is this tree — block and inline nodes with
 * their text — never HTML. The page turns each node into a whitelisted element,
 * which is why raw HTML in a description arrives as text, images arrive as
 * links (nothing in a body may load a remote resource), and a link keeps its
 * URL only when it is http(s).
 *
 * `marked` does the parsing, so tables, task lists, nested lists, fenced code,
 * emphasis and escaping follow CommonMark/GFM rather than a local
 * approximation. Its tokens are decoded by a schema first: the token stream is
 * data from an untrusted document, and the walk below only ever sees fields the
 * schema established.
 */
import { Lexer } from "marked";
import { z } from "zod";

/** End of the inline nodes a description may contain. */
export type MarkdownInline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "br" }
  | { readonly t: "strong" | "em" | "del"; readonly c: readonly MarkdownInline[] }
  | { readonly t: "link"; readonly href: string; readonly c: readonly MarkdownInline[] };

export type MarkdownAlign = "left" | "center" | "right";

/** Inline content of one table cell. */
export type MarkdownCell = readonly MarkdownInline[];

export interface MarkdownItem {
  readonly task: boolean;
  readonly checked: boolean;
  readonly c: readonly MarkdownBlock[];
}

/** End of the block nodes a description may contain. */
export type MarkdownBlock =
  | { readonly t: "para"; readonly c: readonly MarkdownInline[] }
  | { readonly t: "heading"; readonly d: number; readonly c: readonly MarkdownInline[] }
  | { readonly t: "quote"; readonly c: readonly MarkdownBlock[] }
  | { readonly t: "code"; readonly lang: string; readonly v: string }
  | { readonly t: "raw"; readonly v: string }
  | { readonly t: "rule" }
  | { readonly t: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly MarkdownItem[] }
  | { readonly t: "table"; readonly align: readonly MarkdownAlign[]; readonly head: readonly MarkdownCell[]; readonly rows: readonly (readonly MarkdownCell[])[] };

/** What any token with inline content carries, whether it is a block token or a table cell. */
interface InlineSource {
  readonly raw?: string;
  readonly text?: string;
  readonly tokens?: readonly RawToken[];
}

/** One decoded `marked` token, or one table cell, which carries no `type`. */
interface RawToken extends InlineSource {
  readonly type?: string;
  readonly depth?: number;
  readonly href?: string;
  readonly ordered?: boolean;
  readonly start?: number | "";
  readonly items?: readonly RawToken[];
  readonly task?: boolean;
  readonly checked?: boolean;
  readonly lang?: string;
  readonly escaped?: boolean;
  readonly align?: readonly (MarkdownAlign | null)[];
  readonly header?: readonly RawCell[];
  readonly rows?: readonly (readonly RawCell[])[];
}

/** A table cell: inline content, with one alignment of its own rather than a row of them. */
interface RawCell extends InlineSource {
  readonly header?: boolean;
  readonly align?: MarkdownAlign | null;
}

/** One table cell's alignment, or null when the table declared none. */
const alignValue = z.union([z.literal("center"), z.literal("left"), z.literal("right"), z.null()]);

/**
 * The fields this walk reads, and nothing else: an unknown key of an untrusted
 * token is dropped rather than carried to the page. The block schema is lazy
 * because a table's cells contain inline tokens, which are the same shape.
 */
const tokenSchema: z.ZodType<RawToken> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    raw: z.string().optional(),
    text: z.string().optional(),
    tokens: z.array(tokenSchema).optional(),
    depth: z.number().optional(),
    href: z.string().optional(),
    ordered: z.boolean().optional(),
    start: z.union([z.number(), z.literal("")]).optional(),
    items: z.array(tokenSchema).optional(),
    task: z.boolean().optional(),
    checked: z.boolean().optional(),
    lang: z.string().optional(),
    escaped: z.boolean().optional(),
    align: z.array(alignValue).optional(),
    header: z.array(cellSchema).optional(),
    rows: z.array(z.array(cellSchema)).optional(),
  }),
);

/** A table cell: the same inline content as a token, plus the cell's own alignment. Declared after the block schema, which resolves it lazily. */
const cellSchema: z.ZodType<RawCell> = z.object({
  text: z.string().optional(),
  tokens: z.array(tokenSchema).optional(),
  header: z.boolean().optional(),
  align: alignValue.optional(),
});

const tokensSchema = z.array(tokenSchema);

/** Nesting past this is flattened to its own text rather than descended. */
const MAX_DEPTH = 12;
/** Nodes one description may become; past this the rest is named, not rendered. */
const MAX_NODES = 50_000;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", "\u00a0"],
  ["copy", "\u00a9"], ["reg", "\u00ae"], ["trade", "\u2122"], ["hellip", "\u2026"], ["mdash", "\u2014"],
  ["ndash", "\u2013"], ["lsquo", "\u2018"], ["rsquo", "\u2019"], ["ldquo", "\u201c"], ["rdquo", "\u201d"],
  ["laquo", "\u00ab"], ["raquo", "\u00bb"], ["times", "\u00d7"], ["divide", "\u00f7"], ["plusmn", "\u00b1"],
  ["frac12", "\u00bd"], ["frac14", "\u00bc"], ["frac34", "\u00be"], ["le", "\u2264"], ["ge", "\u2265"],
  ["ne", "\u2260"], ["larr", "\u2190"], ["rarr", "\u2192"], ["bull", "\u2022"], ["middot", "\u00b7"],
  ["sect", "\u00a7"], ["para", "\u00b6"], ["dagger", "\u2020"], ["euro", "\u20ac"], ["pound", "\u00a3"],
  ["yen", "\u00a5"], ["cent", "\u00a2"], ["deg", "\u00b0"], ["micro", "\u00b5"], ["alpha", "\u03b1"],
  ["beta", "\u03b2"], ["gamma", "\u03b3"], ["delta", "\u03b4"], ["pi", "\u03c0"], ["sigma", "\u03c3"],
  ["omega", "\u03c9"], ["hearts", "\u2665"], ["check", "\u2713"],
]);

const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/gu;

/** One codepoint as text, or undefined when it is not something a document should carry. */
function codePointText(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return undefined;
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/** Character references a browser would resolve in text, resolved here so the page shows their character. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole: string, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined) return codePointText(Number(decimal)) ?? whole;
    if (hex !== undefined) return codePointText(Number.parseInt(hex, 16)) ?? whole;
    const named = name === undefined ? undefined : NAMED_ENTITIES.get(name.toLowerCase());
    return named ?? whole;
  });
}

/** The text a token carries, falling back to its raw source when it has none. */
function textOf(token: InlineSource): string {
  if (token.text !== undefined && token.text !== "") return token.text;
  return token.raw ?? "";
}

function childrenOf(token: InlineSource): readonly RawToken[] {
  return token.tokens ?? [];
}

function textNode(value: string): MarkdownInline {
  return { t: "text", v: value };
}

/** A link node, or undefined when the URL is not one this page may follow. */
function linkOf(href: string | undefined, children: readonly MarkdownInline[]): MarkdownInline | undefined {
  if (href === undefined) return undefined;
  const url = decodeEntities(href).trim();
  // Only http(s) survives; `javascript:`, `data:` and relative URLs become their text.
  if (!/^https?:\/\//iu.test(url)) return undefined;
  return { t: "link", href: url, c: children };
}

/** Inline content of a token that carries either child tokens or plain text. */
function inlineOf(token: InlineSource, budget: Budget, depth: number): readonly MarkdownInline[] {
  const children = childrenOf(token);
  if (children.length > 0) return inlineNodes(children, budget, depth);
  const text = textOf(token);
  return text === "" ? [] : [textNode(decodeEntities(text))];
}

function inlineNodes(tokens: readonly RawToken[], budget: Budget, depth: number): readonly MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  const add = (parts: readonly MarkdownInline[]): void => { for (const part of parts) nodes.push(part); };
  for (const token of tokens) {
    if (budget.spent()) return nodes;
    const type = token.type ?? "";
    if (type === "space") continue;
    if (type === "text") {
      const text = textOf(token);
      if (text !== "") nodes.push(textNode(decodeEntities(text)));
      continue;
    }
    // An escape is already the character it named; decoding again would undo it.
    if (type === "escape") { nodes.push(textNode(textOf(token))); continue; }
    if (type === "codespan") { nodes.push({ t: "code", v: textOf(token) }); continue; }
    if (type === "br") { nodes.push({ t: "br" }); continue; }
    if (type === "strong" || type === "em" || type === "del") {
      nodes.push({ t: type, c: inlineOf(token, budget, depth + 1) });
      continue;
    }
    if (type === "link") {
      const children = inlineOf(token, budget, depth + 1);
      const link = linkOf(token.href, children);
      // A URL this page may not follow leaves the link's own text behind.
      if (link === undefined) add(children);
      else nodes.push(link);
      continue;
    }
    if (type === "image") {
      // Nothing here may load a remote resource, so an image is offered as a link.
      const alt = decodeEntities(textOf(token).replace(/\s+/gu, " ").trim());
      const label = [textNode(alt === "" ? "image" : alt + " (image)")];
      const link = linkOf(token.href, label);
      if (link === undefined) add(label);
      else nodes.push(link);
      continue;
    }
    // Raw HTML, and anything this walk does not know: its own text, never markup.
    const text = textOf(token);
    if (text !== "") nodes.push(textNode(decodeEntities(text)));
  }
  return nodes;
}

function cellsOf(row: readonly RawCell[] | undefined, budget: Budget, depth: number): readonly MarkdownCell[] {
  return (row ?? []).map(cell => inlineOf(cell, budget, depth + 1));
}

/** A task list item's marker is its checkbox; the `[x]` text marked leaves beside it is dropped. */
function withoutTaskMarker(blocks: MarkdownBlock[]): void {
  while (blocks.length > 0) {
    const first = blocks[0];
    if (first === undefined || first.t !== "para") return;
    const [head, ...rest] = first.c;
    if (head !== undefined && head.t === "text") {
      const value = head.v.replace(/^\s*\[[ xX]\]\s?/u, "");
      blocks[0] = { t: "para", c: value === "" ? rest : [textNode(value), ...rest] };
    }
    const updated = blocks[0];
    // The marker stood alone in its own paragraph: that paragraph is the checkbox, so it goes.
    if (updated === undefined || updated.t !== "para" || updated.c.length > 0) return;
    blocks.shift();
  }
}

function listItems(token: RawToken, budget: Budget, depth: number): readonly MarkdownItem[] {
  const items: MarkdownItem[] = [];
  for (const item of token.items ?? []) {
    if (budget.spent()) break;
    const content = blockNodes(childrenOf(item), budget, depth + 1);
    if (content.length === 0) {
      const text = textOf(item);
      if (text !== "") content.push({ t: "para", c: [textNode(decodeEntities(text))] });
    }
    const task = item.task === true;
    if (task) withoutTaskMarker(content);
    items.push({ task, checked: item.checked === true, c: content });
  }
  return items;
}

function tableRows(rows: readonly (readonly RawCell[])[], budget: Budget, depth: number): readonly (readonly MarkdownCell[])[] {
  const cells: (readonly MarkdownCell[])[] = [];
  for (const row of rows) {
    if (budget.spent()) break;
    cells.push(cellsOf(row, budget, depth));
  }
  return cells;
}

function blockNodes(tokens: readonly RawToken[], budget: Budget, depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    if (budget.spent()) return blocks;
    const type = token.type ?? "";
    if (type === "space" || type === "def") continue;
    if (type === "heading") {
      const raw = Math.trunc(token.depth ?? 1);
      blocks.push({ t: "heading", d: Math.min(Math.max(raw, 1), 6), c: inlineOf(token, budget, depth + 1) });
      continue;
    }
    if (type === "paragraph") { blocks.push({ t: "para", c: inlineOf(token, budget, depth + 1) }); continue; }
    if (type === "hr") { blocks.push({ t: "rule" }); continue; }
    if (type === "code") {
      const raw = textOf(token);
      blocks.push({ t: "code", lang: (token.lang ?? "").trim(), v: token.escaped === true ? decodeEntities(raw) : raw });
      continue;
    }
    if (type === "blockquote") { blocks.push({ t: "quote", c: blockNodes(childrenOf(token), budget, depth + 1) }); continue; }
    if (type === "list") {
      blocks.push({ t: "list", ordered: token.ordered === true, start: token.start === undefined || token.start === "" || token.start < 1 ? 1 : token.start, items: listItems(token, budget, depth) });
      continue;
    }
    if (type === "table") {
      blocks.push({
        t: "table",
        align: (token.align ?? []).map(value => (value === "center" || value === "right" ? value : "left")),
        head: cellsOf(token.header, budget, depth),
        rows: tableRows(token.rows ?? [], budget, depth),
      });
      continue;
    }
    if (type === "html" || type === "tag") {
      // Raw HTML is shown as its own text: a body cannot build markup, and an
      // `<img>` in it cannot fetch anything.
      const text = textOf(token).replace(/\s+$/u, "");
      if (text !== "") blocks.push({ t: "raw", v: text });
      continue;
    }
    if (type === "checkbox") {
      // A task marker already belongs to its list item; a stray one is its own text.
      blocks.push({ t: "para", c: [textNode(token.checked === true ? "[x] " : "[ ] ")] });
      continue;
    }
    const children = childrenOf(token);
    if (depth < MAX_DEPTH && children.length > 0) { blocks.push(...blockNodes(children, budget, depth + 1)); continue; }
    const text = textOf(token);
    if (text !== "") blocks.push({ t: "para", c: [textNode(decodeEntities(text))] });
  }
  return blocks;
}

/**
 * Counts nodes so one enormous description cannot become an unbounded tree, and
 * remembers whether it stopped the walk: a caller that shows the tree must not
 * present a cut-off one as the whole body.
 */
class Budget {
  private left = MAX_NODES;
  private stopped = false;
  spent(): boolean {
    if (this.left <= 0) {
      this.stopped = true;
      return true;
    }
    this.left -= 1;
    return false;
  }
  tripped(): boolean {
    return this.stopped;
  }
}

let cached: { readonly source: string; readonly parsed: ParsedDescription } | undefined;

/** A parsed description, and whether the walk stopped before the body ended. */
export interface ParsedDescription {
  readonly blocks: readonly MarkdownBlock[];
  /** True when the description was larger than this parser will hold: `blocks` is only its beginning. */
  readonly truncated: boolean;
}

/**
 * The description as renderable nodes, memoized on the last source: the page
 * polls the same state every few seconds, and a description never changes
 * within one snapshot.
 */
export function markdownBlocks(source: string): ParsedDescription {
  if (cached !== undefined && cached.source === source) return cached.parsed;
  let parsed: ParsedDescription;
  try {
    const budget = new Budget();
    const blocks = blockNodes(tokensSchema.parse(Lexer.lex(source)), budget, 0);
    parsed = { blocks, truncated: budget.tripped() };
  } catch {
    // A description that cannot be parsed is shown as its own text, never dropped.
    parsed = { blocks: [{ t: "para", c: [textNode(source)] }], truncated: true };
  }
  cached = { source, parsed };
  return parsed;
}
