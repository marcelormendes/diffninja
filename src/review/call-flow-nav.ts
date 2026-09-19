/**
 * Navigation state for the Tree, Graph and Sequence call-flow views.
 *
 * This module is the only implementation of focus, visited-trail and depth
 * behaviour. The server renderer prints the mode and depth controls from
 * `CALL_FLOW_MODES` / `CALL_FLOW_DEPTHS`, the page script runs this module's own
 * source text (see `CALL_FLOW_NAV_SOURCE`, built from `callFlowsNav.toString()`)
 * and the unit tests call the module directly, so the tested functions are the
 * ones the browser executes.
 *
 * A visit is identified by the file index plus the occurrence path inside that
 * file (`0-2-1`) — never by a label or a key — so two calls that share a name,
 * or two identical paths in different files, stay distinct trail entries.
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

/** Focus, visited trail, mode and graph depth shared by every view. */
export interface CallFlowNavState {
  readonly trail: ReadonlyArray<CallFlowVisit>;
  readonly mode: FlowMode;
  readonly depth: FlowDepth;
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
  /** The focused visit, or null when the whole file list is shown. */
  current(state: CallFlowNavState): CallFlowVisit | null;
  /**
   * Focus a call, appending it to the trail. Re-focusing the current visit is a
   * no-op; a new focus resets the graph depth, which is always read relative to
   * the focus the reviewer just opened.
   */
  visit(state: CallFlowNavState, file: number, path: string): CallFlowNavState;
  /** Go back to trail entry `index`, dropping the visits after it. */
  truncate(state: CallFlowNavState, index: number): CallFlowNavState;
  /** Drop the whole trail. The mode is a view preference and survives. */
  clear(state: CallFlowNavState): CallFlowNavState;
  setMode(state: CallFlowNavState, mode: string): CallFlowNavState;
  setDepth(state: CallFlowNavState, depth: string | number): CallFlowNavState;
  readonly modes: ReadonlyArray<FlowMode>;
  readonly depths: ReadonlyArray<FlowDepth>;
}

export function callFlowsNav(): CallFlowNav {
  var MODES: FlowMode[] = ['tree', 'graph', 'sequence'];
  var DEPTHS: FlowDepth[] = [1, 2, 3, 'all'];
  var DEFAULT_DEPTH: FlowDepth = 'all';

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

  function createState(): CallFlowNavState {
    return { trail: [], mode: 'tree', depth: DEFAULT_DEPTH };
  }

  function current(state: CallFlowNavState): CallFlowVisit | null {
    return state.trail.length === 0 ? null : state.trail[state.trail.length - 1];
  }

  function visit(state: CallFlowNavState, file: number, path: string): CallFlowNavState {
    var last = current(state);
    if (last !== null && last.file === file && last.path === path) return state;
    var trail = state.trail.slice();
    trail.push({ file: file, path: path });
    return { trail: trail, mode: state.mode, depth: DEFAULT_DEPTH };
  }

  function truncate(state: CallFlowNavState, index: number): CallFlowNavState {
    if (!(index >= 0) || index >= state.trail.length) return state;
    if (index === state.trail.length - 1) return state;
    return { trail: state.trail.slice(0, index + 1), mode: state.mode, depth: DEFAULT_DEPTH };
  }

  function clear(state: CallFlowNavState): CallFlowNavState {
    return { trail: [], mode: state.mode, depth: DEFAULT_DEPTH };
  }

  function setMode(state: CallFlowNavState, mode: string): CallFlowNavState {
    if (mode !== 'tree' && mode !== 'graph' && mode !== 'sequence') return state;
    return { trail: state.trail, mode: mode, depth: state.depth };
  }

  function readDepth(value: string | number): FlowDepth | null {
    for (var i = 0; i < DEPTHS.length; i++) {
      if (String(DEPTHS[i]) === String(value)) return DEPTHS[i];
    }
    return null;
  }

  function setDepth(state: CallFlowNavState, depth: string | number): CallFlowNavState {
    var next = readDepth(depth);
    if (next === null) return state;
    return { trail: state.trail, mode: state.mode, depth: next };
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
    truncate: truncate,
    clear: clear,
    setMode: setMode,
    setDepth: setDepth,
    modes: MODES,
    depths: DEPTHS,
  };
}

/**
 * The navigation module as the page script receives it. Built from the function
 * source, so the browser and the unit tests cannot drift apart.
 */
export const CALL_FLOW_NAV_SOURCE = `var cfNav = (${callFlowsNav.toString()})();\n`;
