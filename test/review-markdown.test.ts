import { describe, expect, test } from "vitest";
import { markdownBlocks, type MarkdownBlock, type MarkdownInline } from "../src/review/markdown.js";

/** Every node the page knows how to render; a new node type would reach the DOM as bare text. */
const BLOCK_TYPES = ["para", "heading", "quote", "code", "raw", "rule", "list", "table"];
const INLINE_TYPES = ["text", "code", "br", "strong", "em", "del", "link"];

function everyBlock(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  return blocks.flatMap(block => {
    if (block.t === "quote") return [block, ...everyBlock(block.c)];
    if (block.t === "list") return [block, ...block.items.flatMap(item => everyBlock(item.c))];
    return [block];
  });
}

function inlineDescendants(nodes: readonly MarkdownInline[]): MarkdownInline[] {
  return nodes.flatMap(node => (node.t === "strong" || node.t === "em" || node.t === "del" || node.t === "link" ? [node, ...inlineDescendants(node.c)] : [node]));
}

function everyInline(blocks: readonly MarkdownBlock[]): MarkdownInline[] {
  return everyBlock(blocks).flatMap(block => {
    if (block.t === "para" || block.t === "heading") return inlineDescendants(block.c);
    if (block.t === "table") return [...block.head, ...block.rows.flat()].flatMap(inlineDescendants);
    return [];
  });
}

/** All text a description shows, across every node that carries text. */
function textOf(blocks: readonly MarkdownBlock[]): string {
  const blockText = everyBlock(blocks).flatMap(block => (block.t === "code" || block.t === "raw" ? [block.v] : []));
  const inlineText = everyInline(blocks).filter(node => node.t === "text" || node.t === "code").map(node => node.v);
  return [...blockText, inlineText.join("")].join("\n");
}

describe("description markdown", () => {
  test("keeps the block and inline vocabularies closed", () => {
    const blocks = markdownBlocks([
      "# Title",
      "",
      "Text with **bold**, *em*, ~~struck~~, `code`, [a link](https://example.test/a), ![an image](https://img.test/i.png) and a break  ",
      "after it",
      "",
      "> quote",
      "",
      "| a | b |",
      "|:--|--:|",
      "| 1 | 2 |",
      "",
      "- item",
      "  - nested",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
    ].join("\n")).blocks;

    const blockTypes = [...new Set(everyBlock(blocks).map(block => block.t))];
    const inlineTypes = [...new Set(everyInline(blocks).map(node => node.t))];
    // Both vocabularies are exercised, and neither leaves the set the page can render.
    expect(blockTypes).toEqual(expect.arrayContaining(["para", "heading", "quote", "code", "list", "table", "rule"]));
    expect(inlineTypes).toEqual(expect.arrayContaining(["text", "code", "br", "strong", "em", "del", "link"]));
    expect(blockTypes.filter(type => !BLOCK_TYPES.includes(type))).toEqual([]);
    expect(inlineTypes.filter(type => !INLINE_TYPES.includes(type))).toEqual([]);
  });

  test("keeps the structure marked parsed: nested lists, task items, fences, tables and escapes", () => {
    const blocks = markdownBlocks([
      "1. first",
      "   - nested bullet",
      "2. second",
      "",
      "- [x] done",
      "- [ ] pending",
      "",
      "```ts",
      "if (a < b) return;",
      "```",
      "",
      "| left | right |",
      "|:-----|------:|",
      "| 1 | `2` |",
      "",
      "Escaped \\*not emphasis\\* and an entity &copy;.",
    ].join("\n")).blocks;

    const ordered = blocks.find(block => block.t === "list");
    expect(ordered && ordered.t === "list" ? ordered.items[0].c.map(child => child.t) : []).toEqual(["para", "list"]);

    const tasks = everyBlock(blocks).flatMap(block => (block.t === "list" ? block.items.filter(item => item.task).map(item => [item.checked, textOf(item.c)]) : []));
    expect(tasks).toEqual([[true, "done"], [false, "pending"]]);

    const code = blocks.find(block => block.t === "code");
    expect(code && code.t === "code" ? [code.lang, code.v] : []).toEqual(["ts", "if (a < b) return;"]);
    const heading = blocks.find(block => block.t === "heading");
    expect(heading).toBeUndefined();

    const table = blocks.find(block => block.t === "table");
    expect(table && table.t === "table" ? table.align : []).toEqual(["left", "right"]);
    expect(table && table.t === "table" ? table.head.map(cell => textOf([{ t: "para", c: cell }])) : []).toEqual(["left", "right"]);
    expect(table && table.t === "table" ? table.rows[0].map(cell => cell.map(node => (node.t === "code" ? node.v : node.t === "text" ? node.v : node.t))) : []).toEqual([["1"], ["2"]]);

    const text = textOf(blocks);
    expect(text).toContain("*not emphasis*");
    expect(text).toContain("\u00a9");
  });

  test("raw HTML and a hostile URL never become markup or a destination", () => {
    const blocks = markdownBlocks([
      '<script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 2">',
      "",
      "Click [here](javascript:window.__pwned=3), [there](data:text/html,<b>hi</b>), [locally](/docs/x.md) and see ![shot](https://img.test/a.png).",
    ].join("\n")).blocks;

    // Raw markup arrives as its own text, in a node the page renders as text.
    const raws = everyBlock(blocks).filter(block => block.t === "raw").map(block => block.v);
    expect(raws).toEqual(['<script>window.__pwned = 1</script>', '<img src=x onerror="window.__pwned = 2">']);
    // Only the https URL is a link; every other destination stays its own text.
    const links = everyInline(blocks).filter(node => node.t === "link");
    expect(links.map(node => node.href)).toEqual(["https://img.test/a.png"]);
    const text = textOf(blocks);
    expect(text).toContain("here");
    expect(text).toContain("there");
    expect(text).toContain("locally");
    // An image is offered as a link, so nothing in a description fetches anything.
    expect(text).toContain("shot (image)");
    expect(text).not.toContain("javascript:");
    // No node carries a markup string: the only place `onerror` appears is the raw
    // text of the tag the author wrote, which the page shows as text.
    expect(JSON.stringify(links)).not.toContain("onerror");
    expect(JSON.stringify(links)).not.toContain("data:");
  });

  test("an oversized description is reported as truncated rather than passed off as whole", () => {
    const big = Array.from({ length: 40_000 }, (_, index) => `\`v${index}\` and **b**`).join(" ");
    const parsed = markdownBlocks(big);
    expect(parsed.truncated).toBe(true);
    expect(textOf(parsed.blocks)).toContain("v0");
  });

  test("an ordinary description is not reported as truncated", () => {
    const parsed = markdownBlocks("# Title\n\nA short body with **emphasis**.\n\n- one\n- two\n");
    expect(parsed.truncated).toBe(false);
    expect(textOf(parsed.blocks)).toContain("A short body with");
  });
});
