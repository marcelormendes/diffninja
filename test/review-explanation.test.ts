import { describe, expect, test } from "vitest";
import {
  MAX_EXPLAINED_FUNCTIONS,
  checkExplanation,
  exitsOf,
  functionsOf,
  normalizeExplanation,
  type BusinessProcess,
  type ExplanationInput,
} from "../src/review/explanation.js";
import { layoutProcess, renderBusinessView } from "../src/review/process-html.js";
import { renderBusinessPage, renderCallFlowPage, renderReview } from "../src/review/html.js";
import type { CallFlowNode, ReviewItem, ReviewReport } from "../src/review/types.js";

const ATTACK = '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "hunk-1",
    file: "shop/checkout.py",
    header: "@@ -1 +1 @@",
    diff: "@@ -1 +1 @@\n-limit = 1\n+limit = 2\n",
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

function node(key: string, file: string | undefined, children: CallFlowNode[] = []): CallFlowNode {
  const resolved: CallFlowNode = { key, label: `${key}()`, status: "changed", file: "shop/checkout.py", line: 3, children };
  if (file !== undefined) resolved.source = { file, line: 10, endLine: 12, ref: "abc1234", text: `def ${key}():\n    pass\n` };
  return resolved;
}

/** A checkout report: one changed hunk, its context, and a call flow with a library call under it. */
function report(): ReviewReport {
  const hunk = item({
    contextNodes: [
      { key: "after:charge_order", label: "charge_order(order)", file: "shop/checkout.py", line: 20, detail: "" },
      { key: "before:Order.capture", label: "Order.capture(amount)", file: "shop/payments.py", line: 5, detail: "" },
    ],
  });
  const test_hunk = item({ id: "hunk-2", file: "tests/test_checkout.py", status: "low", contextNodes: [
    { key: "after:test_charge", label: "test_charge()", file: "tests/test_checkout.py", line: 1, detail: "" },
  ] });
  return {
    title: "Charge before reserving stock",
    source: "main to feature",
    createdAt: "2026-09-27T00:00:00Z",
    items: [hunk, test_hunk],
    callFlow: [],
    callFlows: [{
      file: "shop/checkout.py",
      truncated: false,
      trees: [node("checkout", "shop/checkout.py", [node("self.capture", "shop/payments.py"), node("json.dumps", undefined)])],
    }],
    callFlowAvailability: "available",
    warnings: [],
    questions: [],
  };
}

function withFunctions(base: ReviewReport = report()): ReviewReport {
  return { ...base, functions: functionsOf(base) };
}

const PROCESS: BusinessProcess = {
  title: "Checking out",
  steps: [
    { id: "s1", kind: "start", text: "A shopper places an order", change: "unchanged" },
    { id: "s2", kind: "action", text: "Charge the shopper's card", change: "changed", before: "Stock was reserved first, then the card was charged.", functions: ["shop/checkout.py#charge_order"], hunks: ["hunk-1"] },
    { id: "s3", kind: "decision", text: "Did the payment go through?", change: "added", next: [{ to: "s4", when: "yes" }, { to: "s5", when: "no" }] },
    { id: "s4", kind: "action", text: "Reserve the stock", change: "unchanged", next: [{ to: "s6" }] },
    { id: "s5", kind: "action", text: "Ask the shopper to try again", change: "added", next: [{ to: "s2", when: "retry" }] },
    { id: "s6", kind: "end", text: "The order is confirmed", change: "unchanged" },
  ],
};

function explanation(target: ReviewReport, overrides: Partial<ExplanationInput> = {}): ExplanationInput {
  return {
    functions: (target.functions ?? []).map((fn) => ({ id: fn.id, purpose: `Handles the ${fn.name.replace(/_/g, " ")} part of checkout.` })),
    processes: [PROCESS],
    rules: [
      { text: "A card is charged before any stock is held for the order.", change: "changed", before: "Stock was held first and released when the charge failed.", hunks: ["hunk-1"] },
    ],
    ...overrides,
  };
}

/** The page as a reader sees it: style and script removed. */
function readable(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, "");
}

describe("functionsOf", () => {
  test("lists each function once by file and name, product code before tests, and skips calls with no definition", () => {
    const ids = functionsOf(report()).map((fn) => fn.id);
    expect(ids).toEqual([
      "shop/checkout.py#charge_order",
      "shop/payments.py#capture",
      "shop/checkout.py#checkout",
      "tests/test_checkout.py#test_charge",
    ]);
    // `self.capture` in the call flow is the same function as `Order.capture` around the hunk.
    expect(ids.filter((id) => id.endsWith("#capture"))).toHaveLength(1);
    expect(ids.some((id) => id.includes("dumps"))).toBe(false);
    expect(functionsOf(report()).find((fn) => fn.id.startsWith("tests/"))?.inTests).toBe(true);
  });

  test("is capped, and the cap cuts test helpers before product code", () => {
    const many = report();
    many.items[1].contextNodes = Array.from({ length: MAX_EXPLAINED_FUNCTIONS + 5 }, (_, at) => ({
      key: `after:helper_${at}`, label: `helper_${at}()`, file: "tests/test_checkout.py", line: at + 1, detail: "",
    }));
    const listed = functionsOf(many);
    expect(listed).toHaveLength(MAX_EXPLAINED_FUNCTIONS);
    expect(listed.slice(0, 3).map((fn) => fn.inTests)).toEqual([false, false, false]);
  });
});

describe("checkExplanation", () => {
  test("accepts a complete explanation", () => {
    const target = withFunctions();
    expect(() => checkExplanation(target, explanation(target))).not.toThrow();
  });

  const refusals: Array<[string, (target: ReviewReport) => ExplanationInput, RegExp]> = [
    ["a function left out", (t) => explanation(t, { functions: explanation(t).functions.slice(1) }), /leaves out 1 of 4 functions, starting with shop\/checkout.py#charge_order/],
    ["an unknown function", (t) => explanation(t, { functions: [...explanation(t).functions, { id: "shop/x.py#y", purpose: "Does a thing." }] }), /not in this review's functions list/],
    ["a function explained twice", (t) => explanation(t, { functions: [...explanation(t).functions, explanation(t).functions[0]] }), /a second time/],
    ["a purpose that is a function call", (t) => explanation(t, { functions: explanation(t).functions.map((f, at) => (at === 0 ? { ...f, purpose: "Calls charge(order) first." } : f)) }), /reads like code \(a function call/],
    ["a purpose with a snake_case name", (t) => explanation(t, { functions: explanation(t).functions.map((f, at) => (at === 0 ? { ...f, purpose: "Wraps charge_order for checkout." } : f)) }), /snake_case name/],
    ["a purpose with a source path", (t) => explanation(t, { functions: explanation(t).functions.map((f, at) => (at === 0 ? { ...f, purpose: "Lives in shop/checkout.py and charges cards." } : f)) }), /source file path/],
    ["a purpose in Markdown", (t) => explanation(t, { functions: explanation(t).functions.map((f, at) => (at === 0 ? { ...f, purpose: "**Charges** the card." } : f)) }), /Markdown or HTML/],
    ["a purpose on two lines", (t) => explanation(t, { functions: explanation(t).functions.map((f, at) => (at === 0 ? { ...f, purpose: "Charges\nthe card." } : f)) }), /one line of plain text/],
    ["no process", (t) => explanation(t, { processes: [] }), /draw 1 to 4/],
    ["a step going nowhere", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s4" ? { ...s, next: [{ to: "s9" }] } : s)) }] }), /goes to s9, which is not a step/],
    ["a decision with one exit", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s3" ? { ...s, next: [{ to: "s4", when: "yes" }] } : s)) }] }), /needs at least two next steps/],
    ["a decision exit without when", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s3" ? { ...s, next: [{ to: "s4" }, { to: "s5", when: "no" }] } : s)) }] }), /when is missing/],
    ["an end with an exit", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s6" ? { ...s, next: [{ to: "s1" }] } : s)) }] }), /is an end/],
    ["a repeated step id", (t) => explanation(t, { processes: [{ ...PROCESS, steps: [...PROCESS.steps, PROCESS.steps[0]] }] }), /repeats the step id s1/],
    ["a step naming an unknown hunk", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s4" ? { ...s, hunks: ["hunk-9"] } : s)) }] }), /names a hunk this review does not have/],
    ["a step naming an unknown function", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s4" ? { ...s, functions: ["shop/x.py#y"] } : s)) }] }), /not a function this review lists/],
    ["before on an added step", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s3" ? { ...s, before: "It was not asked." } : s)) }] }), /before is only for a changed step/],
    ["a changed rule without before", (t) => explanation(t, { rules: [{ text: "A card is charged first.", change: "changed" }] }), /rules\[0\]\.before is missing/],
    ["too long a step", (t) => explanation(t, { processes: [{ ...PROCESS, steps: PROCESS.steps.map((s) => (s.id === "s1" ? { ...s, text: "word ".repeat(30) } : s)) }] }), /longer than 90 characters/],
  ];
  test.each(refusals)("refuses %s", (_name, build, expected) => {
    const target = withFunctions();
    expect(() => checkExplanation(target, build(target))).toThrow(expected);
  });

  test("allows ordinary prose that only looks near code", () => {
    const target = withFunctions();
    const prose = explanation(target, {
      functions: explanation(target).functions.map((f, at) => (at === 0 ? { ...f, purpose: "Charges the total (after tax) through the Node.js payment app, e.g. for PARTIALLY_PAID orders." } : f)),
    });
    expect(() => checkExplanation(target, prose)).not.toThrow();
  });
});

describe("the business view", () => {
  function explained(): ReviewReport {
    const target = withFunctions();
    target.agentExplanation = normalizeExplanation(explanation(target), "test-agent 1.0");
    return target;
  }

  test("an action without next continues to the next step listed; a decision and an end never do", () => {
    const exits = exitsOf(PROCESS);
    expect(exits.get("s1")).toEqual([{ to: "s2" }]);
    expect(exits.get("s3")).toHaveLength(2);
    expect(exits.get("s6")).toEqual([]);
  });

  test("the layout keeps boxes apart and sends a retry up a lane on the left", () => {
    const layout = layoutProcess(PROCESS);
    for (const a of layout.boxes) {
      for (const b of layout.boxes) {
        if (a === b) continue;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.step.id} overlaps ${b.step.id}`).toBe(true);
      }
    }
    const retry = layout.edges.find((edge) => edge.from.step.id === "s5" && edge.to.step.id === "s2");
    expect(retry?.route).toBe("lane-left");
    // A decision's exits leave its bottom in the order they head, so they never cross.
    const decision = layout.edges.filter((edge) => edge.from.step.id === "s3").sort((a, b) => a.slot - b.slot);
    expect(decision.map((edge) => edge.to.x)).toEqual(decision.map((edge) => edge.to.x).sort((a, b) => a - b));
    // The same explanation always draws the same chart.
    expect(JSON.stringify(layoutProcess(PROCESS).boxes.map((box) => [box.x, box.y]))).toBe(JSON.stringify(layout.boxes.map((box) => [box.x, box.y])));
  });

  test("draws each process with its changed steps marked, lists the rules before and after, and escapes every string", () => {
    const target = explained();
    target.agentExplanation!.processes[0].steps[0].text = ATTACK;
    const html = renderBusinessView(target, { hunkHref: (id) => `#item-${id === "hunk-1" ? 1 : 2}` });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain('class="bp-chart"');
    expect(html).toContain("bp-node bp-kind-action bp-changed");
    expect(html).toContain("bp-node bp-kind-decision bp-added");
    expect(html).toContain("Explained by test-agent 1.0");
    expect(html).toContain('data-open-hunk href="#item-1"');
    expect(readable(html)).toContain("Stock was held first and released when the charge failed.");
    // A step's functions show what they do first and their code name second.
    expect(html.indexOf("Handles the charge order part of checkout.")).toBeLessThan(html.indexOf("charge_order · shop/checkout.py:20"));
  });

  test("the report page opens on the business view once explained, and only then", () => {
    expect(renderReview(withFunctions())).not.toContain('data-default-view="business"');
    expect(renderReview(withFunctions())).toContain("No business explanation yet");
    const page = renderReview(explained());
    expect(page).toContain('data-default-view="business"');
    expect(page).toContain('<a href="#view-business" data-view="business">How it works</a>');
  });

  test("the call flow puts each explained call's purpose first and marks library-only calls as plumbing", () => {
    const page = readable(renderCallFlowPage(explained()));
    expect(page).toContain('<span class="cf-purpose">Handles the checkout part of checkout.</span>');
    expect(page).toContain('<span class="cf-purpose">Handles the capture part of checkout.</span>');
    expect(page).toMatch(/class="cf-node[^"]*\bcf-plumbing\b[^"]*"/);
    expect(page).not.toMatch(/class="cf-node[^"]*\bcf-explained\b[^"]*\bcf-plumbing\b/);
    expect(page).toContain("Show 1 library or framework call with no product code below");
  });

  test("the framed business page for the pull request page leaves out the glossary and folds the steps", () => {
    const page = renderBusinessPage(explained());
    expect(page).toContain('class="bp-chart"');
    expect(page).not.toContain("What each function does");
    expect(page).toContain('<details class="bp-steps-box">');
    expect(page).toContain("diffninja-business-height");
  });

  test("the frame reports its content's height, so it can shrink as well as grow", () => {
    const page = renderBusinessPage(explained());
    expect(page).toContain("document.documentElement.getBoundingClientRect().height");
    expect(page).not.toContain("documentElement.scrollHeight");
  });

  test("the call-flow page repeats neither the business view nor the view switches", () => {
    const page = renderCallFlowPage(explained());
    expect(page).not.toContain("How it works");
    expect(page).not.toContain('class="bp"');
    expect(page).not.toContain('class="cf-controls"');
    expect(page).not.toContain('class="cf-mode-link');
    expect(page).not.toContain('class="cf-diagram-btn');
    expect(page).not.toContain('<h3 class="cf-mode-head"');
    expect(page).toContain('class="cf-tree"');
  });
});
