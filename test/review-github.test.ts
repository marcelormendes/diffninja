import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ConnectedReview,
  GhCommandError,
  ghCliRunner,
  MIN_GH_VERSION,
  type ConnectedState,
  type GhInvocation,
  type GhResult,
  type GhRunner,
  type ReviewEvent,
  type ReviewInput,
  type ReviewPayload,
} from "../src/review/github.js";

describe("gh process input failures", () => {
  it("preserves an early rejection without crashing on a broken stdin pipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffninja-gh-exit-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "gh"), `#!${process.execPath}
process.stderr.write("gh: Bad credentials (HTTP 401)\\n");
process.exit(1);
`, { mode: 0o755 });
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
      await expect(ghCliRunner().run({
        args: ["api", "--input", "-"],
        stdin: "x".repeat(1024 * 1024),
        timeoutMs: 5_000,
      })).rejects.toMatchObject({ name: "GhCommandError", message: "gh: Bad credentials (HTTP 401)" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A scripted `gh`. It answers the same argv diffninja builds, so the tests
 * exercise the real decode, validation, and session paths without a network.
 */
/** Fields a scripted second `pr view` call may report differently. */
interface MetadataShift {
  state?: string;
  baseSha?: string;
  headSha?: string;
  title?: string;
  body?: string;
}

class FakeGh implements GhRunner {
  readonly calls: Array<{ args: string[]; stdin: string }> = [];
  version = "2.101.0";
  versionBanner: string | null = null;
  login = "octocat";
  loginId = 42;
  owner = "octocat";
  repo = "hello";
  number = 7;
  state = "OPEN";
  title = "Change the visible result";
  body = "Preserve failure reporting.";
  baseSha = "1".repeat(40);
  headSha = "2".repeat(40);
  cross = false;
  headRepository = "octocat/hello";
  urlOverride: string | null = null;
  diff = DIFF;
  files = JSON.stringify([listedFile("app.ts", APP_PATCH)]);
  reviews = "[]";
  comments = new Map<number, string>();
  postReply: string | null = null;
  failures = new Map<string, string>();
  /** Stdout body `gh` prints alongside a failure (GitHub's JSON error document). */
  errorBodies = new Map<string, string>();
  /** Applied to successive `pr view` calls, so a mid-read change is scriptable. */
  prMutations: MetadataShift[] = [];
  private prCalls = 0;

  async run(invocation: GhInvocation): Promise<GhResult> {
    const route = this.routeOf(invocation.args);
    this.calls.push({ args: [...invocation.args], stdin: invocation.stdin ?? "" });
    const failure = this.failures.get(route);
    if (failure !== undefined) throw new GhCommandError(failure, this.errorBodies.get(route) ?? "", failure);
    return { stdout: this.stdoutFor(route, invocation), stderr: "" };
  }

  callsFor(route: string): Array<{ args: string[]; stdin: string }> {
    return this.calls.filter((call) => this.routeOf(call.args) === route);
  }

  /** Index of the first call to `route`, for asserting read-before-write order. */
  indexOf(route: string): number {
    return this.calls.findIndex((call) => this.routeOf(call.args) === route);
  }

  private routeOf(args: string[]): string {
    if (args[0] === "--version") return "version";
    if (args[0] === "pr") return "pr";
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint === "user") return "user";
    if (args.includes("--input")) return "post";
    if (endpoint.endsWith("/files?per_page=100")) return "files";
    if (endpoint.endsWith("/reviews?per_page=100")) return "reviews";
    if (/\/reviews\/\d+\/comments\?per_page=100$/.test(endpoint)) return "comments";
    return "diff";
  }

  private stdoutFor(route: string, invocation: GhInvocation): string {
    if (route === "version") {
      return this.versionBanner ?? `gh version ${this.version} (2026-01-01)\nhttps://github.com/cli/cli/releases\n`;
    }
    if (route === "user") return JSON.stringify({ login: this.login, id: this.loginId, name: "Test" });
    if (route === "pr") return this.metadataText(this.prMutations[this.prCalls++] ?? {});
    if (route === "diff") return this.diff;
    if (route === "files") return this.files;
    if (route === "reviews") return this.reviews;
    if (route === "comments") {
      const [, id] = /\/reviews\/(\d+)\/comments/.exec(invocation.args[invocation.args.length - 1] ?? "") ?? [];
      return this.comments.get(Number(id)) ?? "[]";
    }
    return this.postReply ?? JSON.stringify({
      id: 555,
      html_url: `https://github.com/${this.owner}/${this.repo}/pull/${this.number}#pullrequestreview-555`,
      state: "COMMENTED",
      commit_id: this.headSha,
    });
  }

  private metadataText(mutation: MetadataShift): string {
    const url = this.urlOverride ?? `https://github.com/${this.owner}/${this.repo}/pull/${this.number}`;
    return JSON.stringify({
      url,
      id: `PR_kwDO${this.number}`,
      number: this.number,
      state: mutation.state ?? this.state,
      title: mutation.title ?? this.title,
      body: mutation.body ?? this.body,
      baseRefOid: mutation.baseSha ?? this.baseSha,
      headRefOid: mutation.headSha ?? this.headSha,
      isCrossRepository: this.cross,
      headRepository: { id: "R_1", name: "hello", nameWithOwner: this.headRepository },
      headRepositoryOwner: { id: "O_1", login: this.headRepository.split("/")[0] },
      baseRefName: "main",
      headRefName: "feature",
    });
  }
}

const DIFF = [
  "diff --git a/app.ts b/app.ts",
  "index 1111111..2222222 100644",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,3 +1,4 @@ function run()",
  " keep()",
  "-gone()",
  "+added()",
  "+more()",
  " last()",
  "",
].join("\n");

const APP_PATCH = "@@ -1,3 +1,4 @@ function run()\n keep()\n-gone()\n+added()\n+more()\n last()";
const PR_URL = "https://github.com/octocat/hello/pull/7";

/* Captured verbatim from the GitHub API (canonical diff plus the paginated file list). */
const REAL_CLI_DIFF = "diff --git a/command/pr.go b/command/pr.go\nindex 728c6ef7d74..16b31e3a048 100644\n--- a/command/pr.go\n+++ b/command/pr.go\n@@ -30,6 +30,10 @@ var prCmd = &cobra.Command{\n \tShort: \"Work with pull requests\",\n \tLong: `Interact with pull requests for this repository.\n `,\n+\tRun: func(cmd *cobra.Command, args []string) {\n+\t\terr := interactiveList()\n+\t\tutils.Check(err)\n+\t},\n }\n \n var prListCmd = &cobra.Command{\n@@ -196,6 +200,84 @@ func createPr(...string) {\n \t}\n }\n \n+func interactiveList() error {\n+\tcurrentPr, viewerCreated, reviewRequested, err := pullRequests()\n+\tif err != nil {\n+\t\treturn err\n+\t}\n+\n+\tprs := []graphqlPullRequest{}\n+\tif currentPr != nil {\n+\t\tprs = append(prs, *currentPr)\n+\t}\n+\tprs = append(prs, viewerCreated...)\n+\tprs = append(prs, reviewRequested...)\n+\n+\tconst openAction = \"open in browser\"\n+\tconst checkoutAction = \"checkout PR locally\"\n+\tconst cancelAction = \"cancel\"\n+\n+\tprOptions := []string{}\n+\tseen := map[int]bool{}\n+\tfor _, pr := range prs {\n+\t\tif seen[pr.Number] {\n+\t\t\tcontinue\n+\t\t}\n+\t\tprOptions = append(prOptions, fmt.Sprintf(\"[%v] %s\", pr.Number, pr.Title))\n+\t\tseen[pr.Number] = true\n+\t}\n+\n+\t// TODO figure out how to visually seperate the PR list\n+\tqs := []*survey.Question{\n+\t\t{\n+\t\t\tName: \"pr\",\n+\t\t\tPrompt: &survey.Select{\n+\t\t\t\tMessage: \"PRs you might be interested in\",\n+\t\t\t\tOptions: prOptions,\n+\t\t\t},\n+\t\t},\n+\t\t{\n+\t\t\tName: \"action\",\n+\t\t\tPrompt: &survey.Select{\n+\t\t\t\tMessage: \"What would you like to do?\",\n+\t\t\t\tOptions: []string{\n+\t\t\t\t\topenAction,\n+\t\t\t\t\tcheckoutAction,\n+\t\t\t\t\tcancelAction,\n+\t\t\t\t},\n+\t\t\t},\n+\t\t},\n+\t}\n+\n+\tanswers := struct {\n+\t\tPr     int\n+\t\tAction string\n+\t}{}\n+\n+\terr = survey.Ask(qs, &answers)\n+\tif err != nil {\n+\t\treturn err\n+\t}\n+\n+\tactions := map[string]func() error{}\n+\n+\tactions[cancelAction] = func() error { return nil }\n+\tactions[openAction] = func() error {\n+\t\tlauncher, err := utils.BrowserLauncher()\n+\t\tif err != nil {\n+\t\t\treturn err\n+\t\t}\n+\t\texec.Command(launcher[0], prs[answers.Pr].URL).Run()\n+\t\treturn nil\n+\t}\n+\tactions[checkoutAction] = func() error {\n+\t\tpr := prs[answers.Pr]\n+\t\treturn checkoutPr(fmt.Sprintf(\"%v\", pr.Number))\n+\t}\n+\n+\treturn actions[answers.Action]()\n+\n+}\n func list() error {\n \tcurrentPr, viewerCreated, reviewRequested, err := pullRequests()\n \tif err != nil {\n";
const REAL_CLI_FILES = "[{\"sha\":\"16b31e3a0487aea4a16c34476513c0d164a59da2\",\"filename\":\"command/pr.go\",\"status\":\"modified\",\"additions\":82,\"deletions\":0,\"changes\":82,\"blob_url\":\"https://github.com/cli/cli/blob/e9a3253762e768badaa1d4a5b3d267416d1e42f4/command%2Fpr.go\",\"raw_url\":\"https://github.com/cli/cli/raw/e9a3253762e768badaa1d4a5b3d267416d1e42f4/command%2Fpr.go\",\"contents_url\":\"https://api.github.com/repos/cli/cli/contents/command%2Fpr.go?ref=e9a3253762e768badaa1d4a5b3d267416d1e42f4\",\"patch\":\"@@ -30,6 +30,10 @@ var prCmd = &cobra.Command{\\n \\tShort: \\\"Work with pull requests\\\",\\n \\tLong: `Interact with pull requests for this repository.\\n `,\\n+\\tRun: func(cmd *cobra.Command, args []string) {\\n+\\t\\terr := interactiveList()\\n+\\t\\tutils.Check(err)\\n+\\t},\\n }\\n \\n var prListCmd = &cobra.Command{\\n@@ -196,6 +200,84 @@ func createPr(...string) {\\n \\t}\\n }\\n \\n+func interactiveList() error {\\n+\\tcurrentPr, viewerCreated, reviewRequested, err := pullRequests()\\n+\\tif err != nil {\\n+\\t\\treturn err\\n+\\t}\\n+\\n+\\tprs := []graphqlPullRequest{}\\n+\\tif currentPr != nil {\\n+\\t\\tprs = append(prs, *currentPr)\\n+\\t}\\n+\\tprs = append(prs, viewerCreated...)\\n+\\tprs = append(prs, reviewRequested...)\\n+\\n+\\tconst openAction = \\\"open in browser\\\"\\n+\\tconst checkoutAction = \\\"checkout PR locally\\\"\\n+\\tconst cancelAction = \\\"cancel\\\"\\n+\\n+\\tprOptions := []string{}\\n+\\tseen := map[int]bool{}\\n+\\tfor _, pr := range prs {\\n+\\t\\tif seen[pr.Number] {\\n+\\t\\t\\tcontinue\\n+\\t\\t}\\n+\\t\\tprOptions = append(prOptions, fmt.Sprintf(\\\"[%v] %s\\\", pr.Number, pr.Title))\\n+\\t\\tseen[pr.Number] = true\\n+\\t}\\n+\\n+\\t// TODO figure out how to visually seperate the PR list\\n+\\tqs := []*survey.Question{\\n+\\t\\t{\\n+\\t\\t\\tName: \\\"pr\\\",\\n+\\t\\t\\tPrompt: &survey.Select{\\n+\\t\\t\\t\\tMessage: \\\"PRs you might be interested in\\\",\\n+\\t\\t\\t\\tOptions: prOptions,\\n+\\t\\t\\t},\\n+\\t\\t},\\n+\\t\\t{\\n+\\t\\t\\tName: \\\"action\\\",\\n+\\t\\t\\tPrompt: &survey.Select{\\n+\\t\\t\\t\\tMessage: \\\"What would you like to do?\\\",\\n+\\t\\t\\t\\tOptions: []string{\\n+\\t\\t\\t\\t\\topenAction,\\n+\\t\\t\\t\\t\\tcheckoutAction,\\n+\\t\\t\\t\\t\\tcancelAction,\\n+\\t\\t\\t\\t},\\n+\\t\\t\\t},\\n+\\t\\t},\\n+\\t}\\n+\\n+\\tanswers := struct {\\n+\\t\\tPr     int\\n+\\t\\tAction string\\n+\\t}{}\\n+\\n+\\terr = survey.Ask(qs, &answers)\\n+\\tif err != nil {\\n+\\t\\treturn err\\n+\\t}\\n+\\n+\\tactions := map[string]func() error{}\\n+\\n+\\tactions[cancelAction] = func() error { return nil }\\n+\\tactions[openAction] = func() error {\\n+\\t\\tlauncher, err := utils.BrowserLauncher()\\n+\\t\\tif err != nil {\\n+\\t\\t\\treturn err\\n+\\t\\t}\\n+\\t\\texec.Command(launcher[0], prs[answers.Pr].URL).Run()\\n+\\t\\treturn nil\\n+\\t}\\n+\\tactions[checkoutAction] = func() error {\\n+\\t\\tpr := prs[answers.Pr]\\n+\\t\\treturn checkoutPr(fmt.Sprintf(\\\"%v\\\", pr.Number))\\n+\\t}\\n+\\n+\\treturn actions[answers.Action]()\\n+\\n+}\\n func list() error {\\n \\tcurrentPr, viewerCreated, reviewRequested, err := pullRequests()\\n \\tif err != nil {\"}]";
const REAL_REACT_DIFF = "diff --git a/packages/react-reconciler/src/ReactFiberHooks.js b/packages/react-reconciler/src/ReactFiberHooks.js\nindex 1eac572f1c84..90ea87077911 100644\n--- a/packages/react-reconciler/src/ReactFiberHooks.js\n+++ b/packages/react-reconciler/src/ReactFiberHooks.js\n@@ -1144,6 +1144,12 @@ function useThenable<T>(thenable: Thenable<T>): T {\n       if (currentFiber !== null && currentFiber.memoizedState !== null) {\n         ReactSharedInternals.H = HooksDispatcherOnUpdateInDEV;\n       } else {\n+        if (\n+          ReactSharedInternals.H === HooksDispatcherOnRerenderInDEV &&\n+          hookTypesDev !== null\n+        ) {\n+          hookTypesDev.length = hookTypesUpdateIndexDev + 1;\n+        }\n         ReactSharedInternals.H = HooksDispatcherOnMountInDEV;\n       }\n     } else {\ndiff --git a/packages/react-reconciler/src/__tests__/ReactHooks-test.internal.js b/packages/react-reconciler/src/__tests__/ReactHooks-test.internal.js\nindex e61e4a825602..55324646bc25 100644\n--- a/packages/react-reconciler/src/__tests__/ReactHooks-test.internal.js\n+++ b/packages/react-reconciler/src/__tests__/ReactHooks-test.internal.js\n@@ -2092,4 +2092,47 @@ describe('ReactHooks', () => {\n     await act(() => setShouldThrow(true));\n     expect(root).toMatchRenderedOutput('Error!');\n   });\n+\n+  // Regression test for https://github.com/facebook/react/issues/37655\n+  it('does not warn on hook order mismatch when a component suspends multiple times via use()', async () => {\n+    const {createContext, useContext, useState, useEffect, use, Suspense} =\n+      React;\n+\n+    const userPromise = Promise.resolve('user');\n+    const companyPromise = Promise.resolve('company');\n+\n+    const A = createContext('a');\n+    const B = createContext('b');\n+    const C = createContext('c');\n+    const D = createContext('d');\n+    const E = createContext('e');\n+\n+    let setN;\n+    function Page() {\n+      useContext(A);\n+      useContext(B);\n+      useContext(C);\n+      use(userPromise);\n+      useContext(D);\n+      use(companyPromise);\n+      useContext(E);\n+      const [n, _setN] = useState(0);\n+      setN = _setN;\n+      useEffect(() => {\n+        setN(1);\n+      }, []);\n+      return 'rendered ' + n;\n+    }\n+\n+    let root;\n+    await act(() => {\n+      root = ReactTestRenderer.create(\n+        <Suspense fallback=\"loading\">\n+          <Page />\n+        </Suspense>,\n+        {unstable_isConcurrent: true},\n+      );\n+    });\n+    expect(root).toMatchRenderedOutput('rendered 1');\n+  });\n });\n";
const REAL_REACT_FILES = "[{\"sha\":\"90ea87077911d48a7abbb514d7630805d6e2c984\",\"filename\":\"packages/react-reconciler/src/ReactFiberHooks.js\",\"status\":\"modified\",\"additions\":6,\"deletions\":0,\"changes\":6,\"blob_url\":\"https://github.com/react/react/blob/b7c5252fee4ca3923513f360e00192da35028ad4/packages%2Freact-reconciler%2Fsrc%2FReactFiberHooks.js\",\"raw_url\":\"https://github.com/react/react/raw/b7c5252fee4ca3923513f360e00192da35028ad4/packages%2Freact-reconciler%2Fsrc%2FReactFiberHooks.js\",\"contents_url\":\"https://api.github.com/repos/react/react/contents/packages%2Freact-reconciler%2Fsrc%2FReactFiberHooks.js?ref=b7c5252fee4ca3923513f360e00192da35028ad4\",\"patch\":\"@@ -1144,6 +1144,12 @@ function useThenable<T>(thenable: Thenable<T>): T {\\n       if (currentFiber !== null && currentFiber.memoizedState !== null) {\\n         ReactSharedInternals.H = HooksDispatcherOnUpdateInDEV;\\n       } else {\\n+        if (\\n+          ReactSharedInternals.H === HooksDispatcherOnRerenderInDEV &&\\n+          hookTypesDev !== null\\n+        ) {\\n+          hookTypesDev.length = hookTypesUpdateIndexDev + 1;\\n+        }\\n         ReactSharedInternals.H = HooksDispatcherOnMountInDEV;\\n       }\\n     } else {\"},{\"sha\":\"55324646bc250c6e945880599ae4a0b652b26068\",\"filename\":\"packages/react-reconciler/src/__tests__/ReactHooks-test.internal.js\",\"status\":\"modified\",\"additions\":43,\"deletions\":0,\"changes\":43,\"blob_url\":\"https://github.com/react/react/blob/b7c5252fee4ca3923513f360e00192da35028ad4/packages%2Freact-reconciler%2Fsrc%2F__tests__%2FReactHooks-test.internal.js\",\"raw_url\":\"https://github.com/react/react/raw/b7c5252fee4ca3923513f360e00192da35028ad4/packages%2Freact-reconciler%2Fsrc%2F__tests__%2FReactHooks-test.internal.js\",\"contents_url\":\"https://api.github.com/repos/react/react/contents/packages%2Freact-reconciler%2Fsrc%2F__tests__%2FReactHooks-test.internal.js?ref=b7c5252fee4ca3923513f360e00192da35028ad4\",\"patch\":\"@@ -2092,4 +2092,47 @@ describe('ReactHooks', () => {\\n     await act(() => setShouldThrow(true));\\n     expect(root).toMatchRenderedOutput('Error!');\\n   });\\n+\\n+  // Regression test for https://github.com/facebook/react/issues/37655\\n+  it('does not warn on hook order mismatch when a component suspends multiple times via use()', async () => {\\n+    const {createContext, useContext, useState, useEffect, use, Suspense} =\\n+      React;\\n+\\n+    const userPromise = Promise.resolve('user');\\n+    const companyPromise = Promise.resolve('company');\\n+\\n+    const A = createContext('a');\\n+    const B = createContext('b');\\n+    const C = createContext('c');\\n+    const D = createContext('d');\\n+    const E = createContext('e');\\n+\\n+    let setN;\\n+    function Page() {\\n+      useContext(A);\\n+      useContext(B);\\n+      useContext(C);\\n+      use(userPromise);\\n+      useContext(D);\\n+      use(companyPromise);\\n+      useContext(E);\\n+      const [n, _setN] = useState(0);\\n+      setN = _setN;\\n+      useEffect(() => {\\n+        setN(1);\\n+      }, []);\\n+      return 'rendered ' + n;\\n+    }\\n+\\n+    let root;\\n+    await act(() => {\\n+      root = ReactTestRenderer.create(\\n+        <Suspense fallback=\\\"loading\\\">\\n+          <Page />\\n+        </Suspense>,\\n+        {unstable_isConcurrent: true},\\n+      );\\n+    });\\n+    expect(root).toMatchRenderedOutput('rendered 1');\\n+  });\\n });\"}]";

function listedFile(filename: string, patch: string | null, previous?: string) {
  return { filename, previous_filename: previous, status: "modified", additions: 1, deletions: 1, patch };
}

function session(gh: FakeGh): ConnectedReview {
  return new ConnectedReview({ runner: gh, timeoutMs: 1_000 });
}

async function loadedSession(gh = new FakeGh()): Promise<{ review: ConnectedReview; gh: FakeGh; state: ConnectedState }> {
  const review = session(gh);
  const state = await review.load(PR_URL);
  return { review, gh, state };
}

/** A complete review that anchors to an added line and a context line. */
function reviewInput(state: ConnectedState, over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    snapshotId: state.snapshot?.id ?? "",
    event: "COMMENT",
    body: "Please rename this.",
    comments: [
      { path: "app.ts", line: 2, side: "RIGHT", body: "Rename this." },
      { path: "app.ts", line: 1, side: "RIGHT", body: "Still here?" },
    ],
    ...over,
  };
}

/**
 * Overlay raw wire values on a prepared input, standing in for a transport that
 * forwards whatever it received (the UI casts the request body without checking).
 */
function wire(state: ConnectedState, json: string): ReviewInput {
  return { ...reviewInput(state), ...JSON.parse(json) };
}

async function rejected(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  throw new Error("expected the call to be rejected");
}

describe("connected review load", () => {
  it("exports only a successfully bound canonical patch, retaining it after a failed refresh", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    expect(() => review.getDiff()).toThrow(/Load a pull request/);
    await review.load(PR_URL);
    expect(review.getDiff()).toBe(DIFF);
    gh.diff = DIFF.replace("+added()", "+changed()");
    gh.failures.set("files", "gh: Bad credentials (HTTP 401)");
    await expect(review.load(PR_URL)).rejects.toThrow(/not authenticated/);
    expect(review.getDiff()).toBe(DIFF);
  });

  it("binds identity, canonical metadata, and diff anchors", async () => {
    const { state } = await loadedSession();
    expect(state.status).toBe("ready");
    expect(state.identity).toEqual({ login: "octocat", id: 42 });
    expect(state.snapshot).toMatchObject({
      url: PR_URL,
      owner: "octocat",
      repo: "hello",
      number: 7,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      state: "OPEN",
    });
    expect(state.snapshot?.unavailableReason).toBeUndefined();
    expect(state.snapshot?.lines).toEqual([
      { path: "app.ts", line: 1, side: "RIGHT", text: "keep()", kind: "context" },
      { path: "app.ts", line: 2, side: "LEFT", text: "gone()", kind: "delete" },
      { path: "app.ts", line: 2, side: "RIGHT", text: "added()", kind: "add" },
      { path: "app.ts", line: 3, side: "RIGHT", text: "more()", kind: "add" },
      { path: "app.ts", line: 4, side: "RIGHT", text: "last()", kind: "context" },
    ]);
  });


  it("refuses every URL that is not an explicit github.com pull request", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const urls = [
      "http://github.com/octocat/hello/pull/7",
      "https://gitlab.com/octocat/hello/pull/7",
      "https://github.com/octocat/hello/pull/7/files",
      "https://github.com/octocat/hello/pull/7?diff=split",
      "https://github.com/octocat/hello/pulls/7",
      "https://github.com/octocat/hello/pull/0",
      "https://github.com/octocat/hello",
      "octocat/hello#7",
      "",
    ];
    for (const url of urls) {
      expect(await rejected(review.load(url)), url).toMatch(/pull request URL|Only https|query string/i);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("rejects a canonical answer for a different pull request", async () => {
    const gh = new FakeGh();
    gh.urlOverride = "https://github.com/other/repo/pull/7";
    const review = session(gh);
    expect(await rejected(review.load(PR_URL))).toMatch(/different pull request/);
    expect(review.getState().snapshot).toBeUndefined();
  });

  it("keeps one pull request per session and allows a refresh of that same one", async () => {
    const { review } = await loadedSession();
    expect(await rejected(review.load("https://github.com/other/repo/pull/1"))).toMatch(/bound to octocat\/hello#7/);
    const refreshed = await review.load(PR_URL);
    expect(refreshed.status).toBe("ready");
  });

  it("reports a closed, merged, or unavailable-head pull request distinctly", async () => {
    for (const [state, pattern] of [["CLOSED", /closed/], ["MERGED", /merged/]] as const) {
      const gh = new FakeGh();
      gh.state = state;
      const { state: connected } = await loadedSession(gh);
      expect(connected.status).toBe("empty");
      expect(connected.snapshot?.unavailableReason).toMatch(pattern);
      expect(connected.message).toMatch(pattern);
      expect(connected.snapshot?.lines).toHaveLength(5);
    }
    const fork = new FakeGh();
    fork.cross = true;
    fork.headRepository = "contributor/hello";
    const forked = await loadedSession(fork);
    expect(forked.state.status).toBe("ready");
    expect(forked.state.message).toMatch(/lives in contributor\/hello, a fork/);
    expect((await forked.review.preview(reviewInput(forked.state))).comments).toHaveLength(2);
  });
});

describe("connected review anchors", () => {
  it("accepts added-right and context-either-side anchors", async () => {
    const { review, state } = await loadedSession();
    const payload = await review.preview(reviewInput(state, {
      comments: [
        { path: "app.ts", line: 2, side: "RIGHT", body: "added" },
        { path: "app.ts", line: 1, side: "LEFT", body: "context left" },
        { path: "app.ts", line: 1, side: "RIGHT", body: "context right" },
        { path: "app.ts", line: 2, side: "LEFT", body: "deleted" },
      ],
    }));
    expect(payload.commit_id).toBe(state.snapshot?.headSha);
    expect(payload.comments).toHaveLength(4);
  });

  it("refuses wrong line, wrong side, and unknown path anchors", async () => {
    const { review, state } = await loadedSession();
    const cases: Array<[string, ReviewInput["comments"], RegExp]> = [
      ["beyond the diff", [{ path: "app.ts", line: 99, side: "RIGHT", body: "nope" }], /does not match a line/],
      ["past the last hunk line", [{ path: "app.ts", line: 5, side: "RIGHT", body: "nope" }], /does not match a line/],
      ["old side has no line 4", [{ path: "app.ts", line: 4, side: "LEFT", body: "nope" }], /does not match a line/],
      ["zero is not a diff line", [{ path: "app.ts", line: 0, side: "RIGHT", body: "zero" }], /positive diff line number/],
      ["path outside the pull request", [{ path: "other.ts", line: 1, side: "RIGHT", body: "wrong file" }], /does not match a line/],
      ["fragment of a path", [{ path: "pp.ts", line: 1, side: "RIGHT", body: "wrong file" }], /does not match a line/],
      ["inside the file but not the hunk", [{ path: "app.ts", line: 120, side: "RIGHT", body: "nope" }], /does not match a line/],
    ];
    for (const [label, comments, pattern] of cases) {
      expect(await rejected(review.preview(reviewInput(state, { comments }))), label).toMatch(pattern);
    }
  });

  it("pins the side each kind of line may be anchored with", async () => {
    const { review, state } = await loadedSession();
    const accepted = await review.preview(reviewInput(state, {
      comments: [
        { path: "app.ts", line: 3, side: "RIGHT", body: "added more()" },
        { path: "app.ts", line: 3, side: "LEFT", body: "context last() on the old side" },
        { path: "app.ts", line: 4, side: "RIGHT", body: "context last() on the new side" },
        { path: "app.ts", line: 2, side: "LEFT", body: "deleted gone()" },
      ],
    }));
    expect(accepted.comments.map((comment) => [comment.line, comment.side]))
      .toEqual([[3, "RIGHT"], [3, "LEFT"], [4, "RIGHT"], [2, "LEFT"]]);
  });

  it("refuses a review that would be empty or unanchored", async () => {
    const { review, state } = await loadedSession();
    expect(await rejected(review.preview(reviewInput(state, { body: "  ", comments: [] })))).toMatch(/Add review text/);
    expect(await rejected(review.preview(reviewInput(state, { event: "REQUEST_CHANGES", body: "" })))).toMatch(/Requesting changes needs review text/);
    expect(await rejected(review.preview(reviewInput(state, { snapshotId: "other" })))).toMatch(/different version/);
    expect(await rejected(review.preview(reviewInput(state, { comments: [{ path: "app.ts", line: 2, side: "RIGHT", body: " " }] })))).toMatch(/needs text/);

    // Values the UI may have forwarded without checking must be refused here too.
    expect(await rejected(review.preview(wire(state, '{"event":"MERGE"}')))).toMatch(/review event/);
    expect(await rejected(review.preview(wire(state, '{"comments":{}}')))).toMatch(/comments as an array/);
    expect(await rejected(review.preview(wire(state, '{"comments":[{"path":"app.ts","line":2,"side":"BOTH","body":"x"}]}')))).toMatch(/needs side LEFT or RIGHT/);
    expect(await rejected(review.preview(wire(state, '{"comments":[{"path":"app.ts","line":"2","side":"RIGHT","body":"x"}]}')))).toMatch(/positive diff line number/);
    expect(await rejected(review.preview(wire(state, '{"comments":[{"path":"app.ts","line":2,"side":"RIGHT"}]}')))).toMatch(/needs text/);
    expect(await rejected(review.preview(wire(state, '{"body":7}')))).toMatch(/review text as a string/);
    expect(await rejected(review.preview(wire(state, '{"snapshotId":null}')))).toMatch(/different version/);
  });

  it("fails closed when the installed gh version cannot be read", async () => {
    const gh = new FakeGh();
    gh.versionBanner = "gh: something entirely unexpected\n";
    const review = session(gh);
    expect(await rejected(review.load(PR_URL))).toMatch(/could not read the installed gh version/);
    expect(review.getState().snapshot).toBeUndefined();
    expect(gh.callsFor("pr")).toHaveLength(0);
  });

  it("refuses a pull request that moves while its diff is being read", async () => {
    const gh = new FakeGh();
    // The second `pr view` (the bracket after diff + files) reports a new head.
    gh.prMutations = [{}, { headSha: "9".repeat(40) }];
    const review = session(gh);
    expect(await rejected(review.load(PR_URL))).toMatch(/changed while diffninja was reading it/);
    expect(review.getState().snapshot).toBeUndefined();
    expect(review.getState().status).toBe("empty");
  });

  it("rejects intent changes during a snapshot read rather than pairing new claims with old evidence", async () => {
    const gh = new FakeGh();
    gh.prMutations = [{}, { body: "Failures may now be ignored." }];
    const review = session(gh);
    await expect(review.load(PR_URL)).rejects.toThrow();
    expect(review.getState().snapshot).toBeUndefined();
  });

  it("blocks submission when the PR promise changed after preview", async () => {
    const gh = new FakeGh();
    const { review, state } = await loadedSession(gh);
    const draft: ReviewInput = { snapshotId: state.snapshot!.id, event: "COMMENT", body: "Checked the original contract.", comments: [] };
    await review.preview(draft);
    gh.title = "Change the promised behavior";
    await expect(review.submit(draft)).rejects.toThrow();
    expect(gh.callsFor("post")).toEqual([]);
  });

  it("binds the session to the pull request that loaded, even when it is not reviewable", async () => {
    const gh = new FakeGh();
    gh.state = "MERGED";
    const review = session(gh);
    expect((await review.load(PR_URL)).status).toBe("empty");
    expect(await rejected(review.load("https://github.com/other/repo/pull/1"))).toMatch(/bound to octocat\/hello#7 \(not reviewable\)/);
    expect((await review.load(PR_URL)).snapshot?.state).toBe("MERGED");
  });

  it("reads paginated answers as concatenated documents, not one JSON value", async () => {
    const secondPage = async (gh: FakeGh): Promise<string> => {
      const { state } = await loadedSession(gh);
      expect(state.status).toBe("empty");
      return state.snapshot?.unavailableReason ?? "";
    };
    const extra = new FakeGh();
    extra.files = `${JSON.stringify([listedFile("app.ts", APP_PATCH)])}${JSON.stringify([listedFile("extra.ts", "@@ -1 +1 @@\n-a\n+b")])}`;
    expect(await secondPage(extra)).toMatch(/file list includes extra.ts/);

    const split = new FakeGh();
    split.files = `[${JSON.stringify(listedFile("app.ts", APP_PATCH))}]`;
    expect((await session(split).load(PR_URL)).status).toBe("ready");

    const ghost = new FakeGh();
    ghost.files = `${JSON.stringify([listedFile("app.ts", APP_PATCH)])}\n${JSON.stringify([{ filename: "ghost.ts", patch: "@@ -1 +1 @@\n-a\n+b" }])}`;
    expect(await secondPage(ghost)).toMatch(/ghost\.ts/);
  });

  it("reports a truncated or non-list paginated answer instead of parsing it", async () => {
    const truncated = new FakeGh();
    truncated.files = '[{"filename":"app.ts","patch":"@@ -1 +1 @@"}';
    expect(await rejected(session(truncated).load(PR_URL))).toMatch(/truncated file list/);

    const errorDocument = new FakeGh();
    errorDocument.files = JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com" });
    expect(await rejected(session(errorDocument).load(PR_URL))).toMatch(/did not return that pull request/);

    const objectPayload = new FakeGh();
    objectPayload.files = JSON.stringify({ files: [] });
    expect(await rejected(session(objectPayload).load(PR_URL))).toMatch(/was not a list/);
  });

  it("refuses malformed comment rows and multi-line or control-character text", async () => {
    const { review, state } = await loadedSession();
    const cases: Array<[string, string, RegExp]> = [
      ["null row", '{"comments":[null]}', /must be an object/],
      ["number row", '{"comments":[7]}', /must be an object/],
      ["array row", '{"comments":[[]]}', /must be an object/],
      ["text row", '{"comments":["nope"]}', /must be an object/],
      ["missing body", '{"comments":[{"path":"app.ts","line":2,"side":"RIGHT"}]}', /needs text/],
      ["missing path", '{"comments":[{"line":2,"side":"RIGHT","body":"x"}]}', /needs a file path/],
      ["object path", '{"comments":[{"path":{},"line":2,"side":"RIGHT","body":"x"}]}', /needs a file path/],
      ["multi-line body", '{"comments":[{"path":"app.ts","line":2,"side":"RIGHT","body":"one\\ntwo"}]}', /single line/],
      ["carriage return body", '{"comments":[{"path":"app.ts","line":2,"side":"RIGHT","body":"one\\rtwo"}]}', /single line/],
      ["NUL in body", '{"comments":[{"path":"app.ts","line":2,"side":"RIGHT","body":"one\\u0000two"}]}', /control characters/],
      ["control character in path", '{"comments":[{"path":"app\\u0000.ts","line":2,"side":"RIGHT","body":"x"}]}', /control characters/],
      ["fractional line", '{"comments":[{"path":"app.ts","line":2.5,"side":"RIGHT","body":"x"}]}', /positive diff line number/],
      ["string line", '{"comments":[{"path":"app.ts","line":"2","side":"RIGHT","body":"x"}]}', /positive diff line number/],
      ["null side", '{"comments":[{"path":"app.ts","line":2,"side":null,"body":"x"}]}', /needs side LEFT or RIGHT/],
    ];
    for (const [label, json, pattern] of cases) {
      expect(await rejected(review.preview(wire(state, json))), label).toMatch(pattern);
    }
    const accepted = await review.preview(reviewInput(state, {
      comments: [{ path: "app.ts", line: 2, side: "RIGHT", body: "Tabs\tand marks ✓ are fine." }],
    }));
    expect(accepted.comments[0].body).toBe("Tabs\tand marks ✓ are fine.");
  });

  it("refuses a review before a pull request is loaded", async () => {
    const review = session(new FakeGh());
    expect(await rejected(review.preview(reviewInput({ status: "empty" })))).toMatch(/Load a reviewable pull request/);
    expect(await rejected(review.submit(reviewInput({ status: "empty" })))).toMatch(/Load a reviewable pull request/);
  });
});

describe("connected review submit safety", () => {
  it("submits exactly the previewed payload with an explicit commit_id", async () => {
    const { review, gh, state } = await loadedSession();
    const input = reviewInput(state);
    const payload = await review.preview(input);
    const submitted = await review.submit(input);
    expect(submitted.status).toBe("submitted");
    expect(submitted.receipt?.id).toBe(555);
    expect(gh.callsFor("post")[0].args).toEqual([
      "api", "--hostname", "github.com", "--input", "-", "-X", "POST", "-H", "Accept: application/vnd.github+json",
      "repos/octocat/hello/pulls/7/reviews",
    ]);
    expect(JSON.parse(gh.callsFor("post")[0].stdin)).toEqual({
      commit_id: state.snapshot?.headSha,
      event: "COMMENT",
      body: "Please rename this.",
      comments: payload.comments,
    });
  });

  it("requires a preview of the very same payload", async () => {
    const { review, state } = await loadedSession();
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/Preview the review before submitting/);
    await review.preview(reviewInput(state));
    expect(await rejected(review.submit(reviewInput(state, { body: "Changed after the preview." })))).toMatch(/changed after the last preview/);
    expect(await rejected(review.submit(reviewInput(state, { comments: [] })))).toMatch(/changed after the last preview/);
  });

  it("refuses to submit when the head moved after the preview", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.headSha = "3".repeat(40);
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/changed since it was loaded/);
    expect(gh.callsFor("post")).toHaveLength(0);
  });

  it("refuses to submit when only the diff changed after the preview", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.diff = DIFF.replace("+more()", "+sneaked()");
    gh.files = JSON.stringify([listedFile("app.ts", APP_PATCH.replace("+more()", "+sneaked()"))]);
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/changed since it was loaded/);
    expect(gh.callsFor("post")).toHaveLength(0);
  });

  it("refuses to submit once the pull request closed after the preview", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.state = "MERGED";
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/cannot be reviewed any more: .*merged/);
    expect(gh.callsFor("post")).toHaveLength(0);
  });

  it("refuses to submit under a different gh account", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.login = "someone-else";
    gh.loginId = 99;
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/now authenticated as someone-else/);
    expect(gh.callsFor("post")).toHaveLength(0);
  });

  it("keeps the session ready when the pre-submit read fails", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.failures.set("diff", "gh timed out");
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/did not answer in time/);
    expect(review.getState().status).toBe("ready");
    expect(gh.callsFor("post")).toHaveLength(0);
    gh.failures.delete("diff");
    expect((await review.submit(reviewInput(state))).status).toBe("submitted");
    expect(gh.callsFor("post")).toHaveLength(1);
  });

  it("submits one review even when two submits race", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    const results = await Promise.allSettled([review.submit(reviewInput(state)), review.submit(reviewInput(state))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(gh.callsFor("post")).toHaveLength(1);
    expect(review.getState().status).toBe("submitted");
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/already submitted/);
    expect(gh.callsFor("post")).toHaveLength(1);
  });

  it("reads the existing reviews before writing, and refuses to write without it", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    await review.preview(reviewInput(state));
    expect((await review.submit(reviewInput(state))).status).toBe("submitted");
    expect(gh.indexOf("reviews")).toBeGreaterThan(-1);
    expect(gh.indexOf("reviews")).toBeLessThan(gh.indexOf("post"));

    const blocked = new FakeGh();
    const blockedReview = session(blocked);
    const blockedState = await blockedReview.load(PR_URL);
    await blockedReview.preview(reviewInput(blockedState));
    blocked.failures.set("reviews", "gh: Server Error (HTTP 500)");
    expect(await rejected(blockedReview.submit(reviewInput(blockedState)))).toMatch(/server error/);
    expect(blocked.callsFor("post")).toHaveLength(0);
    expect(blockedReview.getState().status).toBe("ready");
    expect(blockedReview.getState().receipt).toBeUndefined();
  });

  it("requires the answer to echo the commit sent and the state of the event", async () => {
    const url = "https://github.com/octocat/hello/pull/7#pullrequestreview-555";
    const submitWithReply = async (reply: Record<string, string | number>, event: ReviewEvent): Promise<string> => {
      const gh = new FakeGh();
      const review = session(gh);
      const state = await review.load(PR_URL);
      const input = reviewInput(state, { event });
      await review.preview(input);
      gh.postReply = JSON.stringify(reply);
      const message = await rejected(review.submit(input));
      expect(review.getState().status).toBe("unknown");
      expect(review.getState().receipt).toBeUndefined();
      return message;
    };
    const headSha = "2".repeat(40);
    expect(await submitWithReply({ id: 555, html_url: url, state: "COMMENTED", commit_id: "f".repeat(40) }, "COMMENT"))
      .toMatch(/cannot tell whether the review was created/);
    expect(await submitWithReply({ id: 555, html_url: url, state: "APPROVED", commit_id: headSha }, "COMMENT"))
      .toMatch(/cannot tell whether the review was created/);
    expect(await submitWithReply({ id: 555, html_url: url, state: "COMMENTED" }, "COMMENT"))
      .toMatch(/cannot tell whether the review was created/);
    expect(await submitWithReply({ id: 555, html_url: url, state: "COMMENTED", commit_id: headSha }, "APPROVE"))
      .toMatch(/cannot tell whether the review was created/);
  });

  it("shows GitHub's own reason when it refuses a review", async () => {
    const approve = new FakeGh();
    const approving = session(approve);
    const approveState = await approving.load(PR_URL);
    await approving.preview(reviewInput(approveState, { event: "APPROVE" }));
    // gh prints the status to stderr and GitHub's JSON body to stdout; only the
    // named message/errors fields reach the user, never the raw output.
    approve.errorBodies.set("post", JSON.stringify({
      message: "Unprocessable Entity",
      errors: ["Can not approve your own pull request"],
      documentation_url: "https://docs.github.com/rest/pulls/reviews",
      status: "422",
    }));
    approve.failures.set("post", "gh: Unprocessable Entity (HTTP 422)");
    const refusal = await rejected(approving.submit(reviewInput(approveState, { event: "APPROVE" })));
    expect(refusal).toBe("GitHub rejected the review: Unprocessable Entity — Can not approve your own pull request");
    expect(refusal).not.toMatch(/docs\.github\.com|HTTP 422/);
    expect(approving.getState().status).toBe("ready");
    expect(approving.getState().receipt).toBeUndefined();

    const changes = new FakeGh();
    const requesting = session(changes);
    const changesState = await requesting.load(PR_URL);
    await requesting.preview(reviewInput(changesState, { event: "REQUEST_CHANGES", body: "This must change." }));
    changes.errorBodies.set("post", JSON.stringify({
      message: "Unprocessable Entity",
      errors: [{ resource: "PullRequestReview", code: "custom", field: "event", message: "Can not request changes on your own pull request" }],
    }));
    changes.failures.set("post", "gh: Unprocessable Entity (HTTP 422)");
    expect(await rejected(requesting.submit(reviewInput(changesState, { event: "REQUEST_CHANGES", body: "This must change." }))))
      .toBe("GitHub rejected the review: Unprocessable Entity — Can not request changes on your own pull request");
  });

  it("treats a rejected write as a fixable rejection, not as submitted", async () => {
    const { review, gh, state } = await loadedSession();
    await review.preview(reviewInput(state));
    gh.failures.set("post", "gh: Validation Failed (HTTP 422)");
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/HTTP 422/);
    expect(review.getState().status).toBe("ready");
    expect(review.getState().receipt).toBeUndefined();
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/Preview the review before submitting/);
    gh.failures.delete("post");
    await review.preview(reviewInput(state));
    expect((await review.submit(reviewInput(state))).status).toBe("submitted");
    expect(gh.callsFor("post")).toHaveLength(2);
  });
});

describe("connected review unknown writes and reconciliation", () => {
  async function unknownSession(): Promise<{ review: ConnectedReview; gh: FakeGh; state: ConnectedState }> {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    await review.preview(reviewInput(state));
    gh.failures.set("post", "gh timed out");
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/may or may not have created the review/);
    expect(review.getState().status).toBe("unknown");
    expect(review.getState().receipt).toBeUndefined();
    gh.failures.delete("post");
    return { review, gh, state };
  }

  it("marks an ambiguous write unknown and never retries it", async () => {
    const { review, gh, state } = await unknownSession();
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/unresolved/);
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/unresolved/);
    expect(gh.callsFor("post")).toHaveLength(1);
    expect(await rejected(review.load("https://github.com/octocat/hello/pull/9"))).toMatch(/unresolved/);
  });

  it("also treats a 5xx or unreadable answer as unknown", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    await review.preview(reviewInput(state));
    gh.failures.set("post", "gh: Server Error (HTTP 502)");
    expect(await rejected(review.submit(reviewInput(state)))).toMatch(/may or may not have created the review/);
    expect(review.getState().status).toBe("unknown");

    const offline = new FakeGh();
    const dropped = session(offline);
    const droppedState = await dropped.load(PR_URL);
    await dropped.preview(reviewInput(droppedState));
    offline.failures.set("post", "dial tcp: connection refused");
    expect(await rejected(dropped.submit(reviewInput(droppedState)))).toMatch(/may or may not have created the review/);
    expect(dropped.getState().status).toBe("unknown");

    const broken = new FakeGh();
    const second = session(broken);
    const secondState = await second.load(PR_URL);
    await second.preview(reviewInput(secondState));
    broken.postReply = "<html>proxy</html>";
    expect(await rejected(second.submit(reviewInput(secondState)))).toMatch(/cannot tell whether the review was created/);
    expect(second.getState().status).toBe("unknown");
  });

  it("treats an explicit HTTP 408 on the write as unresolved, not as rejected", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    const input = reviewInput(state);
    await review.preview(input);
    gh.failures.set("post", "gh: Request Timeout (HTTP 408)");
    expect(await rejected(review.submit(input))).toMatch(/may or may not have created the review/);
    expect(review.getState().status).toBe("unknown");
    expect(review.getState().receipt).toBeUndefined();
  });

  it("keeps a session unknown when reconciliation itself cannot read GitHub", async () => {
    const { review, gh } = await unknownSession();
    gh.failures.set("reviews", "dial tcp: connection refused");
    const message = await rejected(review.reconcile());
    expect(message).toMatch(/could not reach GitHub/);
    expect(message).not.toMatch(/nothing was changed|nothing was submitted/);
    expect(review.getState().status).toBe("unknown");
    expect(review.getState().receipt).toBeUndefined();
    // The identity read fails too, and that must not resolve or reassure either.
    gh.failures.delete("reviews");
    gh.failures.set("user", "gh: Bad credentials (HTTP 401)");
    expect(await rejected(review.reconcile())).toMatch(/not authenticated/);
    expect(review.getState().status).toBe("unknown");
  });

  it("resolves unknown only from an exact review found on GitHub", async () => {
    const { review, gh, state } = await unknownSession();
    gh.reviews = JSON.stringify([{
      id: 555,
      user: { login: "octocat", id: 42 },
      state: "COMMENTED",
      commit_id: state.snapshot?.headSha,
      body: "Please rename this.",
      html_url: "https://github.com/octocat/hello/pull/7#pullrequestreview-555",
    }]);
    gh.comments.set(555, JSON.stringify([
      { id: 1, path: "app.ts", line: 2, side: "RIGHT", body: "Rename this." },
      { id: 2, path: "app.ts", line: 1, side: "RIGHT", body: "Still here?" },
    ]));
    const reconciled = await review.reconcile();
    expect(reconciled.status).toBe("submitted");
    expect(reconciled.receipt).toEqual({
      id: 555,
      url: "https://github.com/octocat/hello/pull/7#pullrequestreview-555",
      state: "COMMENTED",
      commitId: state.snapshot?.headSha,
    });
    expect(gh.callsFor("post")).toHaveLength(1);
  });

  it("does not accept another author's review or a different payload as proof", async () => {
    const author = await unknownSession();
    // SAFETY: the captured POST body is the session's serialized ReviewPayload,
    // not external JSON; matching it leaves authorship as the only mismatch.
    const authorPayload = JSON.parse(author.gh.callsFor("post")[0].stdin) as ReviewPayload;
    author.gh.reviews = JSON.stringify([{
      id: 556, user: { login: "someone-else", id: 99 }, state: "COMMENTED",
      commit_id: author.state.snapshot?.headSha, body: authorPayload.body,
      html_url: "https://github.com/octocat/hello/pull/7#pullrequestreview-556",
    }]);
    author.gh.comments.set(556, JSON.stringify(authorPayload.comments));
    expect((await author.review.reconcile()).status).toBe("unknown");

    const payload = await unknownSession();
    payload.gh.reviews = JSON.stringify([{
      id: 557, user: { login: "octocat", id: 42 }, state: "COMMENTED",
      commit_id: payload.state.snapshot?.headSha, body: "Please rename this.",
      html_url: "https://github.com/octocat/hello/pull/7#pullrequestreview-557",
    }]);
    payload.gh.comments.set(557, JSON.stringify([
      { id: 1, path: "app.ts", line: 2, side: "RIGHT", body: "Rename this." },
      { id: 2, path: "app.ts", line: 1, side: "RIGHT", body: "Different text." },
    ]));
    expect((await payload.review.reconcile()).status).toBe("unknown");
  });

  it("does not accept a preexisting identical review as proof that this attempt landed", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    const input = reviewInput(state);
    const payload = await review.preview(input);
    const headSha = state.snapshot?.headSha;
    const url = (id: number): string => `https://github.com/octocat/hello/pull/7#pullrequestreview-${id}`;
    gh.comments.set(555, JSON.stringify(payload.comments));
    gh.comments.set(556, JSON.stringify(payload.comments));
    gh.reviews = JSON.stringify([
      { id: 555, user: { login: "octocat", id: 42 }, state: "COMMENTED", commit_id: headSha, body: payload.body, html_url: url(555) },
    ]);
    gh.failures.set("post", "gh timed out");
    expect(await rejected(review.submit(input))).toMatch(/may or may not have created the review/);
    gh.failures.delete("post");
    // The only matching review predates the attempt, so nothing is proven.
    expect((await review.reconcile()).status).toBe("unknown");
    expect(review.getState().receipt).toBeUndefined();
    // A review created by this attempt carries an id that did not exist before.
    gh.reviews = JSON.stringify([
      { id: 555, user: { login: "octocat", id: 42 }, state: "COMMENTED", commit_id: headSha, body: payload.body, html_url: url(555) },
      { id: 556, user: { login: "octocat", id: 42 }, state: "COMMENTED", commit_id: headSha, body: payload.body, html_url: url(556) },
    ]);
    const reconciled = await review.reconcile();
    expect(reconciled.status).toBe("submitted");
    expect(reconciled.receipt?.id).toBe(556);
    expect(reconciled.receipt?.url).toBe(url(556));
  });

  it("accepts a paginated review list and comment list", async () => {
    const gh = new FakeGh();
    const review = session(gh);
    const state = await review.load(PR_URL);
    const input = reviewInput(state);
    const payload = await review.preview(input);
    const headSha = state.snapshot?.headSha;
    const entry = (id: number) => JSON.stringify({ id, user: { login: "octocat", id: 42 }, state: "COMMENTED", commit_id: headSha, body: payload.body, html_url: `https://github.com/octocat/hello/pull/7#pullrequestreview-${id}` });
    gh.reviews = `[${entry(555)}]`;
    gh.failures.set("post", "gh timed out");
    await rejected(review.submit(input));
    gh.failures.delete("post");
    // Two pages of reviews, and the new review's comments split across pages.
    gh.reviews = `[${entry(555)}][${entry(556)}]`;
    gh.comments.set(556, `${JSON.stringify([payload.comments[0]])}${JSON.stringify([payload.comments[1]])}`);
    const reconciled = await review.reconcile();
    expect(reconciled.status).toBe("submitted");
    expect(reconciled.receipt?.id).toBe(556);
  });

  it("keeps an unresolved session unresolved when GitHub shows no matching review", async () => {
    const { review } = await unknownSession();
    const reconciled = await review.reconcile();
    expect(reconciled.status).toBe("unknown");
    expect(reconciled.receipt).toBeUndefined();
    expect(reconciled.message).toMatch(/will not resubmit/);
  });

  it("refuses to reconcile when no write is unresolved", async () => {
    const { review } = await loadedSession();
    await review.preview(reviewInput(review.getState()));
    expect(await rejected(review.reconcile())).toMatch(/nothing to reconcile/);
    expect(review.getState().status).toBe("ready");

    const empty = session(new FakeGh());
    expect(await rejected(empty.reconcile())).toMatch(/Load a pull request before reconciling/);
  });
});

describe("connected review gh failures", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["missing gh", "gh was not found", /was not found on PATH/],
    ["auth", "gh: Bad credentials (HTTP 401)", /not authenticated for github\.com/],
    ["authorization", "gh: Resource not accessible by integration (HTTP 403)", /not authorized for that repository/],
    ["missing pull request", "GraphQL: Could not resolve to a PullRequest with the number of 7.", /did not return that pull request/],
    ["unsupported gh", "Unknown JSON field: isCrossRepository", /does not support the flags diffninja needs/],
    ["server error", "gh: Server Error (HTTP 500)", /server error/],
    ["no network", "dial tcp: lookup api.github.com: no such host", /could not reach GitHub/],
  ];

  it("distinguishes missing, version, auth, and authorization failures", async () => {
    for (const [label, failure, pattern] of cases) {
      const gh = new FakeGh();
      gh.failures.set("user", failure);
      const review = session(gh);
      expect(await rejected(review.load(PR_URL)), label).toMatch(pattern);
      expect(review.getState().status).toBe("empty");
      expect(review.getState().identity).toBeUndefined();
      expect(review.getState().snapshot).toBeUndefined();
    }
    const old = new FakeGh();
    old.version = "2.40.1";
    expect(await rejected(session(old).load(PR_URL))).toMatch(new RegExp(`older than the supported ${MIN_GH_VERSION.replace(/\./g, "\\.")}`));

    const read = new FakeGh();
    read.failures.set("diff", "gh: Server Error (HTTP 500)");
    expect(await rejected(session(read).load(PR_URL))).toMatch(/server error/);
  });

  it("adds GitHub's own explanation to an authorization failure", async () => {
    const gh = new FakeGh();
    gh.errorBodies.set("user", JSON.stringify({ message: "Resource not accessible by integration" }));
    gh.failures.set("user", "gh: Resource not accessible by integration (HTTP 403)");
    const message = await rejected(session(gh).load(PR_URL));
    expect(message).toMatch(/not authorized for that repository/);
    expect(message).toMatch(/GitHub said: Resource not accessible by integration/);
  });

  it("never claims the pull request was untouched when a read fails", async () => {
    const failures: Array<[string, string]> = [
      ["gh timed out", "gh timed out"],
      ["HTTP 500", "gh: Server Error (HTTP 500)"],
      ["HTTP 408", "gh: Request Timeout (HTTP 408)"],
      ["network", "dial tcp: connection refused"],
      ["generic", "something went wrong"],
    ];
    for (const [label, failure] of failures) {
      const gh = new FakeGh();
      gh.failures.set("diff", failure);
      const message = await rejected(session(gh).load(PR_URL));
      expect(message, label).not.toMatch(/nothing was changed|nothing was submitted|untouched/);
      expect(message, label).toMatch(/did not complete|did not answer|unavailable|not supported|not found|authenticated|authorized/);
    }
  });
});

describe("connected review canonical diff validation", () => {
  async function problemFor(gh: FakeGh): Promise<string> {
    const { state } = await loadedSession(gh);
    expect(state.status).toBe("empty");
    return state.snapshot?.unavailableReason ?? "";
  }

  it("refuses binary, submodule, and unparsable diffs", async () => {
    const binary = new FakeGh();
    binary.diff = "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    binary.files = JSON.stringify([listedFile("logo.png", null)]);
    expect(await problemFor(binary)).toMatch(/binary files/);

    const link = new FakeGh();
    link.diff = [
      "diff --git a/tools b/tools", "index 1111111..2222222 160000", "--- a/tools", "+++ b/tools",
      "@@ -1 +1 @@", "-Subproject commit 1111111", "+Subproject commit 2222222", "",
    ].join("\n");
    link.files = JSON.stringify([listedFile("tools", "@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222")]);
    expect(await problemFor(link)).toMatch(/submodule or symbolic link/);

    const combined = new FakeGh();
    combined.diff = "diff --cc app.ts\n@@@ -1,1 -1,1 +1,1 @@@\n";
    expect(await problemFor(combined)).toMatch(/combined merge diff/);

    const html = new FakeGh();
    html.diff = "<!DOCTYPE html><html>Sign in</html>";
    expect(await problemFor(html)).toMatch(/HTML page instead of a diff/);

    const empty = new FakeGh();
    empty.diff = "";
    expect(await problemFor(empty)).toMatch(/empty diff/);

    const truncated = new FakeGh();
    truncated.diff = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,4 @@\n keep()\n-gone()\n";
    expect(await problemFor(truncated)).toMatch(/incomplete diff/);
  });

  it("refuses a diff that does not agree with the file list", async () => {
    const missing = new FakeGh();
    missing.files = JSON.stringify([listedFile("other.ts", APP_PATCH)]);
    expect(await problemFor(missing)).toMatch(/file list for the same pull request does not/);

    const unlisted = new FakeGh();
    unlisted.files = JSON.stringify([listedFile("app.ts", APP_PATCH), listedFile("extra.ts", "@@ -1 +1 @@\n-a\n+b")]);
    expect(await problemFor(unlisted)).toMatch(/file list includes extra.ts/);

    const truncatedPatch = new FakeGh();
    truncatedPatch.files = JSON.stringify([listedFile("app.ts", null)]);
    expect(await problemFor(truncatedPatch)).toMatch(/incomplete diff for app.ts/);

    const disagrees = new FakeGh();
    disagrees.files = JSON.stringify([listedFile("app.ts", "@@ -1,3 +1,4 @@ function run()\n keep()\n-gone()\n+added()\n+other()\n last()")]);
    expect(await problemFor(disagrees)).toMatch(/disagree about app.ts/);
  });

  it("handles added, deleted, renamed, and no-newline files", async () => {
    const gh = new FakeGh();
    gh.diff = [
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-goodbye",
      "diff --git a/from.txt b/to.txt",
      "similarity index 100%",
      "rename from from.txt",
      "rename to to.txt",
      "diff --git a/tail.txt b/tail.txt",
      "index 1111111..2222222 100644",
      "--- a/tail.txt",
      "+++ b/tail.txt",
      "@@ -1 +1 @@",
      "-almost",
      "\\ No newline at end of file",
      "+almost!",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    gh.files = JSON.stringify([
      listedFile("added.txt", "@@ -0,0 +1,2 @@\n+first\n+second"),
      listedFile("old.txt", "@@ -1,1 +0,0 @@\n-goodbye"),
      listedFile("to.txt", null, "from.txt"),
      listedFile("tail.txt", "@@ -1 +1 @@\n-almost\n\\ No newline at end of file\n+almost!\n\\ No newline at end of file"),
    ]);
    const { review, state } = await loadedSession(gh);
    expect(state.status).toBe("ready");
    expect(state.snapshot?.lines).toEqual([
      { path: "added.txt", line: 1, side: "RIGHT", text: "first", kind: "add" },
      { path: "added.txt", line: 2, side: "RIGHT", text: "second", kind: "add" },
      { path: "old.txt", line: 1, side: "LEFT", text: "goodbye", kind: "delete" },
      { path: "tail.txt", line: 1, side: "LEFT", text: "almost", kind: "delete" },
      { path: "tail.txt", line: 1, side: "RIGHT", text: "almost!", kind: "add" },
    ]);
    const accepted = await review.preview(reviewInput(state, {
      comments: [{ path: "old.txt", line: 1, side: "LEFT", body: "Deleting this breaks callers." }],
    }));
    expect(accepted.comments).toEqual([{ path: "old.txt", line: 1, side: "LEFT", body: "Deleting this breaks callers." }]);
    expect(await rejected(review.preview(reviewInput(state, {
      comments: [{ path: "to.txt", line: 1, side: "RIGHT", body: "a pure rename has no diff lines" }],
    })))).toMatch(/to\.txt:1 \(RIGHT\) does not match a line/);
  });

  it("accepts the canonical diff GitHub serves for real pull requests", async () => {
    const cli = new FakeGh();
    cli.owner = "cli";
    cli.repo = "cli";
    cli.number = 1;
    cli.diff = REAL_CLI_DIFF;
    cli.files = REAL_CLI_FILES;
    const first = session(cli);
    const cliState = await first.load("https://github.com/cli/cli/pull/1");
    expect(cliState.status).toBe("ready");
    expect(cliState.snapshot?.lines.length).toBeGreaterThan(50);
    expect(cliState.snapshot?.lines.every((line) => line.kind !== "delete")).toBe(true);

    const react = new FakeGh();
    react.owner = "react";
    react.repo = "react";
    react.number = 37662;
    react.diff = REAL_REACT_DIFF;
    react.files = REAL_REACT_FILES;
    const second = session(react);
    const reactState = await second.load("https://github.com/react/react/pull/37662");
    expect(reactState.status).toBe("ready");
    expect(reactState.snapshot?.lines.some((line) => line.kind === "context")).toBe(true);
  });
});
