import { describe, expect, test } from "vitest";
import { CALL_FLOW_DEFAULT_DEPTH, CALL_FLOW_NAV_SOURCE } from "../src/review/call-flow-nav.js";
import type { CallFlowNav } from "../src/review/call-flow-nav.js";

/**
 * The page runs `CALL_FLOW_NAV_SOURCE`, which is this module's own source text.
 * These tests execute that exact text, so the selection/branch split, the visited
 * trail, the depth bounds, the camera helpers and the mode handling below are the
 * ones a reviewer gets in the browser.
 */
// SAFETY: this locally generated script returns callFlowsNav's typed object.
const nav = new Function(`${CALL_FLOW_NAV_SOURCE}return cfNav;`)() as CallFlowNav;

const DESKTOP = { width: 800, height: 400 };
const BOUNDS = { x: 0, y: 0, width: 1200, height: 900 };
const BOX = { x: 300, y: 200, width: 180, height: 60 };

describe("call-flow navigation", () => {
  test("visits accumulate as the reviewer follows one call", () => {
    let state = nav.createState();
    expect(state.trail).toEqual([]);
    expect(state.branch).toBeNull();
    expect(state.cameras).toEqual({});
    state = nav.visit(state, 2, "0");
    state = nav.visit(state, 2, "0-1");
    state = nav.visit(state, 2, "0-1-4");
    expect(state.trail).toEqual([
      { file: 2, path: "0" },
      { file: 2, path: "0-1" },
      { file: 2, path: "0-1-4" },
    ]);
    expect(nav.current(state)).toEqual({ file: 2, path: "0-1-4" });
    expect(state.branch).toEqual({ file: 2, path: "0-1-4" });
    // Re-clicking the framed call is not a fourth tab and not a depth reset.
    const framed = nav.setDepth(state, 2);
    expect(nav.visit(framed, 2, "0-1-4")).toBe(framed);
  });

  test("the same occurrence path in another file is a different tab", () => {
    let state = nav.visit(nav.createState(), 1, "0-2");
    expect(nav.visit(state, 1, "0-2")).toBe(state); // re-clicking the open tab
    state = nav.visit(state, 3, "0-2");
    expect(state.trail).toEqual([
      { file: 1, path: "0-2" },
      { file: 3, path: "0-2" },
    ]);
    expect(state.branch).toEqual({ file: 3, path: "0-2" });
    expect(state.trail.map((entry) => nav.key(entry.file, entry.path))).toEqual([
      "1:0-2",
      "3:0-2",
    ]);
  });

  test("selecting a box for source leaves the graph's branch and depth alone", () => {
    let state = nav.visit(nav.createState(), 2, "0-1");
    state = nav.setDepth(state, 1);
    const box = nav.inspect(state, 2, "0-1-2");
    expect(nav.current(box)).toEqual({ file: 2, path: "0-1-2" });
    expect(box.trail.map((entry) => entry.path)).toEqual(["0-1", "0-1-2"]);
    expect(box.branch).toEqual({ file: 2, path: "0-1" }); // frame untouched
    expect(box.depth).toBe(1); // bound untouched
    // Reading the same box twice is not a second tab.
    expect(nav.inspect(box, 2, "0-1-2")).toBe(box);
    // Another box inside the branch keeps the frame as well.
    const nested = nav.inspect(box, 2, "0-1-3");
    expect(nested.branch).toBe(box.branch);
    expect(nested.depth).toBe(1);
  });

  test("a + on the inspected box makes it the branch without repeating the tab", () => {
    let state = nav.visit(nav.createState(), 2, "0-1");
    state = nav.inspect(state, 2, "0-1-2");
    state = nav.setDepth(state, 2);
    const zoomed = nav.visit(state, 2, "0-1-2");
    expect(zoomed.branch).toEqual({ file: 2, path: "0-1-2" });
    expect(zoomed.trail.map((entry) => entry.path)).toEqual(["0-1", "0-1-2"]);
    expect(nav.current(zoomed)).toEqual({ file: 2, path: "0-1-2" });
    // A new branch is a new focus, so the depth starts over.
    expect(zoomed.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    // Now that it is both, re-clicking it is a no-op.
    expect(nav.visit(zoomed, 2, "0-1-2")).toBe(zoomed);
  });

  test("inspecting outside the branch drops the frame and starts the depth over", () => {
    let state = nav.visit(nav.createState(), 2, "0-1");
    state = nav.setDepth(state, 2);
    const sibling = nav.inspect(state, 2, "0-2");
    expect(nav.current(sibling)).toEqual({ file: 2, path: "0-2" });
    expect(sibling.branch).toBeNull();
    expect(sibling.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    // An ancestor of the branch is outside it too.
    expect(nav.inspect(state, 2, "0").branch).toBeNull();
    // So is the same occurrence path in another file.
    const other = nav.inspect(state, 5, "0-1-2");
    expect(other.branch).toBeNull();
    expect(nav.current(other)).toEqual({ file: 5, path: "0-1-2" });
    // A frame that is already open stays open for an inside selection.
    const inside = nav.inspect(other, 5, "0-9");
    expect(inside.branch).toBeNull();
  });

  test("going back to a tab drops every later visit and keeps the cameras", () => {
    let state = nav.createState();
    for (const path of ["0", "0-1", "0-1-4", "0-2"]) state = nav.visit(state, 4, path);
    state = nav.setDepth(state, 3);
    state = nav.setCamera(state, "4:0:0-1:3", { x: 40, y: 50, scale: 1.5 });
    const back = nav.truncate(state, 1);
    expect(back.trail.map((entry) => entry.path)).toEqual(["0", "0-1"]);
    expect(back.branch).toEqual({ file: 4, path: "0-1" });
    expect(nav.current(back)).toEqual({ file: 4, path: "0-1" });
    expect(back.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    // The camera the reviewer framed that graph with is still cached.
    expect(back.cameras["4:0:0-1:3"]).toEqual({ x: 40, y: 50, scale: 1.5 });
    // Indexes outside the trail, and the open tab, leave the trail alone.
    expect(nav.truncate(back, -1)).toBe(back);
    expect(nav.truncate(back, 9)).toBe(back);
    expect(nav.truncate(back, 1)).toBe(back);
    expect(nav.truncate(back, 0).trail.length).toBe(1);
  });

  test("switching view keeps the selection, branch, trail, depth and cameras", () => {
    let state = nav.visit(nav.createState(), 2, "0-1");
    state = nav.inspect(state, 2, "0-1-2"); // the box whose source is open
    state = nav.setDepth(state, 2);
    state = nav.setCamera(state, "2:0:0-1:2", { x: 12, y: 34, scale: 2 });
    const graph = nav.setMode(state, "graph");
    expect(graph.mode).toBe("graph");
    expect(graph.trail).toBe(state.trail);
    expect(graph.trail.length).toBe(2);
    expect(graph.branch).toBe(state.branch);
    expect(graph.cameras).toBe(state.cameras);
    expect(graph.depth).toBe(2);
    // Graph -> Tree keeps the same function selected, without a new tab.
    const tree = nav.setMode(graph, "tree");
    expect(tree.mode).toBe("tree");
    expect(nav.current(tree)).toEqual({ file: 2, path: "0-1-2" });
    expect(tree.trail).toBe(state.trail);
    expect(tree.branch).toEqual({ file: 2, path: "0-1" });
    expect(tree.depth).toBe(2);
    // Sequence -> Tree -> Graph: same occurrence, same frame, same camera.
    const sequence = nav.setMode(tree, "sequence");
    expect(sequence.mode).toBe("sequence");
    const back = nav.setMode(sequence, "graph");
    expect(back.mode).toBe("graph");
    expect(nav.current(back)).toEqual({ file: 2, path: "0-1-2" });
    expect(back.branch).toEqual({ file: 2, path: "0-1" });
    expect(back.trail.length).toBe(2);
    expect(back.depth).toBe(2);
    expect(back.cameras["2:0:0-1:2"]).toEqual({ x: 12, y: 34, scale: 2 });
  });

  test("entering the graph reveals a selection a bounded depth had hidden", () => {
    let state = nav.visit(nav.createState(), 1, "0-1");
    state = nav.inspect(state, 1, "0-1-2-3"); // three levels below the frame
    state = nav.setDepth(state, 1);
    const graph = nav.setMode(state, "graph");
    expect(graph.branch).toEqual({ file: 1, path: "0-1" });
    expect(nav.current(graph)).toEqual({ file: 1, path: "0-1-2-3" });
    // A depth of 1 would draw the graph without the call the reviewer is reading.
    expect(graph.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    // Back in the tree the reviewer sets their own bound again...
    const tree = nav.setMode(graph, "tree");
    expect(nav.setDepth(tree, 1).depth).toBe(1);
    // ...and a bound that still reaches the selection survives the return.
    expect(nav.setMode(nav.setDepth(tree, 3), "graph").depth).toBe(3);
    // Without a branch the same bound counts from the roots.
    const roots = nav.setDepth(nav.inspect(nav.createState(), 1, "0-1-2-3"), 2);
    expect(nav.setMode(roots, "graph").depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
  });

  test("unknown modes and depths are ignored, and a set value is a no-op", () => {
    const state = nav.setDepth(nav.visit(nav.createState(), 1, "0"), 2);
    expect(nav.setMode(state, "sunburst")).toBe(state);
    expect(nav.setMode(state, "tree")).toBe(state);
    expect(nav.setDepth(state, 4)).toBe(state);
    expect(nav.setDepth(state, "nope")).toBe(state);
    expect(nav.setDepth(state, 2)).toBe(state);
    expect(nav.setDepth(state, "3").depth).toBe(3);
    expect(nav.setDepth(state, 1).depth).toBe(1);
    expect(nav.setDepth(state, 1).branch).toEqual({ file: 1, path: "0" });
  });

  test("readable framing is scale 1 on the box; only Overview fits the graph", () => {
    const readable = nav.frame(BOUNDS, DESKTOP, BOX);
    expect(readable.scale).toBe(1);
    // Centre the target where possible, stopping at the graph edge.
    expect(readable).toEqual({ x: 0, y: 184, scale: 1 });
    // A phone viewport still draws readable text; nothing is squeezed to fit.
    expect(nav.frame(BOUNDS, { width: 320, height: 480 }, BOX)).toEqual({
      x: 230,
      y: 184,
      scale: 1,
    });
    // Overview is the one explicit fit, and it frames the whole graph.
    const fit = Math.min(1, DESKTOP.width / BOUNDS.width, DESKTOP.height / BOUNDS.height);
    const overview = nav.frame(BOUNDS, DESKTOP, BOX, true);
    expect(overview.scale).toBeCloseTo(fit);
    expect(overview.scale).toBeLessThan(1);
    expect(overview.x).toBeCloseTo(BOUNDS.x + (BOUNDS.width - DESKTOP.width / fit) / 2);
    expect(overview.y).toBeCloseTo(BOUNDS.y + (BOUNDS.height - DESKTOP.height / fit) / 2);
    expect(overview.x).toBeLessThanOrEqual(BOUNDS.x);
    expect(overview.x + DESKTOP.width / fit).toBeGreaterThanOrEqual(BOUNDS.x + BOUNDS.width);
    expect(overview.y + DESKTOP.height / fit).toBeGreaterThanOrEqual(BOUNDS.y + BOUNDS.height);
    // A graph smaller than the viewport is centred, never magnified.
    expect(nav.frame({ x: 0, y: 0, width: 200, height: 100 }, DESKTOP, BOX, true)).toEqual({
      x: -300,
      y: -150,
      scale: 1,
    });
  });

  test("constrain clamps to the graph, centres what is smaller and repairs a broken camera", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 800 };
    const viewport = { width: 400, height: 300 };
    // A window smaller than the graph stops at the graph edges.
    expect(nav.constrain({ x: -50, y: 2000, scale: 1 }, bounds, viewport)).toEqual({
      x: 0,
      y: 500,
      scale: 1,
    });
    expect(nav.constrain({ x: 520, y: 400, scale: 2 }, bounds, viewport)).toEqual({
      x: 520,
      y: 400,
      scale: 2,
    });
    // A window wider than the graph is centred on it instead.
    expect(nav.constrain({ x: 0, y: 0, scale: 0.25 }, bounds, viewport)).toEqual({
      x: -300,
      y: -200,
      scale: 0.25,
    });
    // An overview below 1 survives, and an already valid camera is unchanged.
    const overview = { x: -300, y: -200, scale: 0.25 };
    expect(nav.constrain(overview, bounds, viewport)).toBe(overview);
    // A nonfinite camera is repaired rather than propagated.
    expect(nav.constrain({ x: NaN, y: Infinity, scale: NaN }, bounds, viewport)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
    expect(nav.constrain({ x: 0, y: 0, scale: 0 }, bounds, viewport).scale).toBe(1);
  });

  test("pan moves the world under the pointer and stops at the graph edge", () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 2000 };
    const viewport = { width: 400, height: 400 };
    // Dragging 100px right moves the world 100px left at scale 1.
    expect(nav.pan({ x: 500, y: 500, scale: 1 }, 100, 50, bounds, viewport)).toEqual({
      x: 400,
      y: 450,
      scale: 1,
    });
    // At scale 2 the same finger covers half the world distance.
    expect(nav.pan({ x: 500, y: 500, scale: 2 }, 100, 50, bounds, viewport)).toEqual({
      x: 450,
      y: 475,
      scale: 2,
    });
    // Panning past an edge pins the camera to it.
    expect(nav.pan({ x: 0, y: 0, scale: 1 }, 100, 100, bounds, viewport)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
    expect(nav.pan({ x: 1600, y: 1600, scale: 1 }, -100, -100, bounds, viewport)).toEqual({
      x: 1600,
      y: 1600,
      scale: 1,
    });
    // A nonfinite drag is ignored instead of freezing the graph on NaN.
    const held = { x: 500, y: 500, scale: 1 };
    expect(nav.pan(held, NaN, 0, bounds, viewport)).toBe(held);
    expect(nav.pan(held, 0, Infinity, bounds, viewport)).toBe(held);
  });

  test("zoom keeps the anchor's world point and the readable range", () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 2000 };
    const viewport = { width: 400, height: 400 };
    const anchor = { x: 200, y: 100 };
    const camera = { x: 500, y: 500, scale: 1 };
    const world = { x: camera.x + anchor.x, y: camera.y + anchor.y };
    const closer = nav.zoom(camera, 2, anchor, bounds, viewport);
    expect(closer).toEqual({
      x: world.x - anchor.x / 2,
      y: world.y - anchor.y / 2,
      scale: 2,
    });
    // The world point under the pointer did not move.
    expect(closer.x + anchor.x / closer.scale).toBeCloseTo(world.x);
    expect(closer.y + anchor.y / closer.scale).toBeCloseTo(world.y);
    // Zooming out stops at the readable scale: fitting is Overview's job.
    expect(nav.zoom(closer, 0.5, anchor, bounds, viewport)).toEqual(camera);
    expect(nav.zoom(camera, 0.25, anchor, bounds, viewport)).toBe(camera);
    // Zooming in stops at the top of the range.
    const top = { x: 0, y: 0, scale: 2.5 };
    expect(nav.zoom(top, 4, anchor, bounds, viewport)).toBe(top);
    // Even an anchor in the corner cannot pull the camera out of the graph.
    expect(nav.zoom({ x: 0, y: 0, scale: 1 }, 2, { x: 0, y: 0 }, bounds, viewport)).toEqual({
      x: 0,
      y: 0,
      scale: 2,
    });
    // Nonfinite input is ignored rather than applied.
    expect(nav.zoom(camera, NaN, anchor, bounds, viewport)).toBe(camera);
    expect(nav.zoom(camera, 0, anchor, bounds, viewport)).toBe(camera);
    expect(nav.zoom(camera, 2, { x: NaN, y: 0 }, bounds, viewport)).toBe(camera);
  });

  test("each graph frame keeps its own camera, and clearing keeps them", () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 2000 };
    const viewport = { width: 400, height: 400 };
    const deep = `${nav.key(3, "0-1")}:1`;
    const shallow = `${nav.key(3, "0-2")}:all`;
    let state = nav.visit(nav.createState(), 3, "0-1");
    state = nav.setCamera(state, deep, { x: 20, y: 300, scale: 1.5 });
    state = nav.setCamera(state, shallow, { x: 900, y: 40, scale: 1 });
    // Writing the camera that is already there is not a change.
    expect(nav.setCamera(state, deep, { x: 20, y: 300, scale: 1.5 })).toBe(state);
    // Panning one frame leaves the other exactly where it was.
    const dragged = nav.pan(state.cameras[deep], 0, 150, bounds, viewport);
    expect(dragged).toEqual({ x: 20, y: 200, scale: 1.5 });
    const moved = nav.setCamera(state, deep, dragged);
    expect(moved).not.toBe(state);
    expect(moved.cameras[deep]).toEqual({ x: 20, y: 200, scale: 1.5 });
    expect(moved.cameras[shallow]).toEqual({ x: 900, y: 40, scale: 1 });
    // The mode hands the same cache on, and clear keeps it while dropping the rest.
    expect(nav.setMode(moved, "graph").cameras).toBe(moved.cameras);
    // A non-default frame and depth, so a reset and a preserved value differ.
    const framed = nav.setDepth(nav.setMode(moved, "graph"), 3);
    expect(framed.mode).toBe("graph");
    expect(framed.depth).toBe(3);
    const cleared = nav.clear(framed);
    expect(cleared.trail).toEqual([]);
    expect(cleared.branch).toBeNull();
    expect(cleared.depth).toBe(CALL_FLOW_DEFAULT_DEPTH);
    expect(cleared.mode).toBe(framed.mode);
    expect(cleared.cameras).toEqual(moved.cameras);
    expect(nav.clear(cleared).cameras).toEqual(moved.cameras);
    // Invalid writes are refused outright.
    expect(nav.setCamera(moved, "k", { x: NaN, y: 0, scale: 1 })).toBe(moved);
    expect(nav.setCamera(moved, "k", { x: 0, y: 0, scale: 0 })).toBe(moved);
    expect(nav.setCamera(moved, "", { x: 0, y: 0, scale: 1 })).toBe(moved);
    // The cache does not alias the caller's object.
    const source = { x: 1, y: 2, scale: 1 };
    const stored = nav.setCamera(nav.createState(), "g", source);
    source.x = 99;
    expect(stored.cameras["g"]).toEqual({ x: 1, y: 2, scale: 1 });
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
