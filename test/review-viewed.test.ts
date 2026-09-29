import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveConnected, type ConnectedSession } from "../src/review/connected.js";
import {
  ConnectedReview,
  GhCommandError,
  MARK_VIEWED_MUTATION,
  UNMARK_VIEWED_MUTATION,
  VIEWED_FILES_QUERY,
  type ConnectedState,
  type GhInvocation,
  type GhResult,
  type GhRunner,
  type ViewedState,
} from "../src/review/github.js";

const PR_URL = "https://github.com/octocat/hello/pull/7";
const NODE_ID = "PR_kwDO7";
const PATCH = "@@ -1,2 +1,2 @@\n keep()\n-old()\n+new()";
const ODD_PATH = "odd } $path \"quoted\" { mutation { evil } } \\ name.ts";
const AT_PATH = "@notes.txt";

/** Files the fixture pull request renames, new path to old path. */
const RENAMED = new Map([["src/renamed.ts", "src/old.ts"]]);

/** Every path the fixture pull request changes, in the order GitHub lists them. */
const FILES = ["app.ts", "lib/util.ts", "docs/readme.md", "src/renamed.ts", ODD_PATH, AT_PATH];

interface PausedWrite {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/**
 * A scripted `gh` that also speaks GraphQL. It holds the fake GitHub's Viewed
 * marks per path, logs every argv, and can fail, answer oddly or hold a write
 * open, so the real server and the real session run against it unchanged.
 */
class ViewedGh implements GhRunner {
  readonly calls: string[][] = [];
  marks = new Map<string, string>(FILES.map((path) => [path, "UNVIEWED"]));
  files = [...FILES];
  pageSize = 100;
  nodeId: string | null = NODE_ID;
  state = "OPEN";
  head = "2".repeat(40);
  base = "1".repeat(40);
  /** Paths GitHub's Viewed read leaves out of its answer. */
  readonly omitted = new Set<string>();
  /** Failure of the `pr view` that re-reads the head before a mark. */
  headReadFailure: GhCommandError | null = null;
  private metadataReads = 0;
  readFailure: GhCommandError | null = null;
  writeFailure: GhCommandError | null = null;
  readReply: string | null = null;
  writeReply: string | null = null;
  inFlight = 0;
  maxInFlight = 0;
  /** The deadline each gh call was given. */
  readonly deadlines: number[] = [];
  private pause: { reached: () => void; released: Promise<void> } | null = null;

  /** Hold the next mutation open until `release` is called; `reached` settles when it arrives. */
  pauseNextWrite(): PausedWrite {
    let release = () => {};
    let reached = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    this.pause = { reached, released };
    return { reached: arrived, release };
  }

  graphqlCalls(): string[][] {
    return this.calls.filter((args) => args[3] === "graphql");
  }

  async run(invocation: GhInvocation): Promise<GhResult> {
    const args = [...invocation.args];
    this.calls.push(args);
    this.deadlines.push(invocation.timeoutMs);
    if (args[0] === "--version") return out("gh version 2.101.0 (2026-01-01)\n");
    if (args[0] === "pr") {
      this.metadataReads += 1;
      // The two reads of a load come first; any later read is the one before a mark.
      if (this.metadataReads > 2 && this.headReadFailure !== null) throw this.headReadFailure;
      return out(this.metadata());
    }
    if (args[3] === "graphql") return this.graphql(args);
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint === "user") return out(JSON.stringify({ login: "octocat", id: 42 }));
    if (endpoint.endsWith("/files?per_page=100")) {
      return out(JSON.stringify(this.files.map((filename) => ({ filename, previous_filename: RENAMED.get(filename) ?? null, status: "modified", additions: 1, deletions: 1, patch: PATCH }))));
    }
    return out(this.files.map((path) => {
      const before = RENAMED.get(path) ?? path;
      const moved = before === path ? "" : `similarity index 90%\nrename from ${before}\nrename to ${path}\n`;
      return `diff --git a/${before} b/${path}\n${moved}index 1111111..2222222 100644\n--- a/${before}\n+++ b/${path}\n${PATCH}\n`;
    }).join(""));
  }

  private async graphql(args: string[]): Promise<GhResult> {
    const query = valueOf(args, "query");
    if (query === VIEWED_FILES_QUERY) return this.read(args);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.pause !== null) {
        const { reached, released } = this.pause;
        this.pause = null;
        reached();
        await released;
      }
      if (this.writeFailure !== null) throw this.writeFailure;
      const path = valueOf(args, "path") ?? "";
      const viewed = query === MARK_VIEWED_MUTATION;
      if (query === MARK_VIEWED_MUTATION || query === UNMARK_VIEWED_MUTATION) this.marks.set(path, viewed ? "VIEWED" : "UNVIEWED");
      const field = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      return out(this.writeReply ?? JSON.stringify({ data: { [field]: { clientMutationId: null } } }));
    } finally {
      this.inFlight -= 1;
    }
  }

  private read(args: string[]): GhResult {
    if (this.readFailure !== null) throw this.readFailure;
    if (this.readReply !== null) return out(this.readReply);
    const start = Number((valueOf(args, "after") ?? "c0").slice(1));
    const page = this.files.filter((path) => !this.omitted.has(path)).slice(start, start + this.pageSize);
    const end = start + page.length;
    const total = this.files.filter((path) => !this.omitted.has(path)).length;
    const nodes = page.map((path) => ({ path, viewerViewedState: this.marks.get(path) ?? "UNVIEWED" }));
    return out(JSON.stringify({ data: { node: { files: { nodes, pageInfo: { hasNextPage: end < total, endCursor: `c${end}` } } } } }));
  }

  private metadata(): string {
    const metadata = {
      url: PR_URL, number: 7, state: this.state, title: "Title", body: "Body",
      baseRefOid: this.base, headRefOid: this.head, isCrossRepository: false,
      headRepository: { id: "R_1", name: "hello", nameWithOwner: "octocat/hello" }, headRepositoryOwner: { id: "O_1", login: "octocat" },
      baseRefName: "main", headRefName: "feature",
    };
    return JSON.stringify(this.nodeId === null ? metadata : { ...metadata, id: this.nodeId });
  }
}

function out(stdout: string): GhResult {
  return { stdout, stderr: "" };
}

/** The value of one `-f name=value` argument. */
function valueOf(args: readonly string[], name: string): string | undefined {
  const entry = args.find((arg, index) => args[index - 1] === "-f" && arg.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
}

function failure(message: string, stdout = "", stderr = message): GhCommandError {
  return new GhCommandError(message, stdout, stderr);
}

const sessions: ConnectedSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(({ server }) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});

/** A body sent to the page's routes, well formed or not: every field is optional and loosely typed on purpose. */
interface Sent {
  snapshotId?: string;
  path?: string;
  viewed?: boolean | string | number | null;
  url?: string;
  pullRequestId?: string;
  query?: string;
  command?: string;
  args?: string[];
}

interface Answer {
  readonly status: number;
  readonly json: { error?: string; state?: ConnectedState; path?: string; viewed?: boolean };
}

interface Api {
  readonly gh: ViewedGh;
  readonly url: string;
  readonly headers: Record<string, string>;
  state(): Promise<ConnectedState>;
  /** POST `body` (already serialized, so a test may send text that is not JSON) and read the JSON answer. */
  post(route: string, body: string, headers?: Record<string, string>): Promise<Answer>;
  postJson(route: string, body: Sent | readonly number[], headers?: Record<string, string>): Promise<Answer>;
  snapshotId(): Promise<string>;
}

/** A real loopback session over the real review, loaded once, with the CSRF token read from its page. */
async function open(prepare: (gh: ViewedGh) => void = () => {}): Promise<Api> {
  const gh = new ViewedGh();
  prepare(gh);
  const session = await serveConnected(new ConnectedReview({ runner: gh, timeoutMs: 5_000 }));
  sessions.push(session);
  const csrf = /var CSRF = "([a-f0-9]{64})"/.exec(await (await fetch(session.url)).text())?.[1] ?? "";
  const headers = { Origin: new URL(session.url).origin, "Content-Type": "application/json", "X-Diffninja-CSRF": csrf };
  const api: Api = {
    gh,
    url: session.url,
    headers,
    // SAFETY: this loopback server answers every request with the JSON its own page reads.
    state: async () => (await (await fetch(session.url + "api/state")).json()) as ConnectedState,
    post: async (route, body, extra = {}) => {
      const response = await fetch(session.url + route, { method: "POST", headers: { ...headers, ...extra }, body });
      // SAFETY: as above; the error and receipt fields are the ones this test reads.
      return { status: response.status, json: (await response.json()) as Answer["json"] };
    },
    postJson: (route, body, extra) => api.post(route, JSON.stringify(body), extra),
    snapshotId: async () => (await api.state()).snapshot?.id ?? "",
  };
  const loaded = await api.postJson("api/load", { url: PR_URL });
  expect(loaded.status).toBe(200);
  return api;
}

function mutationCalls(gh: ViewedGh): string[][] {
  return gh.graphqlCalls().filter((args) => valueOf(args, "query") !== VIEWED_FILES_QUERY);
}

const argvOf = (query: string, ...variables: string[]) => ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`, ...variables.flatMap((variable) => ["-f", variable])];

describe("reading the Viewed marks when a pull request loads", () => {
  it("reads every changed file's mark, VIEWED counting as viewed and UNVIEWED and DISMISSED not", async () => {
    const api = await open((gh) => {
      gh.marks.set("app.ts", "VIEWED");
      gh.marks.set("lib/util.ts", "DISMISSED");
      gh.marks.set("docs/readme.md", "UNVIEWED");
      gh.marks.set("src/renamed.ts", "VIEWED");
    });
    const state = await api.state();
    expect(state.status).toBe("ready");
    expect(state.viewed).toEqual({
      available: true,
      files: [
        { path: "app.ts", viewed: true }, { path: "lib/util.ts", viewed: false }, { path: "docs/readme.md", viewed: false },
        { path: "src/renamed.ts", viewed: true }, { path: ODD_PATH, viewed: false }, { path: AT_PATH, viewed: false },
      ],
    });
  });

  it("counts a changed file that GitHub's answer leaves out as not viewed", async () => {
    const api = await open((gh) => {
      gh.marks.set("app.ts", "VIEWED");
      gh.marks.set("lib/util.ts", "VIEWED");
      gh.omitted.add("lib/util.ts");
    });
    const viewed = (await api.state()).viewed;
    expect(viewed?.available === true && viewed.files.find((file) => file.path === "lib/util.ts")).toEqual({ path: "lib/util.ts", viewed: false });
    expect(viewed?.available === true && viewed.files.find((file) => file.path === "app.ts")).toEqual({ path: "app.ts", viewed: true });
  });

  it("asks with the fixed query and the pull request's node id as a variable", async () => {
    const api = await open();
    expect(api.gh.graphqlCalls()).toEqual([argvOf(VIEWED_FILES_QUERY, `pullRequestId=${NODE_ID}`)]);
  });

  it("follows the cursor through every page and reads the marks on the last one", async () => {
    const api = await open((gh) => {
      gh.pageSize = 2;
      gh.marks.set(AT_PATH, "VIEWED");
    });
    expect(api.gh.graphqlCalls()).toEqual([
      argvOf(VIEWED_FILES_QUERY, `pullRequestId=${NODE_ID}`),
      argvOf(VIEWED_FILES_QUERY, `pullRequestId=${NODE_ID}`, "after=c2"),
      argvOf(VIEWED_FILES_QUERY, `pullRequestId=${NODE_ID}`, "after=c4"),
    ]);
    const viewed = (await api.state()).viewed;
    expect(viewed?.available === true && viewed.files.find((file) => file.path === AT_PATH)?.viewed).toBe(true);
    expect(viewed?.available === true && viewed.files.length).toBe(FILES.length);
  });

  it("reads again on a refresh, so a mark set on GitHub since shows up", async () => {
    const api = await open();
    api.gh.marks.set("app.ts", "VIEWED");
    expect((await api.postJson("api/load", { url: PR_URL })).status).toBe(200);
    const viewed = (await api.state()).viewed;
    expect(viewed?.available === true && viewed.files.find((file) => file.path === "app.ts")?.viewed).toBe(true);
  });

  it("does not read them for a pull request that cannot be reviewed", async () => {
    const api = await open((gh) => { gh.state = "CLOSED"; });
    const state = await api.state();
    expect(state.status).toBe("empty");
    expect(state.viewed).toBeUndefined();
    expect(api.gh.graphqlCalls()).toEqual([]);
    const refused = await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
    expect(refused.status).toBe(400);
    expect(mutationCalls(api.gh)).toEqual([]);
  });

  describe("when GitHub does not give them", () => {
    const unavailable = async (prepare: (gh: ViewedGh) => void): Promise<{ api: Api; viewed: ViewedState | undefined }> => {
      const api = await open(prepare);
      const state = await api.state();
      expect(state.status).toBe("ready");
      expect(state.snapshot?.lines.length).toBeGreaterThan(0);
      return { api, viewed: state.viewed };
    };

    it("still loads the review and says why with a short fixed reason, never GitHub's words", async () => {
      const secret = "ghp_SECRETTOKEN0123456789";
      const { viewed } = await unavailable((gh) => {
        gh.readFailure = failure("gh: HTTP 502 Bad Gateway", JSON.stringify({ message: `<html>${secret}</html>` }), `gh: HTTP 502 Bad Gateway\nAuthorization: token ${secret}`);
      });
      expect(viewed).toEqual({ available: false, reason: "GitHub returned a server error" });
      expect(JSON.stringify(viewed)).not.toContain(secret);
    });

    it("names a permission problem without repeating the message GitHub sent", async () => {
      const { viewed } = await unavailable((gh) => {
        gh.readFailure = failure("gh: Resource not accessible by personal access token (HTTP 403)", JSON.stringify({ message: "Resource not accessible by personal access token" }));
      });
      expect(viewed).toEqual({ available: false, reason: "the gh account may not read viewed marks" });
    });

    it("names a timeout", async () => {
      const { viewed } = await unavailable((gh) => { gh.readFailure = failure("gh timed out"); });
      expect(viewed).toEqual({ available: false, reason: "gh did not answer in time" });
    });

    it("says so when the answer is not the shape it needs", async () => {
      for (const reply of ["not json", "{}", JSON.stringify({ data: { node: null } }), JSON.stringify({ data: { node: { files: { nodes: [{ path: "app.ts" }], pageInfo: { hasNextPage: false } } } } })]) {
        const { viewed } = await unavailable((gh) => { gh.readReply = reply; });
        expect(viewed).toEqual({ available: false, reason: "GitHub's answer about viewed files was not readable" });
      }
    });

    it("says so when gh reports no node id for the pull request, and asks nothing", async () => {
      const { api, viewed } = await unavailable((gh) => { gh.nodeId = null; });
      expect(viewed).toEqual({ available: false, reason: "gh did not report the pull request's GitHub id" });
      expect(api.gh.graphqlCalls()).toEqual([]);
    });

    it("refuses a mark before any gh call, since the page is not synced", async () => {
      const { api } = await unavailable((gh) => { gh.readFailure = failure("gh timed out"); });
      const before = api.gh.calls.length;
      const refused = await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
      expect(refused.status).toBe(400);
      expect(refused.json.error).toContain("not synced with GitHub");
      expect(api.gh.calls.length).toBe(before);
    });
  });
});

describe("marking a file Viewed on GitHub", () => {
  it("sends exactly one mutation, the fixed text with the path and the node id as variables", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    const mark = await api.postJson("api/viewed", { snapshotId, path: "lib/util.ts", viewed: true });
    expect(mark).toMatchObject({ status: 200, json: { path: "lib/util.ts", viewed: true } });
    expect(mutationCalls(api.gh)).toEqual([argvOf(MARK_VIEWED_MUTATION, `pullRequestId=${NODE_ID}`, "path=lib/util.ts")]);
    expect(api.gh.marks.get("lib/util.ts")).toBe("VIEWED");

    const unmark = await api.postJson("api/viewed", { snapshotId, path: "lib/util.ts", viewed: false });
    expect(unmark).toMatchObject({ status: 200, json: { path: "lib/util.ts", viewed: false } });
    expect(mutationCalls(api.gh)).toEqual([
      argvOf(MARK_VIEWED_MUTATION, `pullRequestId=${NODE_ID}`, "path=lib/util.ts"),
      argvOf(UNMARK_VIEWED_MUTATION, `pullRequestId=${NODE_ID}`, "path=lib/util.ts"),
    ]);
    expect(api.gh.marks.get("lib/util.ts")).toBe("UNVIEWED");
  });

  it("gives every GraphQL call the same deadline as every other gh call", async () => {
    const api = await open();
    await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
    const graphqlDeadlines = api.gh.calls.flatMap((args, index) => (args[3] === "graphql" ? [api.gh.deadlines[index]] : []));
    expect(graphqlDeadlines).toEqual([5_000, 5_000]);
  });

  it("uses exactly the two documented mutation documents", () => {
    expect(MARK_VIEWED_MUTATION).toBe("mutation($pullRequestId: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId } }");
    expect(UNMARK_VIEWED_MUTATION).toBe("mutation($pullRequestId: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId } }");
  });

  it("keeps what GitHub confirmed, so the next state read shows it", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    await api.postJson("api/viewed", { snapshotId, path: "docs/readme.md", viewed: true });
    const viewed = (await api.state()).viewed;
    expect(viewed?.available === true && viewed.files.find((file) => file.path === "docs/readme.md")?.viewed).toBe(true);
    expect(viewed?.available === true && viewed.files.filter((file) => file.viewed).length).toBe(1);
  });

  it("marks the new path of a renamed file and refuses its old path", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    expect((await api.postJson("api/viewed", { snapshotId, path: "src/old.ts", viewed: true })).status).toBe(400);
    expect(mutationCalls(api.gh)).toEqual([]);
    const mark = await api.postJson("api/viewed", { snapshotId, path: "src/renamed.ts", viewed: true });
    expect(mark.status).toBe(200);
    expect(api.gh.marks.get("src/renamed.ts")).toBe("VIEWED");
  });

  it("never lets a path reach the query text, whatever the path says", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    for (const path of [ODD_PATH, AT_PATH]) {
      expect((await api.postJson("api/viewed", { snapshotId, path, viewed: true })).status).toBe(200);
    }
    const sent = mutationCalls(api.gh);
    expect(sent).toHaveLength(2);
    for (const [index, path] of [ODD_PATH, AT_PATH].entries()) {
      const args = sent[index] ?? [];
      expect(args).toEqual(argvOf(MARK_VIEWED_MUTATION, `pullRequestId=${NODE_ID}`, `path=${path}`));
      // Raw `-f`, never `-F`: gh reads a file for an `-F` value that starts with @.
      expect(args[args.indexOf(`path=${path}`) - 1]).toBe("-f");
      expect(args.filter((arg) => arg.includes("evil") || arg.includes(path)).length).toBe(1);
    }
  });
});

describe("a mark after the pull request moved", () => {
  const moved = "The pull request changed since it was loaded. Load it again, then mark the file.";

  it("reads the head again first and sends the mutation only when it is the one that was loaded", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    const before = api.gh.calls.length;
    expect((await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true })).status).toBe(200);
    const issued = api.gh.calls.slice(before);
    expect(issued.map((args) => (args[0] === "pr" ? "pr" : args[3]))).toEqual(["pr", "graphql"]);
    expect(issued[0]?.slice(0, 3)).toEqual(["pr", "view", PR_URL]);
  });

  it.each([
    ["a push to the head", (gh: ViewedGh) => { gh.head = "3".repeat(40); }],
    ["a change of the base", (gh: ViewedGh) => { gh.base = "4".repeat(40); }],
  ])("refuses the mark after %s, and sends no mutation", async (_name, move) => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    move(api.gh);
    const refused = await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe(moved);
    expect(mutationCalls(api.gh)).toEqual([]);
    expect(api.gh.marks.get("app.ts")).toBe("UNVIEWED");
    // Loading it again binds the new head, and a mark then goes through.
    expect((await api.postJson("api/load", { url: PR_URL })).status).toBe(200);
    expect((await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true })).status).toBe(200);
    expect(api.gh.marks.get("app.ts")).toBe("VIEWED");
  });

  it("sends no mutation when the head cannot be read, and shows a safe message", async () => {
    const api = await open();
    api.gh.headReadFailure = failure("gh: HTTP 403", JSON.stringify({ message: "Resource not accessible" }), "gh: HTTP 403\nAuthorization: token ghp_SECRETTOKEN0123456789");
    const refused = await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json)).not.toContain("ghp_SECRETTOKEN0123456789");
    expect(mutationCalls(api.gh)).toEqual([]);
  });
});

describe("what the mark route refuses before any gh call", () => {
  const good = async (api: Api) => ({ snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });

  it.each([
    ["a stale snapshot", async (api: Api) => ({ ...(await good(api)), snapshotId: "0".repeat(64) })],
    ["a path that is not a changed file", async (api: Api) => ({ ...(await good(api)), path: "not/in/the/pull-request.ts" })],
    ["an empty path", async (api: Api) => ({ ...(await good(api)), path: "" })],
    ["a path with a different case", async (api: Api) => ({ ...(await good(api)), path: "APP.ts" })],
    ["a path with a leading dot segment", async (api: Api) => ({ ...(await good(api)), path: "./app.ts" })],
    ["viewed as a string", async (api: Api) => ({ ...(await good(api)), viewed: "true" })],
    ["viewed as a number", async (api: Api) => ({ ...(await good(api)), viewed: 1 })],
    ["viewed as null", async (api: Api) => ({ ...(await good(api)), viewed: null })],
    ["no viewed", async (api: Api) => ({ snapshotId: (await good(api)).snapshotId, path: "app.ts" })],
    ["no path", async (api: Api) => ({ snapshotId: (await good(api)).snapshotId, viewed: true })],
    ["no snapshot id", async () => ({ path: "app.ts", viewed: true })],
    ["a pull request node id of the caller's choosing", async (api: Api) => ({ ...(await good(api)), pullRequestId: "PR_other" })],
    ["a query of the caller's choosing", async (api: Api) => ({ ...(await good(api)), query: "mutation { deleteRepository }" })],
    ["a command", async (api: Api) => ({ ...(await good(api)), command: "whoami" })],
    ["an array", async () => [1, 2]],
  ])("refuses %s", async (_name, body) => {
    const api = await open();
    const before = api.gh.calls.length;
    const response = await api.postJson("api/viewed", await body(api));
    expect(response.status).toBe(400);
    expect(api.gh.calls.length).toBe(before);
  });

  it("refuses text that is not JSON", async () => {
    const api = await open();
    const before = api.gh.calls.length;
    expect((await api.post("api/viewed", "{")).status).toBe(400);
    expect(api.gh.calls.length).toBe(before);
  });

  it("refuses a body over the size limit and one that is not JSON content", async () => {
    const api = await open();
    const before = api.gh.calls.length;
    const big = await api.postJson("api/viewed", { ...(await good(api)), path: "x".repeat(300 * 1024) });
    expect(big.status).toBe(400);
    const wrongType = await fetch(api.url + "api/viewed", { method: "POST", headers: { ...api.headers, "Content-Type": "text/plain" }, body: JSON.stringify(await good(api)) });
    expect(wrongType.status).toBe(400);
    expect(api.gh.calls.length).toBe(before);
  });

  it("refuses a request without the CSRF token, with a wrong one, or from another origin", async () => {
    const api = await open();
    const body = await good(api);
    const before = api.gh.calls.length;
    const { "X-Diffninja-CSRF": _token, ...withoutToken } = api.headers;
    const cases: Array<Record<string, string>> = [
      withoutToken,
      { ...api.headers, "X-Diffninja-CSRF": "0".repeat(64) },
      { ...api.headers, "X-Diffninja-CSRF": "not a token" },
      { ...api.headers, Origin: "http://evil.example" },
      { ...api.headers, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of cases) {
      const response = await fetch(api.url + "api/viewed", { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    const { Origin: _origin, ...withoutOrigin } = api.headers;
    expect((await fetch(api.url + "api/viewed", { method: "POST", headers: withoutOrigin, body: JSON.stringify(body) })).status).toBe(403);
    expect(api.gh.calls.length).toBe(before);
  });

  it("refuses a request that names another host", async () => {
    const api = await open();
    const body = JSON.stringify(await good(api));
    const before = api.gh.calls.length;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(api.url + "api/viewed", { method: "POST", headers: { ...api.headers, Host: "evil.example", "Content-Length": String(Buffer.byteLength(body)) } }, (response) => { response.resume(); resolve(response.statusCode); });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    expect(status).toBe(403);
    expect(api.gh.calls.length).toBe(before);
  });

  it("answers nothing to a GET, a PUT or a DELETE, and nothing at all without the secret path", async () => {
    const api = await open();
    const body = JSON.stringify(await good(api));
    const before = api.gh.calls.length;
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(api.url + "api/viewed", { method, headers: api.headers, body: method === "GET" ? undefined : body });
      expect(response.status, method).toBe(404);
    }
    const origin = new URL(api.url).origin;
    expect((await fetch(`${origin}/api/viewed`, { method: "POST", headers: api.headers, body })).status).toBe(404);
    expect(api.gh.calls.length).toBe(before);
  });

  it("is not a general proxy: no route runs a query or a gh command the caller writes", async () => {
    const api = await open();
    const before = api.gh.calls.length;
    for (const route of ["api/graphql", "api/gh", "api/exec", "api/query", "api/mutation", "api/viewed/../graphql", "graphql"]) {
      const response = await api.postJson(route, { query: "query { viewer { login } }", args: ["api", "user"] });
      expect(response.status, route).toBe(404);
    }
    expect(api.gh.calls.length).toBe(before);
  });
});

describe("when GitHub refuses or fails the mark", () => {
  const SECRET = "ghp_SECRETTOKEN0123456789";

  it("says GitHub refused it, in GitHub's named message only, cleaned and short, with no raw body or stderr", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    const message = `Resource not accessible by personal access token\u0007\u001b[31m ${"x".repeat(900)}`;
    api.gh.writeFailure = failure(
      "gh: Resource not accessible by personal access token (markFileAsViewed)",
      JSON.stringify({ data: { markFileAsViewed: null }, errors: [{ type: "FORBIDDEN", path: ["markFileAsViewed"], message, extensions: { token: SECRET } }] }),
      `gh: Resource not accessible\nAuthorization: token ${SECRET}`,
    );
    const response = await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true });
    expect(response.status).toBe(400);
    const text = response.json.error ?? "";
    expect(text).toContain("The gh account is not authorized for that repository.");
    expect(text.length).toBeLessThan(600);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("extensions");
    expect(JSON.stringify(response.json)).not.toContain(SECRET);
    expect(api.gh.marks.get("app.ts")).toBe("UNVIEWED");
  });

  it("words a GraphQL refusal that names no status as a refusal of the Viewed mark", async () => {
    const api = await open();
    api.gh.writeFailure = failure(
      "gh: Could not mark the file (markFileAsViewed)",
      JSON.stringify({ errors: [{ type: "UNPROCESSABLE", message: "The file is not part of this pull request" }] }),
      `gh: Could not mark the file\nAuthorization: token ${SECRET}`,
    );
    const response = await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
    expect(response.json.error).toBe("GitHub refused the Viewed mark: The file is not part of this pull request.");
  });

  it("shows nothing of gh's stderr when a 4xx answer has no message of its own", async () => {
    const api = await open();
    api.gh.writeFailure = failure("gh: Validation Failed (HTTP 422)", "", `gh: Validation Failed (HTTP 422)\nAuthorization: token ${SECRET}`);
    const response = await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true });
    expect(response.json.error).toBe("GitHub rejected the Viewed mark.");
  });

  it("leaves the page's marks as they were after a refusal, and the next mark goes through", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    api.gh.writeFailure = failure("gh: Resource not accessible (HTTP 403)");
    expect((await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true })).status).toBe(400);
    const state = await api.state();
    expect(state.viewed?.available).toBe(true);
    expect(state.viewed?.available === true && state.viewed.files.some((file) => file.viewed)).toBe(false);
    api.gh.writeFailure = null;
    expect((await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true })).status).toBe(200);
  });

  it.each([
    ["a timeout", () => failure("gh timed out")],
    ["a server error", () => failure("gh: HTTP 502 Bad Gateway")],
    ["a lost connection", () => failure("dial tcp: connection refused")],
  ])("cannot say whether it landed after %s, so it stops trusting its marks until the pull request loads again", async (_name, make) => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    api.gh.writeFailure = make();
    const response = await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("The Viewed mark did not finish, so GitHub may or may not have recorded it. Load the pull request again to read GitHub's marks.");
    expect(response.json.state?.viewed).toEqual({ available: false, reason: "the last Viewed mark did not finish" });
    expect((await api.state()).viewed).toEqual({ available: false, reason: "the last Viewed mark did not finish" });

    api.gh.writeFailure = null;
    const before = api.gh.calls.length;
    expect((await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true })).status).toBe(400);
    expect(api.gh.calls.length).toBe(before);

    expect((await api.postJson("api/load", { url: PR_URL })).status).toBe(200);
    expect((await api.state()).viewed?.available).toBe(true);
    expect((await api.postJson("api/viewed", { snapshotId: await api.snapshotId(), path: "app.ts", viewed: true })).status).toBe(200);
  });

  it("does not count an answer it cannot read as a mark", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    for (const reply of ["", "not json", "{}", JSON.stringify({ data: {} }), JSON.stringify({ data: { unmarkFileAsViewed: {} } }), JSON.stringify({ data: { markFileAsViewed: null } }),
      JSON.stringify({ data: { markFileAsViewed: { clientMutationId: null } }, errors: [{ message: "partial" }] })]) {
      api.gh.writeReply = reply;
      const response = await api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true });
      expect(response.status, reply).toBe(400);
      expect(response.json.state?.viewed?.available, reply).toBe(false);
      expect((await api.postJson("api/load", { url: PR_URL })).status).toBe(200);
    }
  });
});

describe("marks that arrive together", () => {
  it("run one at a time in the order they arrived, so the last click is what GitHub ends with", async () => {
    const api = await open();
    const snapshotId = await api.snapshotId();
    const first = api.gh.pauseNextWrite();
    const marked = api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: true });
    await first.reached;
    const unmarked = api.postJson("api/viewed", { snapshotId, path: "app.ts", viewed: false });
    const other = api.postJson("api/viewed", { snapshotId, path: "lib/util.ts", viewed: true });
    // Nothing else reaches gh while the first is open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationCalls(api.gh)).toHaveLength(1);
    first.release();
    await Promise.all([marked, unmarked, other]);
    expect(mutationCalls(api.gh).map((args) => [valueOf(args, "query") === MARK_VIEWED_MUTATION, valueOf(args, "path")])).toEqual([
      [true, "app.ts"], [false, "app.ts"], [true, "lib/util.ts"],
    ]);
    expect(api.gh.maxInFlight).toBe(1);
    expect(api.gh.marks.get("app.ts")).toBe("UNVIEWED");
    expect((await api.state()).viewed).toMatchObject({ available: true });
  });
});

describe("what diffninja sends to GraphQL", () => {
  it("only ever sends one of the three fixed documents, whatever the session does", async () => {
    const api = await open((gh) => { gh.pageSize = 2; });
    const snapshotId = await api.snapshotId();
    await api.postJson("api/viewed", { snapshotId, path: ODD_PATH, viewed: true });
    await api.postJson("api/viewed", { snapshotId, path: AT_PATH, viewed: false });
    await api.postJson("api/viewed", { snapshotId, path: "nope", viewed: true });
    await api.postJson("api/load", { url: PR_URL });
    const documents = new Set([VIEWED_FILES_QUERY, MARK_VIEWED_MUTATION, UNMARK_VIEWED_MUTATION]);
    const sent = api.gh.graphqlCalls();
    expect(sent.length).toBeGreaterThan(6);
    for (const args of sent) {
      expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "graphql", "-f"]);
      expect(documents.has((args[5] ?? "").replace(/^query=/, ""))).toBe(true);
      // Every later argument is a raw `-f name=value` pair.
      const rest = args.slice(6);
      expect(rest.filter((_arg, index) => index % 2 === 0).every((flag) => flag === "-f")).toBe(true);
    }
  });
});
