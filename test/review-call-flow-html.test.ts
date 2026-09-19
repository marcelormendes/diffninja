import { describe, expect, test } from "vitest";
import { renderReview } from "../src/review/html.js";
import type {
  CallFlowFile,
  CallFlowNode,
  ReviewItem,
  ReviewReport,
} from "../src/review/types.js";

const ATTACK = '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "hunk-1",
    file: "src/a.ts",
    header: "@@ -1 +1 @@",
    diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
    added: 1,
    removed: 1,
    oldStart: 1,
    newStart: 1,
    status: "attention",
    priority: 80,
    reasons: [],
    ...overrides,
  };
}

function report(callFlows: CallFlowFile[], items: ReviewItem[] = [item()]): ReviewReport {
  return {
    title: "Checkout review",
    source: "main to feature",
    mode: "live",
    createdAt: "2026-09-18T10:00:00Z",
    items,
    callFlow: [],
    callFlows,
    callFlowAvailability: "available",
    warnings: [],
    modelCalls: 0,
  };
}

function node(overrides: Partial<CallFlowNode> = {}): CallFlowNode {
  return {
    key: "run",
    label: "run()",
    status: "changed",
    file: "src/a.ts",
    line: 3,
    children: [],
    ...overrides,
  };
}

function flow(file: string, trees: CallFlowNode[], truncated = false): CallFlowFile {
  return { file, trees, truncated };
}

/** The call-flow document as a reviewer reads it: stylesheet and script removed. */
function readable(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<script>[\s\S]*?<\/script>/, "");
}

function scriptText(html: string): string {
  return /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
}

/** A root with two callees, one of which calls a third function. */
function nested(): CallFlowNode {
  return node({
    children: [
      node({
        key: "load",
        label: "load()",
        status: "added",
        line: 8,
        endLine: 11,
        children: [node({ key: "read", label: "read()", status: "same", line: 20 })],
      }),
      node({ key: "save", label: "save()", status: "same", line: 30 }),
    ],
  });
}

describe("call-flow source details", () => {
  test("a resolved definition renders as a native disclosure with numbered source", () => {
    const html = renderReview(
      report([
        flow("src/a.ts", [
          node({
            description: "Charge the order once.",
            source: {
              file: "src/lib/pay.ts",
              line: 10,
              endLine: 12,
              ref: "a1b2c3d",
              text: "export function charge(order) {\n  return order.total;\n}\n",
            },
          }),
        ]),
      ]),
    );
    const rendered = readable(html);
    expect(rendered).toContain('<details class="cf-source" id="cf-f1-src-0">');
    expect(rendered).toContain('<summary class="cf-src-sum mono">src/lib/pay.ts:10-12</summary>');
    expect(rendered).toContain("Definition in src/lib/pay.ts:10-12 · resolved from a1b2c3d");
    expect(rendered).toContain('<span class="cf-src-no" aria-hidden="true">10</span>');
    expect(rendered).toContain('<span class="cf-src-no" aria-hidden="true">12</span>');
    expect(rendered).toContain("export function charge(order) {");
    expect(rendered).toContain("  return order.total;");
    // The trailing newline of the definition is not a thirteenth line.
    expect(rendered).not.toContain('aria-hidden="true">13</span>');
    // The definition file is in another file than the call site, and both are
    // on the node for the trail's file transitions.
    expect(rendered).toContain('data-cf-srcfile="src/lib/pay.ts"');
    expect(rendered).toContain('data-cf-nodefile="src/a.ts"');
    expect(rendered).toContain("Charge the order once.");
  });

  test("Tree, Graph and Sequence each reach that source", () => {
    const html = readable(
      renderReview(
        report([
          flow("src/a.ts", [
            node({ source: { file: "src/a.ts", line: 3, endLine: 3, ref: "HEAD", text: "function run() {}" } }),
          ]),
        ]),
      ),
    );
    expect(html).toContain(
      '<a class="cf-src-link" href="#cf-f1-src-0" data-cf-source data-cf-file="1" data-cf-path="0">source</a>',
    );
    expect(html).toMatch(
      /<a class="cf-gnode cf-st-changed[^"]*" href="#cf-f1-src-0" data-cf-source data-cf-file="1" data-cf-path="0">/,
    );
    expect(html).toContain('<a class="cf-chip-zoom" href="#cf-f1-t-0" data-cf-zoom');
  });


  test("a call without a resolved definition claims no source", () => {
    const html = renderReview(report([flow("src/a.ts", [nested()])]));
    const rendered = readable(html);
    expect(rendered).toContain("Source unavailable");
    expect(rendered).not.toContain('class="cf-src-code"');
    expect(rendered).not.toContain("data-cf-srcfile");
    // Details stay reachable, but never claim a definition from another call.
    expect(rendered).toMatch(
      /<a class="cf-gnode cf-st-changed[^"]*" href="#cf-f1-src-0" data-cf-source data-cf-file="1" data-cf-path="0">/,
    );
    // Nothing about an unresolved definition reaches the script.
    expect(scriptText(html)).not.toContain("src/a.ts");
  });



  test("hostile labels, descriptions, refs and source lines stay escaped and out of the script", () => {
    const html = renderReview(
      report(
        [
          flow(ATTACK, [
            node({
              label: ATTACK,
              file: ATTACK,
              description: ATTACK,
              source: { file: ATTACK, line: 1, endLine: 2, ref: ATTACK, text: `${ATTACK}\n${ATTACK}` },
            }),
          ]),
        ],
        [item({ file: ATTACK })],
      ),
    );
    expect(html).not.toContain(ATTACK);
    expect(html).not.toMatch(/<(img|iframe)\b/i);
    expect(scriptText(html)).not.toContain("alert(1)");
    const rendered = readable(html);
    // Escaped once per place it is shown: label, description, ref and both lines.
    expect(rendered.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/g)?.length).toBeGreaterThanOrEqual(5);
    expect(rendered).not.toContain("cf-source\" id=\"cf-f1-src-0\"><img");
  });

  test("an empty or absent description draws no description line", () => {
    const withText = readable(
      renderReview(report([flow("src/a.ts", [node({ description: "Does the thing." })])])),
    );
    expect(withText).toContain('<span class="cf-desc">Does the thing.</span>');
    const none = readable(renderReview(report([flow("src/a.ts", [node({ description: "" })])])));
    expect(none).not.toContain("cf-desc");
    expect(readable(renderReview(report([flow("src/a.ts", [node()])])))).not.toContain("cf-desc");
  });
});

describe("call-flow graph edges", () => {
  const html = readable(renderReview(report([flow("src/a.ts", [nested()])])));

  test("every call edge carries a deterministic number that zooms into the callee", () => {
    const badges = [
      ...html.matchAll(
        /<a class="cf-edge-num" data-cf-edge="(\d+)" href="#cf-f1-t-([\d-]+)" data-cf-zoom data-cf-file="1" data-cf-path="([\d-]+)">/g,
      ),
    ];
    expect(badges.map((badge) => badge[1])).toEqual(["1", "2", "3"]);
    expect(badges.map((badge) => badge[3])).toEqual(["0-0", "0-0-0", "0-1"]);
    for (const badge of badges) expect(badge[2]).toBe(badge[3]);
  });

  test("the same input renders the same numbers", () => {
    const again = readable(renderReview(report([flow("src/a.ts", [nested()])])));
    expect(again).toBe(html);
    // Two diagrams in one file number their own calls, starting at 1 again.
    const twoTrees = readable(
      renderReview(
        report([
          flow("src/a.ts", [
            nested(),
            node({
              key: "other",
              label: "other()",
              children: [node({ key: "helper", label: "helper()" })],
            }),
          ]),
        ]),
      ),
    );
    expect([...twoTrees.matchAll(/data-cf-edge="(\d+)"/g)].map((match) => match[1])).toEqual([
      "1",
      "2",
      "3",
      "1",
    ]);
  });

});

describe("call-flow progressive enhancement", () => {
  test("without JavaScript every Sequence path remains available, including paths beyond ten", () => {
    const root = node({
      children: Array.from({ length: 12 }, (_, i) =>
        node({ key: `helper${i}`, label: `helper${i}()`, line: i + 10 }),
      ),
    });
    const html = readable(renderReview(report([flow("src/a.ts", [root])])));
    const paths = [...html.matchAll(/<li class="cf-path"([^>]*)>/g)];
    expect(paths).toHaveLength(12);
    expect(paths.every((path) => !/\bhidden\b/.test(path[1]))).toBe(true);
    expect(html).toContain("helper11()");
  });
});

describe("call-flow controls", () => {
  test("the graph depth control lists the bounded depths and starts at All", () => {
    const html = readable(renderReview(report([flow("src/a.ts", [nested()])])));
    const depths = [...html.matchAll(/class="cf-depth-btn" data-cf-depth="(\w+)" aria-pressed="(true|false)"/g)];
    expect(depths.map((match) => match[1])).toEqual(["1", "2", "3", "all"]);
    expect(depths.map((match) => match[2])).toEqual(["false", "false", "false", "true"]);
    // Without the script the graph draws every serialized call, so the control
    // is not offered at all.
    expect(html).toContain('class="cf-depth enhanced"');
    expect(html).toContain('aria-label="Graph depth below the focused call"');
  });


  test("call locations show the line span the backend resolved for the call site", () => {
    const rendered = readable(
      renderReview(report([flow("src/a.ts", [nested()])])),
    );
    expect(rendered).toContain("src/a.ts:8-11");
    expect(rendered).toContain("src/a.ts:20");
  });
});
