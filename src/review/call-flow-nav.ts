/**
 * Navigation state for the Tree, Graph and Sequence call-flow views.
 *
 * This module is the only implementation of focus, branch, visited-trail, depth
 * and graph-camera behaviour. The server renderer prints the mode and depth
 * controls from `CALL_FLOW_MODES` / `CALL_FLOW_DEPTHS`, the page script runs this
 * module's own source text (see `CALL_FLOW_NAV_SOURCE`, built from
 * `callFlowsNav.toString()`) and the unit tests call the module directly, so the
 * tested functions are the ones the browser executes.
 *
 * A visit is identified by the file index plus the occurrence path inside that
 * file (`0-2-1`) — never by a label or a key — so two calls that share a name,
 * or two identical paths in different files, stay distinct trail entries.
 *
 * Two calls are selected at once: the *selection* (`current`, the tail of the
 * trail, the call the source panel and the views highlight) and the *branch* the
 * graph is framed on. Reading source moves the selection only; `+`, an edge
 * number, a tree label or a sequence chip moves the branch as well. The camera
 * cache is keyed by the caller per graph frame, so panning one graph, switching
 * modes and coming back never re-frames another graph.
 *
 * TypeScript erases the annotations before this self-contained function is
 * embedded. Its body must not reference module-scope runtime values.
 */

export const CALL_FLOW_MODES = ["tree", "graph", "sequence"] as const;
/** Graph depth is counted in call levels below the current focus. */
export const CALL_FLOW_DEPTHS = [1, 2, 3, "all"] as const;
/** Depth the control starts at and returns to whenever the focus changes. */
export const CALL_FLOW_DEFAULT_DEPTH = "all" as const;

export type FlowMode = (typeof CALL_FLOW_MODES)[number];
export type FlowDepth = (typeof CALL_FLOW_DEPTHS)[number];

/** One focused call: the file section it lives in and its occurrence path. */
export interface CallFlowVisit {
  readonly file: number;
  readonly path: string;
}

/** World-space rectangle of a drawn graph, in SVG user units. */
export interface FlowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pixel size of the canvas a camera is drawn into. */
export interface FlowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A graph camera: `x`/`y` is the world point drawn at the viewport's top-left
 * corner, `scale` the zoom, so the SVG viewBox is
 * `x y viewport.width / scale viewport.height / scale`.
 */
export interface FlowCamera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Focus, branch, visited trail, mode, depth and cameras shared by every view. */
export interface CallFlowNavState {
  readonly trail: ReadonlyArray<CallFlowVisit>;
  readonly mode: FlowMode;
  readonly depth: FlowDepth;
  /**
   * The branch the graph is framed on: the last explicit jump (`+`, edge number,
   * tree label, sequence chip). `null` frames the whole graph from its roots.
   */
  readonly branch: CallFlowVisit | null;
  /** Last camera seen per graph frame key; survives mode switches and `clear`. */
  readonly cameras: Readonly<Record<string, FlowCamera>>;
}

export interface CallFlowNav {
  /** Occurrence path `0-2-1` as numbers; `""` (no focus) parses to `[]`. */
  parsePath(path: string): number[];
  /** `path` is `at` or below it. An empty `at` means "no restriction". */
  under(path: string, at: string): boolean;
  /** `path` is `at` or one of its ancestors. An empty `at` means "no restriction". */
  onChain(path: string, at: string): boolean;
  /** Call levels between `at` (or the roots, when empty) and `path`. */
  edgesBelow(path: string, at: string): number;
  /** Should this node be drawn for focus `at` at this depth? */
  visibleNode(path: string, at: string, depth: FlowDepth): boolean;
  /** Should an incoming call edge into this node be drawn? */
  visibleCall(path: string, at: string, depth: FlowDepth): boolean;
  /** Distinct identity of a visit, for tests and for trail bookkeeping. */
  key(file: number, path: string): string;
  createState(): CallFlowNavState;
  /** The selected visit, or null when the whole file list is shown. */
  current(state: CallFlowNavState): CallFlowVisit | null;
  /**
   * Focus a call on an explicit jump, appending it to the trail when it is not
   * already the selection and framing the graph on it. Re-visiting the branch
   * that is also the selection is a no-op; the depth starts over whenever the
   * branch changes, because it is read relative to the branch just opened.
   */
  visit(state: CallFlowNavState, file: number, path: string): CallFlowNavState;
  /**
   * Select a call for inspection — the source panel, not the graph frame. The
   * branch and the depth stay as they are, unless the inspected call is outside
   * the branch (another file, another subtree, an ancestor), which drops the
   * branch and starts the depth over. Inspecting the current selection is a
   * no-op.
   */
  inspect(state: CallFlowNavState, file: number, path: string): CallFlowNavState;
  /**
   * Go back to trail entry `index`: it becomes the branch, the later visits are
   * dropped and the depth starts over. Works on earlier entries only.
   */
  truncate(state: CallFlowNavState, index: number): CallFlowNavState;
  /** Drop trail and branch and start the depth over; cameras stay cached. */
  clear(state: CallFlowNavState): CallFlowNavState;
  /**
   * Switch view. Selection, branch, trail, depth and cameras are preserved, so
   * following one call through Tree, Graph and Sequence never loses the frame.
   * Entering the graph with a bounded depth that would hide the selection
   * widens the depth instead of drawing the graph without its selected call.
   */
  setMode(state: CallFlowNavState, mode: string): CallFlowNavState;
  setDepth(state: CallFlowNavState, depth: string | number): CallFlowNavState;
  /**
   * Readable (scale 1) framing of `target`, or — with `overview` — the whole of
   * `bounds` scaled down to fit. Both obey the same bounds as pan and zoom.
   */
  frame(bounds: FlowRect, viewport: FlowSize, target: FlowRect, overview?: boolean): FlowCamera;
  /**
   * Clamp a camera to `bounds`: content larger than the viewport stops at the
   * graph edges, content smaller is centred. `scale` is only repaired, never
   * raised to 1, so an overview below 1 survives.
   */
  constrain(camera: FlowCamera, bounds: FlowRect, viewport: FlowSize): FlowCamera;
  /** Drag the canvas by screen pixels: the world follows the pointer, clamped. */
  pan(camera: FlowCamera, dx: number, dy: number, bounds: FlowRect, viewport: FlowSize): FlowCamera;
  /**
   * Zoom by `factor` about a screen-space `anchor`, keeping the world point under
   * that pixel, clamped to the readable range [1, 2.5] and to `bounds`.
   */
  zoom(
    camera: FlowCamera,
    factor: number,
    anchor: { x: number; y: number },
    bounds: FlowRect,
    viewport: FlowSize,
  ): FlowCamera;
  /** Remember one graph frame's camera. Unchanged or invalid writes are no-ops. */
  setCamera(state: CallFlowNavState, key: string, camera: FlowCamera): CallFlowNavState;
  readonly modes: ReadonlyArray<FlowMode>;
  readonly depths: ReadonlyArray<FlowDepth>;
}

export function callFlowsNav(): CallFlowNav {
  var MODES: FlowMode[] = ['tree', 'graph', 'sequence'];
  var DEPTHS: FlowDepth[] = [1, 2, 3, 'all'];
  var DEFAULT_DEPTH: FlowDepth = 'all';
  /** Overview may shrink below this; `zoom` never does. */
  var READABLE_SCALE = 1;
  var MAX_SCALE = 2.5;
  /** World units left above a framed box, so its label is not flush with the edge. */
  var FRAME_HEADROOM = 16;

  function finite(value: number): boolean {
    return Number.isFinite(value);
  }

  function parsePath(path: string): number[] {
    if (path === '') return [];
    var parts = path.split('-');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var step = Number(parts[i]);
      if (!isFinite(step)) return [];
      out.push(step);
    }
    return out;
  }

  function under(path: string, at: string): boolean {
    return at === '' || path === at || path.indexOf(at + '-') === 0;
  }

  function onChain(path: string, at: string): boolean {
    return at === '' || path === at || at.indexOf(path + '-') === 0;
  }

  function edgesBelow(path: string, at: string): number {
    var base = at === '' ? 1 : parsePath(at).length;
    if (base === 0) return 0;
    var delta = parsePath(path).length - base;
    return delta > 0 ? delta : 0;
  }

  function withinDepth(path: string, at: string, depth: FlowDepth): boolean {
    return depth === 'all' || edgesBelow(path, at) <= Number(depth);
  }

  function visibleNode(path: string, at: string, depth: FlowDepth): boolean {
    if (at === '') return withinDepth(path, at, depth);
    if (onChain(path, at)) return true;
    return under(path, at) && withinDepth(path, at, depth);
  }

  function visibleCall(path: string, at: string, depth: FlowDepth): boolean {
    if (at === '') return withinDepth(path, at, depth);
    if (onChain(path, at) || !under(path, at)) return false;
    return withinDepth(path, at, depth);
  }

  function key(file: number, path: string): string {
    return String(file) + ':' + path;
  }

  /** Is this visit the one at `file`/`path`? */
  function at(a: CallFlowVisit | null, file: number, path: string): boolean {
    return a !== null && a.file === file && a.path === path;
  }

  function rebuild(
    state: CallFlowNavState,
    trail: ReadonlyArray<CallFlowVisit>,
    branch: CallFlowVisit | null,
    depth: FlowDepth,
  ): CallFlowNavState {
    return { trail: trail, mode: state.mode, depth: depth, branch: branch, cameras: state.cameras };
  }

  /** The trail with `file`/`path` appended, unless it is already selected. */
  function selected(
    trail: ReadonlyArray<CallFlowVisit>,
    file: number,
    path: string,
  ): ReadonlyArray<CallFlowVisit> {
    if (at(trail.length === 0 ? null : trail[trail.length - 1], file, path)) return trail;
    var next = trail.slice();
    next.push({ file: file, path: path });
    return next;
  }

  function copyCameras(cameras: Readonly<Record<string, FlowCamera>>): Record<string, FlowCamera> {
    var next: Record<string, FlowCamera> = {};
    for (var name in cameras) {
      if (Object.prototype.hasOwnProperty.call(cameras, name)) next[name] = cameras[name];
    }
    return next;
  }

  function createState(): CallFlowNavState {
    return { trail: [], mode: 'tree', depth: DEFAULT_DEPTH, branch: null, cameras: {} };
  }

  function current(state: CallFlowNavState): CallFlowVisit | null {
    return state.trail.length === 0 ? null : state.trail[state.trail.length - 1];
  }

  function visit(state: CallFlowNavState, file: number, path: string): CallFlowNavState {
    var index = Number(file);
    if (!finite(index)) return state;
    var known = at(state.branch, index, path);
    if (known && at(current(state), index, path)) return state;
    var depth = known ? state.depth : DEFAULT_DEPTH;
    return rebuild(
      state,
      selected(state.trail, index, path),
      { file: index, path: path },
      depth,
    );
  }

  function inspect(state: CallFlowNavState, file: number, path: string): CallFlowNavState {
    var index = Number(file);
    if (!finite(index)) return state;
    if (at(current(state), index, path)) return state;
    var trail = selected(state.trail, index, path);
    var branch = state.branch;
    var depth = state.depth;
    if (branch !== null && (branch.file !== index || !under(path, branch.path))) {
      branch = null;
      depth = DEFAULT_DEPTH;
    }
    return rebuild(state, trail, branch, depth);
  }

  function truncate(state: CallFlowNavState, index: number): CallFlowNavState {
    var pos = Number(index);
    if (!isFinite(pos) || pos < 0 || pos >= state.trail.length - 1) return state;
    var entry = state.trail[pos];
    return rebuild(
      state,
      state.trail.slice(0, pos + 1),
      { file: entry.file, path: entry.path },
      DEFAULT_DEPTH,
    );
  }

  function clear(state: CallFlowNavState): CallFlowNavState {
    return rebuild(state, [], null, DEFAULT_DEPTH);
  }

  function setMode(state: CallFlowNavState, mode: string): CallFlowNavState {
    if (mode !== 'tree' && mode !== 'graph' && mode !== 'sequence') return state;
    if (mode === state.mode) return state;
    var depth = state.depth;
    if (mode === 'graph') {
      // The graph highlights the selection, so a depth that hid it would draw
      // the branch without the call the reviewer is reading.
      var selection = current(state);
      var focus = state.branch === null ? '' : state.branch.path;
      if (
        selection !== null &&
        !withinDepth(selection.path, focus, depth) &&
        under(selection.path, focus)
      ) {
        depth = DEFAULT_DEPTH;
      }
    }
    return {
      trail: state.trail,
      mode: mode,
      depth: depth,
      branch: state.branch,
      cameras: state.cameras,
    };
  }

  function readDepth(value: string | number): FlowDepth | null {
    for (var i = 0; i < DEPTHS.length; i++) {
      if (String(DEPTHS[i]) === String(value)) return DEPTHS[i];
    }
    return null;
  }

  function setDepth(state: CallFlowNavState, depth: string | number): CallFlowNavState {
    var next = readDepth(depth);
    if (next === null || next === state.depth) return state;
    return rebuild(state, state.trail, state.branch, next);
  }

  function cameraScale(camera: FlowCamera): number {
    return finite(camera.scale) && camera.scale > 0 ? camera.scale : READABLE_SCALE;
  }

  function sameCamera(a: FlowCamera, b: FlowCamera): boolean {
    return a.x === b.x && a.y === b.y && a.scale === b.scale;
  }

  /**
   * One axis of `constrain`: content wider than the viewport is windowed inside
   * the graph, content narrower is centred on it.
   */
  function clampAxis(value: number, start: number, size: number, extent: number): number {
    if (!finite(extent) || !finite(size) || !finite(start)) return value;
    if (extent >= size) return start + (size - extent) / 2;
    var max = start + size - extent;
    return value < start ? start : value > max ? max : value;
  }

  function constrain(camera: FlowCamera, bounds: FlowRect, viewport: FlowSize): FlowCamera {
    var scale = cameraScale(camera);
    var next = {
      x: clampAxis(
        finite(camera.x) ? camera.x : bounds.x,
        bounds.x,
        bounds.width,
        viewport.width / scale,
      ),
      y: clampAxis(
        finite(camera.y) ? camera.y : bounds.y,
        bounds.y,
        bounds.height,
        viewport.height / scale,
      ),
      scale: scale,
    };
    return sameCamera(next, camera) ? camera : next;
  }

  function frame(bounds: FlowRect, viewport: FlowSize, target: FlowRect, overview?: boolean): FlowCamera {
    if (
      !finite(bounds.width) ||
      !finite(bounds.height) ||
      !finite(viewport.width) ||
      !finite(viewport.height) ||
      !finite(target.x) ||
      !finite(target.y) ||
      !finite(target.width) ||
      !finite(target.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return { x: bounds.x, y: bounds.y, scale: READABLE_SCALE };
    }
    if (overview) {
      var fit = Math.min(
        READABLE_SCALE,
        viewport.width / bounds.width,
        viewport.height / bounds.height,
      );
      var scale = finite(fit) && fit > 0 ? fit : READABLE_SCALE;
      return {
        x: bounds.x + (bounds.width - viewport.width / scale) / 2,
        y: bounds.y + (bounds.height - viewport.height / scale) / 2,
        scale: scale,
      };
    }
    return constrain({
      x: target.x + target.width / 2 - viewport.width / 2,
      y: target.y - FRAME_HEADROOM,
      scale: READABLE_SCALE,
    }, bounds, viewport);
  }

  function pan(
    camera: FlowCamera,
    dx: number,
    dy: number,
    bounds: FlowRect,
    viewport: FlowSize,
  ): FlowCamera {
    if (!finite(dx) || !finite(dy)) return camera;
    var scale = cameraScale(camera);
    return constrain(
      { x: camera.x - dx / scale, y: camera.y - dy / scale, scale: scale },
      bounds,
      viewport,
    );
  }

  function zoom(
    camera: FlowCamera,
    factor: number,
    anchor: { x: number; y: number },
    bounds: FlowRect,
    viewport: FlowSize,
  ): FlowCamera {
    if (!finite(factor) || factor <= 0) return camera;
    if (!finite(anchor.x) || !finite(anchor.y)) {
      return camera;
    }
    var scale = cameraScale(camera);
    var next = scale * factor;
    if (next < READABLE_SCALE) next = READABLE_SCALE;
    else if (next > MAX_SCALE) next = MAX_SCALE;
    // The world point under the anchor stays under the anchor.
    var x = camera.x + anchor.x / scale - anchor.x / next;
    var y = camera.y + anchor.y / scale - anchor.y / next;
    var zoomed = constrain({ x: x, y: y, scale: next }, bounds, viewport);
    return sameCamera(zoomed, camera) ? camera : zoomed;
  }

  function setCamera(state: CallFlowNavState, name: string, camera: FlowCamera): CallFlowNavState {
    if (name === '') return state;
    if (!finite(camera.x) || !finite(camera.y) || !finite(camera.scale) || camera.scale <= 0) {
      return state;
    }
    var stored = state.cameras[name];
    if (stored !== undefined && sameCamera(stored, camera)) return state;
    var cameras = copyCameras(state.cameras);
    cameras[name] = { x: camera.x, y: camera.y, scale: camera.scale };
    return {
      trail: state.trail,
      mode: state.mode,
      depth: state.depth,
      branch: state.branch,
      cameras: cameras,
    };
  }

  return {
    parsePath: parsePath,
    under: under,
    onChain: onChain,
    edgesBelow: edgesBelow,
    visibleNode: visibleNode,
    visibleCall: visibleCall,
    key: key,
    createState: createState,
    current: current,
    visit: visit,
    inspect: inspect,
    truncate: truncate,
    clear: clear,
    setMode: setMode,
    setDepth: setDepth,
    frame: frame,
    constrain: constrain,
    pan: pan,
    zoom: zoom,
    setCamera: setCamera,
    modes: MODES,
    depths: DEPTHS,
  };
}

/**
 * The navigation module as the page script receives it. Built from the function
 * source, so the browser and the unit tests cannot drift apart.
 */
export const CALL_FLOW_NAV_SOURCE = `var cfNav = (${callFlowsNav.toString()})();\n`;
