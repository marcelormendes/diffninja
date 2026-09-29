import { describe, expect, it } from "vitest";
import { renderConnectedPage } from "../src/review/connected-html.js";

/**
 * A stand-in for the browser nodes the connected page's script builds and reads,
 * so the page's own rail, position and viewed functions run as shipped and the
 * tree they build can be inspected.
 */
interface StubDataset {
  action?: string;
  hunk?: string;
  path?: string;
  line?: string;
  side?: string;
  rank?: string;
}

class StubNode {
  className = "";
  private shown = "";
  title = "";
  type = "";
  hidden = false;
  href = "";
  parent: StubNode | null = null;
  readonly children: StubNode[] = [];
  readonly dataset: StubDataset = {};
  readonly attributes = new Map<string, string>();
  readonly style = { maxHeight: "" };
  readonly rect = { top: 0, bottom: 0 };
  readonly lookups = new Map<string, StubNode>();
  offsetParent: object | null = {};
  scrollTop = 0;

  constructor(readonly tag: string) {}

  /** As in a browser, setting the text replaces every child. */
  get textContent(): string {
    return this.shown;
  }

  set textContent(value: string) {
    this.shown = value;
    this.children.length = 0;
  }

  readonly classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
    add: (name: string) => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
    remove: (name: string) => { this.className = this.className.split(" ").filter((entry) => entry !== name).join(" "); },
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name); },
  };

  appendChild(child: StubNode): StubNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    if (name.startsWith("data-")) {
      // SAFETY: the page reads only the data attributes StubDataset lists.
      const key = name.slice(5) as keyof StubDataset;
      return this.dataset[key] ?? null;
    }
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): { top: number; bottom: number } {
    return this.rect;
  }

  closest(selector: string): StubNode | null {
    if (selector !== "[data-action]") throw new Error(`the stub only answers [data-action], not ${selector}`);
    if (this.dataset.action !== undefined) return this;
    return this.parent?.closest(selector) ?? null;
  }

  private descendants(): StubNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): StubNode[] {
    const match = /^\.([\w-]+)$/.exec(selector);
    if (match === null) throw new Error(`the stub only answers class selectors, not ${selector}`);
    return this.descendants().filter((node) => node.classList.contains(match[1] ?? ""));
  }

  querySelector(selector: string): StubNode | null {
    if (/^\.([\w-]+)$/.test(selector)) return this.querySelectorAll(selector)[0] ?? null;
    return this.lookups.get(selector) ?? null;
  }

}

class StubStorage {
  readonly items = new Map<string, string>();
  writes = 0;
  broken = false;

  getItem(key: string): string | null {
    if (this.broken) throw new Error("storage blocked");
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.broken) throw new Error("storage blocked");
    this.writes += 1;
    this.items.set(key, value);
  }
}

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly payload: { snapshotId: string; path: string; viewed: boolean };
  ok(): void;
  fail(message: string, extra?: { state?: WireState; uncertain?: boolean }): void;
}

interface WireState {
  viewed?: { available: boolean; reason?: string; files?: Array<{ path: string; viewed: boolean }> };
}

interface Hunk {
  id: string;
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  added: number;
  removed: number;
  status: string;
}

interface WireAnalysis {
  available: boolean;
  snapshotId: string;
  scope: { source: string; note: string };
  order: { source: string };
  questions: { total: number; answered: number };
  callFlowFiles: string[];
  hunks: Hunk[];
}

interface WireStop {
  rank: number;
  hunks: Array<{ rank: number }>;
}

interface WirePageState extends WireState {
  snapshot: { id: string; url?: string };
}

type PageValue = WirePageState | WireAnalysis | WireStop[] | string | number | boolean;

interface PageFunctions {
  renderAnalysis(): void;
  setState(state: WirePageState): void;
  markCurrentStation(): void;
  onClick(event: { target: StubNode; preventDefault(): void; defaultPrevented?: boolean }): void;
  onStepKey(event: { key: string; target: StubNode | null; preventDefault(): void; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): void;
  set(name: "state" | "analysis" | "analysisFor" | "stopsNow" | "viewedDirty" | "currentRank", value: PageValue): void;
  /** The hunk ids the page holds as viewed. */
  viewedKeys(): string[];
}

const SNAPSHOT = "snap-1";

function hunk(id: string, file: string, line: number): Hunk {
  return { id, file, line, side: "RIGHT", added: 2, removed: 1, status: "attention" };
}

/** Three hunks in one file, then one hunk in each of two others, in reading order. */
const HUNKS: Hunk[] = [
  hunk("hunk-3", "src/edit.go", 90),
  hunk("hunk-1", "src/listener.ts", 10),
  hunk("hunk-4", "src/edit.go", 170),
  hunk("hunk-2", "docs/notes.md", 3),
  hunk("hunk-5", "src/edit.go", 12),
];
const EDIT = ["hunk-3", "hunk-4", "hunk-5"];

interface Built {
  readonly page: PageFunctions;
  readonly el: Record<"analysisSection" | "analysisBody" | "analysisActions" | "analysisSub" | "diffBody" | "railProgress" | "railAt" | "railViewedCount" | "railSyncNote" | "railViewedError" | "flowDrawer", StubNode>;
  readonly calls: ApiCall[];
  readonly storage: StubStorage;
  readonly jumps: number[];
  readonly window: { innerHeight: number; scrollY: number };
  items(): StubNode[];
  item(id: string): StubNode;
  box(id: string): StubNode;
  click(node: StubNode): { prevented: boolean };
  clickBox(id: string): void;
  /** Answer the oldest request still waiting and let the page's promise chain finish. */
  answer(how: "ok" | { fail: string; state?: WireState; uncertain?: boolean }): Promise<ApiCall>;
  settle(): Promise<void>;
  setState(state: WireState): void;
  viewedIds(): string[];
}

function analysisOf(snapshotId: string, hunks: Hunk[], order: string): WireAnalysis {
  return { available: true, snapshotId, scope: { source: "repository", note: "" }, order: { source: order }, questions: { total: 0, answered: 0 }, callFlowFiles: [], hunks };
}

function slicesOf(page: string): string {
  const cut = (from: string, to: string) => {
    const start = page.indexOf(from);
    const end = page.indexOf(to, start);
    expect(start, from).toBeGreaterThan(0);
    expect(end, to).toBeGreaterThan(start);
    return page.slice(start, end);
  };
  return [
    cut("var stopsNow = [];", "var el = {};"),
    "var state = null; var analysis = null; var analysisFor = ''; var analysisLoading = false; var flowSnapshot = ''; var lastError = ''; var serverError = false;",
    cut("var HIDDEN;", "function make("),
    cut("function make(", "function snapshot("),
    cut("function snapshot(", "function lines("),
    cut("function setState(", "/* -------------------------------------------------------------- storage"),
    cut("function currentAnalysis()", "function fileHasUncertainty("),
    cut("function uncertaintyTag(", "function gotoButton("),
    cut("function renderHunkEntry(", "function stopWhy("),
    cut("function renderAnalysis()", "function gotoLine("),
    cut("var spyQueued = false;", "function queueStationMark()"),
    cut("function viewedStoreKey(", "/* -------------------------------------------------------- you are here"),
    cut("function onClick(", "function onChange("),
    cut("function onStepKey(", "function readView("),
  ].join("\n");
}

/** The connected page's own script for one loaded snapshot, run against stub nodes. */
function build(options: { viewed?: WireState["viewed"]; stored?: string[]; hunks?: Hunk[]; storage?: StubStorage; guided?: boolean } = {}): Built {
  const hunks = options.hunks ?? HUNKS;
  const storage = options.storage ?? new StubStorage();
  if (options.stored !== undefined) storage.items.set(`diffninja.connected.viewed.v1|${SNAPSHOT}`, JSON.stringify(options.stored));
  const names = ["analysisSection", "analysisBody", "analysisActions", "analysisSub", "diffBody", "railProgress", "railAt", "railViewedCount", "railSyncNote", "railViewedError", "flowDrawer"] as const;
  // SAFETY: the entries are exactly the names Built["el"] lists, each a StubNode.
  const el = Object.fromEntries(names.map((name) => [name, new StubNode(name)])) as Built["el"];
  el.analysisSection.hidden = true;
  el.flowDrawer.hidden = true;
  el.railProgress.hidden = true;
  const calls: ApiCall[] = [];
  const jumps: number[] = [];
  const window = { innerHeight: 900, scrollY: 0, getComputedStyle: () => ({ position: "static" }), requestAnimationFrame: () => 0, scrollTo: () => {} };
  const api = (method: string, path: string, payload: ApiCall["payload"]) => new Promise<object>((resolve, reject) => {
    calls.push({
      method, path, payload,
      ok: () => resolve({ path: payload.path, viewed: payload.viewed }),
      fail: (message, extra = {}) => reject(Object.assign(new Error(message), extra)),
    });
  });
  const none = () => {};
  const document = { createElement: (tag: string) => new StubNode(tag), createTextNode: (text: string) => Object.assign(new StubNode("#text"), { textContent: text }) };
  const source = `${slicesOf(renderConnectedPage({ csrf: "c".repeat(64), nonce: "n", base: "/b/" }))}
    return {
      renderAnalysis, markCurrentStation, onClick, onStepKey, setState,
      set(name, value) { if (name === 'state') state = value; else if (name === 'analysis') analysis = value; else if (name === 'analysisFor') analysisFor = value; else if (name === 'stopsNow') stopsNow = value; else if (name === 'viewedDirty') viewedDirty = value; else currentRank = value; },
      viewedKeys() { return Object.keys(viewedHunks); },
    };`;
  // SAFETY: the sliced script defines exactly the functions this return statement lists, with the shapes of PageFunctions.
  const page = new Function("document", "window", "CSS", "el", "storage", "api", "gotoStop", "restoreDraft", "renderGoal", "renderUpdate", "renderHow", "renderAnalysisDetails", "loadAnalysis", "flowButton", "closeFlow", source)(
    document, window, { escape: (value: string) => value }, el, () => storage, api, (rank: number) => { jumps.push(rank); page.set("currentRank", rank); }, none, none, none, none, none, none, none, none,
  ) as PageFunctions;
  const analysis = analysisOf(SNAPSHOT, hunks, "diffninja");
  const built: Built = {
    page, el, calls, storage, jumps, window,
    items: () => el.analysisBody.querySelectorAll(".order-item"),
    item: (id) => {
      const found = built.items().find((node) => node.dataset.hunk === id);
      if (found === undefined) throw new Error(`no rail item for ${id}`);
      return found;
    },
    box: (id) => {
      const found = built.item(id).querySelector(".viewed-box");
      if (found === null) throw new Error(`no checkbox on ${id}`);
      return found;
    },
    click: (node) => {
      let prevented = false;
      page.onClick({ target: node, preventDefault: () => { prevented = true; } });
      return { prevented };
    },
    clickBox: (id) => { built.click(built.box(id)); },
    answer: async (how) => {
      const call = calls.shift();
      if (call === undefined) throw new Error("no request is waiting");
      if (how === "ok") call.ok();
      else call.fail(how.fail, { state: how.state, uncertain: how.uncertain });
      await built.settle();
      return call;
    },
    settle: async () => { for (let turn = 0; turn < 6; turn++) await new Promise<void>((resolve) => { setImmediate(resolve); }); },
    setState: (state) => {
      // The page holds the parsed JSON the server sent and writes into it, so each state is its own copy.
      page.setState(structuredClone({ snapshot: { id: SNAPSHOT, url: "https://github.com/o/r/pull/1" }, ...state }));
      page.renderAnalysis();
    },
    viewedIds: () => built.items().filter((node) => node.classList.contains("is-viewed")).map((node) => node.dataset.hunk ?? ""),
  };
  page.set("analysis", analysis);
  page.set("analysisFor", SNAPSHOT);
  built.setState({ viewed: options.viewed });
  return built;
}

const github = (files: Record<string, boolean>): WireState["viewed"] => ({ available: true, files: Object.entries(files).map(([path, viewed]) => ({ path, viewed })) });
const unmarked = github({ "src/edit.go": false, "src/listener.ts": false, "docs/notes.md": false });

describe("scrolling only says where the reader is", () => {
  /** Four stops down the page, 500 pixels apart, the last one holding the last two changes; returns the scroll. */
  function withStops(built: Built): (y: number) => void {
    const sections = [1, 2, 3, 4].map(() => Object.assign(new StubNode("section"), { className: "stop" }));
    sections.forEach((section, index) => { section.dataset.rank = String(index + 1); built.el.diffBody.appendChild(section); });
    built.page.set("stopsNow", [
      { rank: 1, hunks: [{ rank: 1 }] }, { rank: 2, hunks: [{ rank: 2 }] }, { rank: 3, hunks: [{ rank: 3 }] }, { rank: 4, hunks: [{ rank: 4 }, { rank: 5 }] },
    ]);
    return (y) => {
      built.window.scrollY = y;
      sections.forEach((section, index) => { section.rect.top = index * 500 - y; section.rect.bottom = section.rect.top + 480; });
      built.page.markCurrentStation();
    };
  }

  it("marks no change viewed, however far the page is scrolled, and writes and sends nothing", () => {
    const built = build({ viewed: unmarked });
    const scrollTo = withStops(built);
    const writesBefore = built.storage.writes;
    for (const y of [0, 100, 450, 500, 900, 1400, 1500, 1800, 2400, 3000, 100, 0]) {
      scrollTo(y);
      expect(built.viewedIds(), `scrolled to ${y}`).toEqual([]);
      expect(built.items().some((node) => node.classList.contains("is-seen")), `scrolled to ${y}`).toBe(false);
      expect(built.items().map((node) => built.box(node.dataset.hunk ?? "").attributes.get("aria-checked"))).toEqual(["false", "false", "false", "false", "false"]);
    }
    expect(built.el.railViewedCount.textContent).toBe("0 of 5 viewed");
    expect(built.page.viewedKeys()).toEqual([]);
    expect(built.storage.writes).toBe(writesBefore);
    expect(built.calls).toEqual([]);
  });

  it("still follows the reader: the current change is highlighted and the progress line names it", () => {
    const built = build({ viewed: unmarked });
    const scrollTo = withStops(built);
    const current = () => built.items().filter((node) => node.classList.contains("is-current")).map((node) => node.dataset.rank);
    scrollTo(0);
    expect(current()).toEqual(["1"]);
    expect(built.el.railAt.textContent).toBe("Change 1 of 5");
    scrollTo(1000);
    expect(current()).toEqual(["3"]);
    expect(built.el.railAt.textContent).toBe("Change 3 of 5");
    expect(built.item("hunk-4").attributes.get("aria-current")).toBe("step");
    expect(built.item("hunk-2").attributes.get("aria-current")).toBeUndefined();
    scrollTo(1500);
    expect(current()).toEqual(["4", "5"]);
    expect(built.item("hunk-5").attributes.get("aria-current")).toBe("step");
    expect(built.el.railAt.textContent).toBe("Change 4 of 5");
    expect(built.viewedIds()).toEqual([]);
  });

  it("keeps j and k stepping through the changes from where the reader is", () => {
    const built = build({ viewed: unmarked });
    const scrollTo = withStops(built);
    scrollTo(500);
    const press = (key: string) => built.page.onStepKey({ key, target: null, preventDefault: () => {}, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false });
    press("j");
    press("j");
    press("k");
    expect(built.jumps).toEqual([3, 4, 3]);
    expect(built.viewedIds()).toEqual([]);
  });
});

describe("the checkbox on each rail item", () => {
  it("is a labelled button in the tab order that says whether the change is viewed", () => {
    const built = build({ viewed: unmarked });
    const boxes = built.items().map((node) => node.querySelector(".viewed-box"));
    expect(boxes).toHaveLength(HUNKS.length);
    const box = built.box("hunk-4");
    expect(box.tag).toBe("button");
    expect(box.type).toBe("button");
    expect(box.attributes.get("role")).toBe("checkbox");
    expect(box.attributes.get("aria-checked")).toBe("false");
    expect(box.attributes.get("aria-label")).toBe("Mark change 3 of src/edit.go as viewed");
    expect(box.dataset).toMatchObject({ action: "toggle-viewed", hunk: "hunk-4" });
  });

  it("marks a hidden character in the file name it announces", () => {
    const built = build({ hunks: [hunk("hunk-1", "src/a‮b.ts", 1)], viewed: github({ "src/a‮b.ts": false }) });
    expect(built.box("hunk-1").attributes.get("aria-label")).toBe("Mark change 1 of src/a⟦U+202E⟧b.ts as viewed");
  });

  it("toggles the change without jumping to it, and a click elsewhere on the item still jumps", () => {
    const built = build({ viewed: unmarked });
    const outcome = built.click(built.box("hunk-2"));
    expect(outcome.prevented).toBe(true);
    expect(built.jumps).toEqual([]);
    expect(built.box("hunk-2").attributes.get("aria-checked")).toBe("true");
    expect(built.viewedIds()).toEqual(["hunk-2"]);
    expect(built.el.railViewedCount.textContent).toBe("1 of 5 viewed");
    built.click(built.box("hunk-2"));
    expect(built.box("hunk-2").attributes.get("aria-checked")).toBe("false");
    expect(built.viewedIds()).toEqual([]);
    expect(built.jumps).toEqual([]);
    built.click(built.item("hunk-2"));
    expect(built.jumps).toEqual([4]);
    expect(built.viewedIds()).toEqual([]);
  });

  it("repaints in place, so the checkbox that was clicked stays the same node and keeps focus", () => {
    const built = build({ viewed: unmarked });
    const before = built.box("hunk-2");
    built.click(before);
    expect(built.box("hunk-2")).toBe(before);
    expect(before.parent).toBe(built.item("hunk-2"));
  });
});

describe("a file is viewed on GitHub exactly when every one of its hunks is", () => {
  const request = (path: string, viewed: boolean, snapshotId = SNAPSHOT) => ({ method: "POST", path: "/api/viewed", payload: { snapshotId, path, viewed } });
  const sent = (built: Built) => built.calls.map((call) => ({ method: call.method, path: call.path, payload: call.payload }));

  it("sends nothing for the first two hunks of a three-hunk file and viewed:true for the third", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-3");
    built.clickBox("hunk-4");
    expect(built.calls).toEqual([]);
    built.clickBox("hunk-5");
    expect(sent(built)).toEqual([request("src/edit.go", true)]);
    await built.answer("ok");
    expect(built.viewedIds().sort()).toEqual(EDIT);
  });

  it("sends viewed:true at once for a file with one hunk", () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    expect(sent(built)).toEqual([request("docs/notes.md", true)]);
  });

  it("sends viewed:false when one hunk of a viewed file is un-viewed, and nothing more for the next", async () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": false }) });
    expect(built.viewedIds().sort()).toEqual(EDIT);
    built.clickBox("hunk-4");
    expect(sent(built)).toEqual([request("src/edit.go", false)]);
    await built.answer("ok");
    built.clickBox("hunk-3");
    built.clickBox("hunk-5");
    expect(built.calls).toEqual([]);
    expect(built.viewedIds()).toEqual([]);
  });

  it("sends nothing when un-viewing a hunk of a file that was not viewed on GitHub", () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-3");
    built.clickBox("hunk-3");
    expect(built.calls).toEqual([]);
  });

  it("keeps one request per file in flight and ends in the state of the last click", async () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": false }) });
    built.clickBox("hunk-4");
    built.clickBox("hunk-4");
    built.clickBox("hunk-4");
    built.clickBox("hunk-4");
    expect(sent(built)).toEqual([request("src/edit.go", false)]);
    await built.answer("ok");
    // The last click put the hunk back, so the file is viewed again and GitHub is told.
    expect(sent(built)).toEqual([request("src/edit.go", true)]);
    await built.answer("ok");
    expect(built.calls).toEqual([]);
    expect(built.viewedIds().sort()).toEqual(EDIT);
  });

  it("sends nothing more when the clicks in flight leave the file as GitHub already has it", async () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": false }) });
    built.clickBox("hunk-4");
    built.clickBox("hunk-5");
    expect(sent(built)).toEqual([request("src/edit.go", false)]);
    await built.answer("ok");
    expect(built.calls).toEqual([]);
  });

  it("does not let one file wait for another", () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    built.clickBox("hunk-1");
    expect(sent(built)).toEqual([request("docs/notes.md", true), request("src/listener.ts", true)]);
  });

  it("keeps a click whose request is out when the page reads GitHub's state again in the meantime", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    expect(sent(built)).toEqual([request("docs/notes.md", true)]);
    // A load that started before the click answers now: GitHub's copy says the file is not viewed yet.
    built.setState({ viewed: unmarked });
    expect(built.viewedIds()).toEqual(["hunk-2"]);
    await built.answer("ok");
    expect(built.viewedIds()).toEqual(["hunk-2"]);
    expect(built.calls).toEqual([]);
  });

  it("does not undo a confirmed mark when a later failure elsewhere makes the page read GitHub's state again", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    await built.answer("ok");
    built.clickBox("hunk-1");
    await built.answer({ fail: "GitHub refused the Viewed mark: no." });
    expect(built.viewedIds()).toEqual(["hunk-2"]);
  });
});

describe("a request that fails puts the click back", () => {
  it("un-marks the hunk that completed the file, says why next to the rail, and lets the next click try again", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-3");
    built.clickBox("hunk-4");
    built.clickBox("hunk-5");
    expect(built.viewedIds().sort()).toEqual(EDIT);
    await built.answer({ fail: "The gh account is not authorized for that repository." });
    expect(built.viewedIds().sort()).toEqual(["hunk-3", "hunk-4"]);
    expect(built.box("hunk-5").attributes.get("aria-checked")).toBe("false");
    expect(built.el.railViewedError.hidden).toBe(false);
    expect(built.el.railViewedError.textContent).toBe("The gh account is not authorized for that repository.");
    expect(built.el.railViewedCount.textContent).toBe("2 of 5 viewed");
    expect(built.calls).toEqual([]);
    built.clickBox("hunk-5");
    expect(built.calls).toHaveLength(1);
    expect(built.el.railViewedError.hidden).toBe(true);
  });

  it("puts back the hunk whose click sent the request, not one clicked while it was out", async () => {
    const built = build({ viewed: unmarked, stored: ["hunk-3", "hunk-4"] });
    built.clickBox("hunk-5");
    expect(built.calls).toHaveLength(1);
    // While that request is out the reader un-views another hunk of the file.
    built.clickBox("hunk-3");
    await built.answer({ fail: "GitHub rejected the Viewed mark." });
    expect(built.viewedIds()).toEqual(["hunk-4"]);
  });

  it("puts a hunk back to viewed when un-viewing it failed", async () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": false }) });
    built.clickBox("hunk-4");
    expect(built.viewedIds().sort()).toEqual(["hunk-3", "hunk-5"]);
    await built.answer({ fail: "GitHub rejected the Viewed mark." });
    expect(built.viewedIds().sort()).toEqual(EDIT);
    expect(built.el.railViewedError.textContent).toBe("GitHub rejected the Viewed mark.");
  });

  it("marks hidden characters in the message it shows", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    await built.answer({ fail: "GitHub said‮ no​." });
    expect(built.el.railViewedError.textContent).toBe("GitHub said⟦U+202E⟧ no⟦U+200B⟧.");
  });

  it("stops mirroring, and says so, when the server can no longer trust GitHub's marks", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    await built.answer({
      fail: "The Viewed mark did not finish, so GitHub may or may not have recorded it. Load the pull request again to read GitHub's marks.",
      state: { viewed: { available: false, reason: "the last Viewed mark did not finish" } },
    });
    expect(built.el.railSyncNote.hidden).toBe(false);
    expect(built.el.railSyncNote.textContent).toBe("not synced with GitHub: the last Viewed mark did not finish");
    built.clickBox("hunk-1");
    expect(built.calls).toEqual([]);
    expect(built.viewedIds()).toEqual(["hunk-1"]);
  });

  it("stops mirroring when the local server gave no answer at all", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    await built.answer({ fail: "Could not reach the local diffninja server. Check that diffninja is still running.", uncertain: true });
    expect(built.el.railSyncNote.textContent).toBe("not synced with GitHub: diffninja did not answer the last Viewed mark");
    built.clickBox("hunk-1");
    expect(built.calls).toEqual([]);
  });

  /** The reader's page moves to another revision of the pull request while a request is out. */
  function moveOn(built: Built, viewed: WireState["viewed"]): void {
    built.page.set("state", structuredClone({ snapshot: { id: "snap-2" }, viewed }));
    built.page.set("analysis", analysisOf("snap-2", HUNKS, "diffninja"));
    built.page.set("analysisFor", "snap-2");
    built.page.set("viewedDirty", true);
    built.page.renderAnalysis();
  }

  it("does not put a click back on the new revision when the old revision's request fails late", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    const late = built.calls[0];
    // In the new revision GitHub already has that file viewed, so the same hunk id is viewed there.
    moveOn(built, github({ "src/edit.go": false, "src/listener.ts": false, "docs/notes.md": true }));
    expect(built.viewedIds()).toEqual(["hunk-2"]);
    late?.fail("GitHub rejected the Viewed mark.");
    await built.settle();
    built.page.renderAnalysis();
    expect(built.viewedIds()).toEqual(["hunk-2"]);
    expect(built.el.railViewedError.hidden).toBe(true);
  });

  it("does not tell the new revision that GitHub confirmed a mark it never got", async () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-2");
    const late = built.calls[0];
    moveOn(built, unmarked);
    late?.ok();
    await built.settle();
    built.page.set("viewedDirty", true);
    built.page.renderAnalysis();
    expect(built.viewedIds()).toEqual([]);
    expect(built.calls).toHaveLength(1);
  });
});

describe("where the page starts from", () => {
  it("shows every hunk of a file GitHub calls viewed as viewed, and no other", () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": true }) });
    expect(built.viewedIds().sort()).toEqual(["hunk-2", ...EDIT]);
    expect(built.el.railViewedCount.textContent).toBe("4 of 5 viewed");
    expect(built.box("hunk-3").attributes.get("aria-checked")).toBe("true");
    expect(built.box("hunk-1").attributes.get("aria-checked")).toBe("false");
    expect(built.calls).toEqual([]);
  });

  it("lets GitHub win when this tab remembers a whole file viewed that GitHub does not", () => {
    const built = build({ viewed: unmarked, stored: [...EDIT, "hunk-1"] });
    // hunk-1 is its file's only hunk and GitHub says the file is not viewed; the edit.go hunks are all of theirs.
    expect(built.viewedIds()).toEqual([]);
    expect(built.calls).toEqual([]);
  });

  it("keeps this tab's progress inside a file GitHub does not call viewed", () => {
    const built = build({ viewed: unmarked, stored: ["hunk-3", "hunk-4"] });
    expect(built.viewedIds().sort()).toEqual(["hunk-3", "hunk-4"]);
    expect(built.calls).toEqual([]);
    built.clickBox("hunk-5");
    expect(built.calls).toHaveLength(1);
  });

  it("forgets remembered hunks that are not in this revision", () => {
    const built = build({ viewed: unmarked, stored: ["hunk-3", "hunk-99"] });
    expect(built.viewedIds()).toEqual(["hunk-3"]);
    expect(built.page.viewedKeys()).toEqual(["hunk-3"]);
  });

  it("re-reads GitHub when the pull request is loaded again", () => {
    const built = build({ viewed: unmarked });
    built.clickBox("hunk-3");
    expect(built.viewedIds()).toEqual(["hunk-3"]);
    built.setState({ viewed: github({ "src/edit.go": true, "src/listener.ts": true, "docs/notes.md": false }) });
    expect(built.viewedIds().sort()).toEqual(["hunk-1", ...EDIT]);
    built.setState({ viewed: github({ "src/edit.go": false, "src/listener.ts": true, "docs/notes.md": false }) });
    expect(built.viewedIds().sort()).toEqual(["hunk-1"]);
  });

  it("keeps a file's marks when the agent's order arrives and the ranks change", () => {
    const built = build({ viewed: github({ "src/edit.go": true, "src/listener.ts": false, "docs/notes.md": true }) });
    built.page.set("analysis", analysisOf(SNAPSHOT, [...HUNKS].reverse(), "agent"));
    built.page.renderAnalysis();
    expect(built.viewedIds().sort()).toEqual(["hunk-2", ...EDIT]);
    expect(built.item("hunk-2").dataset.rank).toBe("2");
    expect(built.box("hunk-2").attributes.get("aria-label")).toBe("Mark change 2 of docs/notes.md as viewed");
  });
});

describe("when GitHub's marks are not available", () => {
  it("says the marks are not synced and why, and keeps them in this tab only", () => {
    const built = build({ viewed: { available: false, reason: "gh did not answer in time" } });
    expect(built.el.railSyncNote.hidden).toBe(false);
    expect(built.el.railSyncNote.textContent).toBe("not synced with GitHub: gh did not answer in time");
    built.clickBox("hunk-3");
    built.clickBox("hunk-4");
    built.clickBox("hunk-5");
    built.clickBox("hunk-2");
    expect(built.calls).toEqual([]);
    expect(built.viewedIds().sort()).toEqual(["hunk-2", ...EDIT]);
    expect(built.box("hunk-2").title).toBe("Kept in this tab only");
  });

  it("keeps those marks across a reload of the page in the same tab, and shows none in another", () => {
    const first = build({ viewed: { available: false, reason: "gh did not answer in time" } });
    first.clickBox("hunk-1");
    first.clickBox("hunk-3");
    expect(JSON.parse(first.storage.items.get(`diffninja.connected.viewed.v1|${SNAPSHOT}`) ?? "[]").sort()).toEqual(["hunk-1", "hunk-3"]);
    const reloaded = build({ viewed: { available: false, reason: "gh did not answer in time" }, storage: first.storage });
    expect(reloaded.viewedIds().sort()).toEqual(["hunk-1", "hunk-3"]);
    expect(build({ viewed: { available: false, reason: "x" } }).viewedIds()).toEqual([]);
  });

  it("marks a hidden character in the reason", () => {
    const built = build({ viewed: { available: false, reason: "gh‮ said no" } });
    expect(built.el.railSyncNote.textContent).toBe("not synced with GitHub: gh⟦U+202E⟧ said no");
  });

  it("still gives a reason when the server offered none", () => {
    const built = build({ viewed: undefined });
    expect(built.el.railSyncNote.textContent).toBe("not synced with GitHub: GitHub did not offer viewed marks");
  });

  it("says nothing when the marks are synced", () => {
    const built = build({ viewed: unmarked });
    expect(built.el.railSyncNote.hidden).toBe(true);
    expect(built.el.railSyncNote.textContent).toBe("");
  });

  it("keeps working when the browser blocks storage", () => {
    const storage = new StubStorage();
    storage.broken = true;
    const built = build({ viewed: { available: false, reason: "x" }, storage });
    built.clickBox("hunk-3");
    expect(built.viewedIds()).toEqual(["hunk-3"]);
  });
});

describe("a file GitHub lists but the page cannot match", () => {
  it("keeps the mark in this tab and sends nothing", () => {
    const built = build({ viewed: github({ "src/listener.ts": false, "docs/notes.md": false }) });
    built.clickBox("hunk-3");
    built.clickBox("hunk-4");
    built.clickBox("hunk-5");
    expect(built.calls).toEqual([]);
    expect(built.box("hunk-3").title).toBe("Kept in this tab only");
    expect(built.box("hunk-1").title).toBe("Marks the file viewed on GitHub once every change in it is viewed");
  });
});

describe("the page's markup and styles", () => {
  const page = renderConnectedPage({ csrf: "c".repeat(64), nonce: "n", base: "/b/" });

  it("has the progress count and both notes beside the rail, and no scroll-driven seen state", () => {
    expect(page).toContain('id="rail-viewed-count"');
    expect(page).toContain('id="rail-sync-note"');
    expect(page).toContain('id="rail-viewed-error" class="rail-note is-error" role="alert"');
    expect(page).not.toContain("is-seen");
    expect(page).not.toContain("seenRanks");
  });

  it("styles a viewed item with the accent the seen state had, and a target of at least 24 pixels", () => {
    expect(page).toContain(".order-item.is-viewed::before { background: var(--accent); opacity: 0.55; }");
    expect(page).toContain(".order-item.is-viewed .order-rank { color: var(--accent); border-color: var(--accent); }");
    expect(page).toMatch(/\.viewed-box \{[^}]*width: 24px; height: 24px;/);
  });
});
