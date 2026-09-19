import { describe, expect, test } from "vitest";
import { CALL_FLOW_DEFAULT_DEPTH, CALL_FLOW_NAV_SOURCE } from "../src/review/call-flow-nav.js";
import type { CallFlowNav } from "../src/review/call-flow-nav.js";

/**
 * The page runs `CALL_FLOW_NAV_SOURCE`, which is this module's own source text.
 * These tests execute that exact text, so the visited trail, the depth bounds
 * and the mode handling below are the ones a reviewer gets in the browser.
 */
// SAFETY: this locally generated script returns callFlowsNav's typed object.
const nav = new Function(`${CALL_FLOW_NAV_SOURCE}return cfNav;`)() as CallFlowNav;

describe("call-flow navigation", () => {

  test("visits accumulate as the reviewer zooms in", () => {
    let state = nav.createState();
    state = nav.visit(state, 2, "0");
    state = nav.visit(state, 2, "0-1");
    state = nav.visit(state, 2, "0-1-4");
    expect(state.trail).toEqual([
      { file: 2, path: "0" },
      { file: 2, path: "0-1" },
      { file: 2, path: "0-1-4" },
    ]);
    expect(nav.current(state)).toEqual({ file: 2, path: "0-1-4" });
    expect(nav.visit(nav.createState(), 1, "0")).toEqual({
      trail: [{ file: 1, path: "0" }],
      mode: "tree",
      depth: CALL_FLOW_DEFAULT_DEPTH,
    });
  });

  test("the same occurrence path in another file is a different tab", () => {
    let state = nav.visit(nav.createState(), 1, "0-2");
    expect(nav.visit(state, 1, "0-2")).toBe(state); // re-clicking the open tab
    state = nav.visit(state, 3, "0-2");
    expect(state.trail).toEqual([
      { file: 1, path: "0-2" },
      { file: 3, path: "0-2" },
    ]);
    expect(state.trail.map((entry) => nav.key(entry.file, entry.path))).toEqual([
      "1:0-2",
      "3:0-2",
    ]);
  });

  test("going back to a tab drops every visit after it", () => {
    let state = nav.createState();
    for (const path of ["0", "0-1", "0-1-4", "0-2"]) state = nav.visit(state, 4, path);
    state = nav.setDepth(state, 3);
    const back = nav.truncate(state, 1);
    expect(back.trail.map((entry) => entry.path)).toEqual(["0", "0-1"]);
    expect(nav.current(back)).toEqual({ file: 4, path: "0-1" });
    expect(back.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    // Indexes outside the trail, and the open tab, leave the trail alone.
    expect(nav.truncate(back, -1)).toBe(back);
    expect(nav.truncate(back, 9)).toBe(back);
    expect(nav.truncate(back, 1)).toBe(back);
    expect(nav.truncate(back, 0).trail.length).toBe(1);
  });

  test("switching mode keeps the trail; changing focus resets only the depth", () => {
    let state = nav.visit(nav.createState(), 2, "0-1");
    state = nav.setDepth(state, 2);
    state = nav.setMode(state, "graph");
    expect(state).toEqual({ trail: [{ file: 2, path: "0-1" }], mode: "graph", depth: 2 });
    // The depth is read from the current focus, so a new focus starts it over.
    const deeper = nav.visit(state, 2, "0-1-3");
    expect(deeper).toEqual({
      trail: [
        { file: 2, path: "0-1" },
        { file: 2, path: "0-1-3" },
      ],
      mode: "graph",
      depth: CALL_FLOW_DEFAULT_DEPTH,
    });
    expect(nav.setMode(deeper, "sequence").mode).toBe("sequence");
    expect(nav.setMode(deeper, "sequence").trail).toBe(deeper.trail);
    expect(nav.clear(deeper)).toEqual({
      trail: [],
      mode: "graph",
      depth: CALL_FLOW_DEFAULT_DEPTH,
    });
  });

  test("unknown modes and depths are ignored", () => {
    const state = nav.setDepth(nav.visit(nav.createState(), 1, "0"), 2);
    expect(nav.setMode(state, "sunburst")).toBe(state);
    expect(nav.setDepth(state, 4)).toBe(state);
    expect(nav.setDepth(state, "nope")).toBe(state);
    expect(nav.setDepth(state, "3").depth).toBe(3);
    expect(nav.setDepth(state, 1).depth).toBe(1);
  });

  test("depth bounds count call levels below the focused call", () => {
    const focus = "0-1";
    expect(nav.visibleNode("0", focus, 1)).toBe(true); // ancestor stays for context
    expect(nav.visibleNode(focus, focus, 1)).toBe(true);
    expect(nav.visibleNode("0-1-2", focus, 1)).toBe(true);
    expect(nav.visibleNode("0-1-2-3", focus, 1)).toBe(false);
    expect(nav.visibleNode("0-1-2-3", focus, 2)).toBe(true);
    expect(nav.visibleNode("0-1-2-3", focus, 3)).toBe(true);
    expect(nav.visibleNode("0-1-2-3-4", focus, 2)).toBe(false);
    expect(nav.visibleNode("0-1-2-3-4", focus, 3)).toBe(true);
    expect(nav.visibleNode("0-1-2-3-5", focus, 3)).toBe(true);
    expect(nav.visibleNode("0-1-2-3", focus, "all")).toBe(true);
    expect(nav.visibleNode("0-2", focus, 3)).toBe(false); // a different branch
    expect(nav.edgesBelow("0-1", focus)).toBe(0);
    expect(nav.edgesBelow("0-1-2-3", focus)).toBe(2);
    expect(nav.edgesBelow("0-1-2-3-4", focus)).toBe(3);
    // An edge into an ancestor is never drawn; descendant edges follow the depth.
    expect(nav.visibleCall(focus, focus, "all")).toBe(false);
    expect(nav.visibleCall("0", focus, "all")).toBe(false);
    expect(nav.visibleCall("0-1-2", focus, 1)).toBe(true);
    expect(nav.visibleCall("0-1-2-3", focus, 1)).toBe(false);
    // Without a focus, the same bounds count from the roots.
    expect(nav.visibleNode("0", "", 1)).toBe(true);
    expect(nav.visibleNode("0-1", "", 1)).toBe(true);
    expect(nav.visibleNode("0-1-2", "", 1)).toBe(false);
    expect(nav.visibleNode("0-1-2", "", "all")).toBe(true);
    expect(nav.visibleCall("0-1", "", 1)).toBe(true);
    expect(nav.visibleCall("0-1-2", "", 1)).toBe(false);
  });

  test("occurrence paths compare whole steps, not string prefixes", () => {
    expect(nav.parsePath("0-10-2")).toEqual([0, 10, 2]);
    expect(nav.parsePath("")).toEqual([]);
    expect(nav.parsePath("not-a-path")).toEqual([]);
    expect(nav.under("0-1-10", "0-1")).toBe(true);
    expect(nav.under("0-10", "0-1")).toBe(false);
    expect(nav.under("0-1", "")).toBe(true);
    expect(nav.onChain("0-1", "0-1-10")).toBe(true);
    expect(nav.onChain("0-10", "0-1")).toBe(false);
    expect(nav.visibleNode("0-10", "0-1", "all")).toBe(false);
  });
});
