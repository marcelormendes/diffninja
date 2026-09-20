# diffninja

Focused PR reviews: paste a GitHub PR link to open a connected, human-authored
review workspace. No separate server command is needed.

Without a PR link, diffninja keeps its static analysis workflow: paste a diff
or point at a git range, and Jev ranks the changes in a navigable report.
Assessment details stay in the JSON sidecar, not in the review interface.

Two front ends:

- `diffninja` — the CLI. PR links load GitHub and open a loopback review page;
  diff/range inputs write an HTML report plus a JSON twin.
- `diffninja-mcp` — a stdio MCP server exposing `review_diff`. PR links return
  a loopback review URL; diff/range inputs return the report without files.

## How static analysis works

1. **Deterministic checks first.** No-op hunks, blank-only doc changes, and
   oversized hunks are settled in code without calling any model. Oversized
   hunks go to manual review, never truncated, never auto-passed.
2. **One Jev judgment per hunk.** TypeSafe's Jev answers four typed questions
   about impact scope, visible bug likelihood, change category and missing
   context together. No generated prose.
3. **Ranked in code.** Answers are combined with weights into a 0-100 priority
   and sorted into attention / uncertain / low / passed. Uncertain calls fail
   closed to human review instead of degrading into a pass.

For static analysis, both front ends return the same `ReviewReport`: `items` (per-hunk status,
priority, reasons, judgment), `callFlow` (ASCII assessment context), `callFlows`
(structured per-file trees), `callFlowAvailability`, `warnings`, `modelCalls`,
`mode`, `source`, `createdAt`, `title`.

## Why structured judgment instead of an LLM review

Pasting a diff into a chat model and asking "review this" produces prose:
verbose, different on every run, and impossible to trust programmatically.
diffninja takes a different path. Jev is TypeSafe's System One model: it
does not generate text. Each hunk gets one call carrying four typed
questions (impact scope, visible bug likelihood, change category, missing
context), and the answers come back as numbers and categories only.

| Standard LLM code review | diffninja |
|---|---|
| Writes paragraphs of feedback | Returns typed signal; ranking, ordering and colors are computed in code |
| Confidently approves what it does not understand | Uncertainty is a first-class route: low confidence or a split vote fails closed to `uncertain`, never degrades into a pass |
| The "rubric" is buried in a prompt and the model's mood | Every threshold is a constant: weights, gates, gray bands, rubrics — tunable and calibratable against real review outcomes |
<<<<<<< HEAD
| Cannot be unit-tested | Regression tests cover the deterministic pipeline and review boundaries |
=======
| Cannot be unit-tested | The review test suite pins the pipeline's behavior |
>>>>>>> ded18fb (docs: document first npm release and platform limitations)
| Reads untrusted diff text as a prompt, open to injection | State is treated as untrusted code, and only numbers cross the boundary — no generated prose ever enters the HTML, JSON or MCP result |
| Chatty, slow, expensive per review | One small structured judgment call per hunk |

The trade-off is deliberate: there are no prose explanations by design.
Reasons are fixed templates filled with the returned numbers, so the
report reads like an ordinary PR review with color guiding attention.
The model does triage silently in the background; the human remains the
reviewer.

## Install

`diffninja@0.1.0` is packaged for the npm registry but **not published yet**:
the release pipeline, the npm-side trusted-publisher configuration and the
bootstrap step that has to happen first are documented in
[docs/npm-release.md](docs/npm-release.md). The npm commands below are the
install this release is built for — they start working once `0.1.0` is on the
registry. Until then, build the checkout and use the absolute path of the built
entry point, as shown further down.

Node `>=22.18` is required in every case.

### npm install (once a release is published)

```bash
# macOS / Linux
npm install -g diffninja
diffninja --help                 # CLI: writes review.html plus its JSON twin
```

```powershell
# Windows PowerShell
npm install -g diffninja
diffninja --help                 # npm writes diffninja.cmd, diffninja.ps1 and a shell shim
```

Both bins ship in the package: `diffninja` (the CLI) and `diffninja-mcp` (the
MCP server). npm generates three Windows shims per bin — `.cmd`, `.ps1` and a
shell script — so a host whose PowerShell execution policy blocks `.ps1` can
call the `.cmd` form instead (`npm.cmd install -g diffninja`, then
`diffninja.cmd --help`) without changing the policy. Point MCP clients at the
server with `node` plus the absolute path of its entry point; the server speaks
JSON-RPC on stdin/stdout only, so a client launches it and no shell wrapper is
involved.

### What the tarball contains, and what npm installs

`files` in `package.json` limits the package to `dist/**/*.js` and
`dist/**/*.d.ts`, plus `package.json`, `README.md` and `LICENSE`. `src`, `test`,
`scripts`, `tsconfig.json`, `vitest.config.ts` and the lockfile stay out of the
tarball.

TypeScript/TSX and JavaScript grammar support is therefore a normal npm
dependency, not something copied into the tarball: `tree-sitter@^0.25.1` and
`tree-sitter-typescript@^0.23.2` are `dependencies`, so npm installs them from
the registry beside diffninja, and `tree-sitter-javascript@0.23.1` arrives as
tree-sitter-typescript's own dependency. npm's `bundleDependencies` (the field
that would inline a `node_modules` directory into the published package) is not
used, and the packed tarball contains no `node_modules` at all. Grammars for
every other language are fetched on demand into the grammar cache described
below.

JavaScript's transitive package is not guaranteed to be directly resolvable by
the loader: npm can nest it beneath `tree-sitter-typescript`. In that layout,
JavaScript/JSX also falls back to the on-demand grammar cache. Windows users
should preinstall `tree-sitter-javascript` there when reviewing JavaScript,
using the `npm.cmd` cache recipe below; TypeScript/TSX is a direct dependency.

### From this checkout (works today)

```bash
git clone https://github.com/marcelormendes/diffninja.git
cd diffninja
npm install
npm run build   # tsc -> dist/
```

The `bin` entries in `package.json` (`diffninja`, `diffninja-mcp`) describe what
the installed package exposes. Without an install, use
`node /absolute/path/to/diffninja/dist/review/cli.js` and
`node /absolute/path/to/diffninja/dist/review/mcp-cli.js` instead of the bare
commands.

### Absolute paths for MCP client configuration

Client configs need an absolute `node` path and an absolute path to the server
entry point; `npm root -g` prints the global `node_modules` directory, so no
path has to be guessed:

| Platform | `node` | server entry point |
|---|---|---|
| macOS / Linux | `command -v node` — typically `/usr/local/bin/node` or `/usr/bin/node` | `npm root -g` (typically `/usr/local/lib/node_modules`) + `/diffninja/dist/review/mcp-cli.js` |
| Windows | `where.exe node` — typically `C:\Program Files\nodejs\node.exe` | `npm root -g` (normally `%APPDATA%\npm\node_modules`) + `\diffninja\dist\review\mcp-cli.js` |

On macOS and Linux the shell can assemble both halves, which is also the quickest
way to see whether the install landed:
`node "$(npm root -g)/diffninja/dist/review/mcp-cli.js"` (it then waits for
JSON-RPC on stdin).

On PowerShell, discover and print a JSON-safe server configuration:

```powershell
$node = node -p "process.execPath"
$entry = Join-Path (npm.cmd root -g) "diffninja\dist\review\mcp-cli.js"
@{ command = $node; args = @($entry) } | ConvertTo-Json
```

Use those literal absolute paths in the client's `command` and `args`; JSON
backslashes must be escaped. Recompute them after changing Node managers or npm
prefixes. If PowerShell blocks npm's `.ps1` shim, use `npm.cmd install -g diffninja`
and `diffninja.cmd --help`; no execution-policy change is needed.

For a checkout instead of a global install, replace the tail with
`/absolute/path/to/diffninja/dist/review/mcp-cli.js`; the examples in the client
setups below use that form.

Install-time caveats for both paths:

- **Direct dependencies and the peer warning.** The grammar packages diffninja
  installs declare an *optional* peer of an older parser
  (`tree-sitter-typescript@0.23.2` wants `tree-sitter@^0.21.0`,
  `tree-sitter-javascript@0.23.1` wants `^0.21.1`) while diffninja depends on
  `^0.25.1`. npm's documented behavior for a conflicting
  peer is to resolve it against the nearest non-peer dependency and warn, so a
  global install prints `ERESOLVE overriding peer dependency` and still installs
  0.25.1. In that layout `npm ls` exits 1 with `ELSPROBLEMS`, marking the peer
  ranges invalid. A local project install resolves the same conflict the other
  way: it adds a second, older `tree-sitter@0.21.1` next to diffninja's 0.25.1,
  and that copy has no Linux ARM64 or Windows ARM64 prebuild, so installing it
  there needs a build toolchain. The repository's own `overrides` entry does not
  help consumers: npm honors `overrides` only from the root `package.json`. The
  fix belongs upstream as a widened peer range, so do not paper over it with
  consumer `--force` or `--legacy-peer-deps` flags.
- **Linux ARM64 is not supported.** `tree-sitter-typescript@0.23.2` and
  `tree-sitter-javascript@0.23.1` ship x86-64 code under
  `prebuilds/linux-arm64/`: the file is byte-identical to the x64 one and its ELF
  header reads `Advanced Micro Devices X86-64`, so TypeScript/TSX and JavaScript
  call-flow extraction cannot load on ARM64 Linux even though the file exists.
  The release pipeline therefore gates Linux x64, macOS x64, macOS ARM64 and
  Windows x64, and Linux ARM64 has no supported path until the upstream packages
  ship corrected artifacts. Evidence and the upstream fix are in
  [docs/npm-release.md](docs/npm-release.md).
- **Linux needs a recent libstdc++.** The `tree-sitter@0.25.1` Linux prebuild
  imports `GLIBCXX_3.4.31` (GCC 13.1+, i.e. libstdc++ from Ubuntu 24.04 or
  newer), so the same binary fails at first use on older distributions instead of
  at install time. `npm rebuild --prefix <installed diffninja> tree-sitter
  --build-from-source` rebuilds it against the host toolchain.
- **Grammar cache.** Git-range reviews install a missing grammar with
  `npm install --prefix <cache> --no-save --no-fund --no-audit
  --legacy-peer-deps <grammar>` into `CALLDIFF_GRAMMAR_CACHE`, which defaults to
  `~/.cache/calldiff/grammars` (`C:\Users\<you>\.cache\calldiff\grammars` on
  Windows). It writes there and needs the network; inline diff text never does.
  Preinstalling the same grammars the same way keeps a review offline and makes
  the first call predictable:

  ```bash
  export CALLDIFF_GRAMMAR_CACHE="$HOME/.cache/calldiff/grammars"
  npm install --prefix "$CALLDIFF_GRAMMAR_CACHE" --no-save --no-fund --no-audit \
    --legacy-peer-deps tree-sitter-python
  ```

  ```powershell
  # Windows: call npm.cmd, and match the runtime's exact pins where it has one
  $cache = "D:\diffninja-grammar-cache"     # any writable path; spaces are fine
  npm.cmd install --prefix "$cache" --no-save --no-fund --no-audit --legacy-peer-deps tree-sitter-python
  $env:CALLDIFF_GRAMMAR_CACHE = $cache
  ```

  The runtime pins two specs, so a manual preinstall must match them:
  `tree-sitter-c-sharp@0.23.1` and
  `@tree-sitter-grammars/tree-sitter-lua@0.2.0`; everything else installs at its
  latest version. **On Windows the automatic path does not work at all**: the
  runtime launches `npm` directly (`execFileSync("npm", …)`) and Node cannot
  start a `.cmd`/`.bat` shim without a shell, so that install fails. A grammar
  already present in the cache is loaded from disk without npm ever running, so
  the `npm.cmd` preinstall above is the workaround for Windows reviewers. Some
  grammar packages also have no prebuild for the running platform and compile
  with node-gyp on first use, which needs a C/C++ toolchain and Python:
  `tree-sitter-perl@2.0.0` and `tree-sitter-kotlin@0.3.8` ship none,
  `@tree-sitter-grammars/tree-sitter-lua@0.2.0` ships no Linux ARM64 or Windows
  ARM64 prebuild. A grammar that cannot be installed is reported per file
  (`warn: failed to parse <file>`) and the review still runs on the diff and
  whatever call flows resolved; `callFlowAvailability` is `"failed"` only when
  the analysis itself throws. See the MCP section for the `readOnlyHint`
  consequence.
- **Reports are private.** They embed source code, including unchanged code, so
  keep them out of shared directories.

## CLI usage

```bash
# open a connected GitHub review automatically
node /absolute/path/to/diffninja/dist/review/cli.js https://github.com/OWNER/REPO/pull/123

# PR links may also appear in flags or pasted text
node /absolute/path/to/diffninja/dist/review/cli.js --pr github.com/OWNER/REPO/pull/123/files
node /absolute/path/to/diffninja/dist/review/cli.js "Please review https://github.com/OWNER/REPO/pull/123"

# explicitly export the PR as an offline HTML report (JSON alongside it)
node /absolute/path/to/diffninja/dist/review/cli.js --static --mock https://github.com/OWNER/REPO/pull/123

# review a diff file
diffninja --diff change.patch

# review piped diff text
git diff main...HEAD | diffninja --stdin

# review a git range directly
diffninja --repo /path/to/repo --from main --to HEAD

# choose output (JSON is written next to the HTML)
diffninja --diff change.patch --out review.html

# offline demo, no API calls
diffninja --diff change.patch --mock

# open the report in the browser when done
diffninja --diff change.patch --open
```

For the shorthand examples above, replace `diffninja` with
`node /absolute/path/to/diffninja/dist/review/cli.js`.
Static mode writes `review.html` in the current directory (or the `--out` path)
plus a `.json` twin beside it, both mode `600`.

A PR link anywhere in argv takes precedence over diff/stdin/range inputs.
`--pr` and `--pull-request` accept a link; `--static` (alias `--export`) opts
out of connected mode. Different PR links in one invocation are rejected.
Connected mode writes no report: `--out` requires `--static` with a PR link.
`--mock` controls static judgments only; it does not bypass GitHub for PR inputs.

For automation, `--connected` asserts that a PR link must be present, even if
diff/range flags were also supplied. It conflicts with `--static`/`--export`.
Use quoted arguments for pasted chat logs; `--stdin` reads a unified diff, not
chat. `PR 123`, `o PR do auth`, a bare repository, and an issue URL are not PR
targets: diffninja asks for exactly one full PR link and exits without loading
anything. It never searches for or guesses the missing target.

Prose around a link is data, not executable instructions or an intent override.
“Just show me the diff” can use the connected page without writing or submitting
a review. Static analysis/export requires explicit inputs/flags.

Live **static analysis** needs `TYPESAFE_API_KEY` in the environment (get one at
https://console.typesafe.ai). Connected reviews need authenticated `gh`, not a
TypeSafe key. Reports contain source code; keep them private.
Static analysis never approves, blocks, or merges anything. Connected mode below
can submit a review only after the human writes it, previews it, and presses Submit.

`--open` is best effort and platform-specific: it runs `open` on macOS and
`xdg-open` everywhere else. Windows ships neither, so `--open` there prints
`could not open the browser` and exits 0 with the report already written — the
run always prints the `file:///…` URL and the JSON path. Open the HTML yourself
(`start "" review.html` in cmd.exe, `Start-Process .\review.html` in PowerShell,
or the printed URL); nothing in the report depends on an opener.

### Navigating the report

The HTML is one self-contained file: open it directly with `file://` or `--open`
(on Windows use the printed `file:///…` path — see the CLI caveat above).
It makes no external requests and has no frontend dependencies. All hunks start
expanded; full diffs and native folding remain available with JavaScript disabled.
Light/dark colors follow your system preference.

- **Expand all / Collapse all** affect the currently visible hunks.
- **Status chips** show or hide attention, uncertain, low and passed hunks without
  changing their expanded state. Colors appear on hunk headers, left borders and
  navigation dots; no scores or assessment commentary appear in the HTML.
- **Focus** or a numbered badge isolates a hunk full-width. Use the **Report**
  breadcrumb or **Escape** to return to your previous folds and scroll position.
- **j/k** or **ArrowDown/ArrowUp** move the visible cursor; **Enter** toggles its
  hunk; **f** focuses it. Focused buttons and links retain native Enter behavior.
- **Jump to a hunk** opens its target; on small screens the jump list is a toolbar
  dropdown. Without JavaScript the ordinary anchor links remain visible.

Use **Diff | Call flow** to switch between source changes and their syntactic
call paths. Call flow files follow their most severe hunk, with a **View diff**
link to that hunk. The coverage count states how many changed files have trees.

- **Tree** folds with native disclosure arrows. Click a function name to zoom
  into its subtree; **Source** opens the function definition.
- **Graph** opens at readable size in a bounded canvas. Drag or swipe to pan;
  use **− / +** to zoom, **Overview** to fit the shape, and **Readable** to reset
  around the selected function. A focused canvas supports arrow-key pan,
  **+ / −** zoom and **Home** reset. Ordinary wheel scrolling scrolls the page.
  Click a box to select it and inspect source without cropping the graph; its
  `+` control or a numbered edge focuses the receiver's branch.
  **Depth 1 / 2 / 3 / all** limits edges below that branch. “All” means retained
  nodes, not an unbounded repository graph.
- **Sequence** shows root-to-leaf `A → B → C` chip strips, not runtime execution
  order. It displays up to 10 paths per file in the current focus; focusing a
  branch can reveal paths outside the initial ten.

The mode tabs reveal the same selected function, expanding its Tree ancestors.
Returning to Graph preserves its pan and zoom. Mode changes add no breadcrumbs.
Click a visited-function breadcrumb to return and discard later visits;
cross-file receivers show their file in the trail. **Escape** closes source
details first, then returns to all files. Without JavaScript, all modes and
Sequence paths remain available, with native-size graphs scrolling locally.
Changed nodes use their file's most severe hunk color, not an independent
assessment of the function. Status marks
`+`, `−`, and `~` mean added, removed, and a retained caller containing structural
changes below it. Unchanged calls are dimmed but retain all navigation and source
controls. Edge numbers identify retained syntactic calls, not execution order.

Source is embedded when the report is generated, including resolved definitions
in files outside the diff. It comes from the immutable **to** commit, or **from**
for removed calls, with a path, line range, and commit reference. Missing files,
invalid ranges, and unresolved definitions show an unavailable-source note, never
a guessed body. One-line descriptions quote attached source comments/docstrings
only; functions without them get no description. No source is fetched by the
browser. Reports therefore contain unchanged code as well as changed hunks;
keep them private.

Trees come directly from calldiff's `DiffNode` results, never from ASCII or
generated explanations. Nodes carry `key`, `label`, `status`, `children`, optional
call-site `file`/`line`/`endLine`, resolved `source`, and a comment-derived
`description` when present. Per-file limits: **8 roots, 4 edges deep
(root at depth zero), 8 children per node plus up to 8 extra cross-file callees,
160 total nodes**. Pruning favors branches reaching that file and changed calls,
retaining source order. A
`truncated` flag records serialization cuts; the engine also stops expanding
at depth 4. Caller/callee context can cross file boundaries. Files without text
hunks or engine trees have no structured entry.

Only git-range inputs have repository call flows, including runs with `--mock`
judgments. Patch-only inputs show a short git-range note, not invented diagrams.
`callFlowAvailability` distinguishes `available`, `needs-git-range`,
`no-changes`, and `failed`. Missing paths, dynamic calls, parse failures, depth
limits and non-call body changes mean these diagrams cannot establish safety.
Without JavaScript both views and all three diagram modes are server-rendered;
native folding still works.

See [the outcome check](docs/OUTCOME_CHECK.md) for the five-file walkthrough,
design cuts, and verification limits.

A single note distinguishes mock and live output. Reasons, judgments, warnings,
priorities and request counts remain in the JSON twin; mock data is only a
navigation preview, not a code assessment.

The live adapter pins `jev-1.13.0`, retries transient failures up to twice, and uses
a 10-second attempt timeout inside a 30-second per-hunk budget. `modelCalls`
counts all attempted HTTP requests, including retries; failed judgments stay
`uncertain`. See [the Jev audit](docs/JEV_AUDIT.md) for sources, policy choices,
pricing and the limits of offline verification.

## Connected GitHub reviews (default for PR links)

Build locally, install [GitHub CLI](https://cli.github.com) **2.45.0 or newer**,
and authenticate separately:

```bash
gh auth login --hostname github.com
node /absolute/path/to/diffninja/dist/review/cli.js github.com/OWNER/REPO/pull/123
```

The CLI resolves the PR through `gh`, binds an ephemeral port on `127.0.0.1`,
prints its URL, and automatically opens the loaded review page. Stop with Ctrl+C.
URLs accept an omitted scheme, trailing slash, or trailing paths such as `/files`.
Missing `gh` or authentication fails before starting a server and gives setup
instructions; diffninja never asks for a token.

`serve` remains an advanced alias: with a PR link it follows the same one-step
flow; without one it opens an empty workspace (`--open` launches its browser).
One github.com PR and effective account are bound per session. Start a new
session for another PR or another completed review. There is no automatic PR
selection or creation, and fork reviews target the base repository's PR.

Connected mode is a human review workspace over the **canonical GitHub patch**,
not an upload facility for an existing HTML report. It does not call a model or
generate review prose. Select validated diff lines, write single-line inline
comments and a review body, choose Comment, Approve, or Request changes, then
preview the exact JSON payload before submitting. GitHub enforces permissions:
authentication does not establish write access. GitHub rejects both Approve and
Request changes on the authenticated user's own PR; Comment remains available.
The effective `gh api user` login is displayed and checked again at submission.

The snapshot binds repository, PR, base/head SHAs, and a fingerprint of the
exact diff. Binary, incomplete, and unsupported patches (including submodules
and symlinks) cannot be submitted. Refresh after a snapshot mismatch: every
inline draft is preserved but must be explicitly confirmed against the displayed
current code or attached to a newly selected line before previewing again.
Review payloads include `commit_id`; GitHub has **no atomic “submit only if head is
unchanged”** operation, so a head change between the final check and POST remains
possible. The receipt identifies the actual reviewed commit.

Only one submission can run at a time. A timeout or ambiguous write outcome
locks submission pending reconciliation against GitHub; absence of a matching
review is not proof that retry is safe. Do not open another session to blindly
retry an uncertain write. Recoverable failures preserve browser drafts in
per-tab `sessionStorage` (memory only if storage is unavailable). Closing the tab
or stopping the server is not a durable draft or uncertain-write recovery system.
Drafts contain source/review content; treat the browser session as private.

Authentication is delegated entirely to `gh`: no diffninja token store, PAT UI,
or credential extraction. `GH_TOKEN` (and GitHub CLI's other environment
overrides) can override stored credentials. GitHub CLI may store credentials
in plaintext when an OS credential store is unavailable; diffninja makes no
stronger storage guarantee. Backend calls are noninteractive, bounded, and use
executable argument arrays, with JSON on stdin rather than shell interpolation.

The loopback server validates Host and Origin, requires a per-session CSRF token
on mutations, disables caching/framing, and serves a restrictive CSP. Its only
API routes are `GET /api/state` and `POST /api/load`, `/api/preview`,
`/api/submit`, `/api/reconcile`; none is a generic GitHub or command proxy.
Local malicious processes and browser extensions are outside this boundary.
The static `file://` report remains offline, cannot write to GitHub, and never
probes localhost. MCP PR inputs return a connected page with the same safeguards.

Windows uses `rundll32.exe` to launch the default browser; macOS uses `open`,
Linux uses `xdg-open`. PR inputs automatically attempt browser launch; open the
printed URL manually if the desktop launcher is unavailable.

## MCP server: the `review_diff` tool

MCP is the recommended way to hand diff review to a coding agent. The server
speaks MCP over stdio and exposes exactly one tool. Point the client at the
built entry point, absolute path required — from a global install that is
`"$(npm root -g)/diffninja/dist/review/mcp-cli.js"`, and from a checkout it is:

```bash
node /absolute/path/to/diffninja/dist/review/mcp-cli.js
```

The process takes no arguments. It reads and writes only JSON-RPC on
stdin/stdout, so the client must launch it directly — anything else writing to
its stdout corrupts the stream. It never writes report files; the report comes
back as the tool result. Use the CLI when you want HTML on disk.

### Why MCP rather than a skill or a hybrid

| | Skill (agent shells out to `diffninja`) | MCP server (`review_diff`) |
|---|---|---|
| Discovery | Client has to know the CLI exists; the tool surface is prose in a skill file | Client lists `review_diff` from the server at connect time |
| Arguments | Agent assembles flags by hand; nothing validates them before the process starts | Validated against the strict tool schema before any review runs |
| Result | Free-form stdout plus an HTML report in the working directory and its JSON twin, which the agent must find and parse | One typed call; `structuredContent` is the `ReviewReport` object |
| Version drift | Skill text and CLI flags can diverge silently | One versioned interface; a wrong argument fails loudly |
| Setup cost | Works with any client that has a shell | Needs client MCP support (or an MCP adapter — no such adapter ships here) |
| Side effects | Writes `review.html` (or `--out`) plus the JSON twin | No report files; git ranges may populate calldiff's grammar cache |

Git-range call-flow analysis inherits calldiff's on-demand npm grammar
installation into `CALLDIFF_GRAMMAR_CACHE` (default `~/.cache/calldiff/grammars`).
This can write cache files and access npm even with `mock: true`; the tool
therefore advertises `readOnlyHint: false`, although it does not edit repository
source. For strictly offline reviews, supply inline diff text or preinstall
the required grammars. Mock always disables TypeSafe calls. On Windows that
automatic install never runs (the runtime cannot start npm's `.cmd` shim), so
preinstalling with `npm.cmd` as shown in the install caveats is the only way to
get call flows for languages whose grammar is not a package dependency.

A hybrid (skill for review conventions, MCP for the call) only helps if you
want agent-side playbooks on top of the tool; it is not needed to run reviews.
The skill path remains viable, but it is the weaker contract.

Mid-workflow, ask your assistant: “Use diffninja to review my current changes,
then inspect the highest-priority hunks.” It can collect `git diff` (or
`git diff --cached`) and call `review_diff` with the text, or send an explicit
commit range. The MCP tool is discovered automatically after connection; no
`/super-review` skill installation is required. A slash skill would offer a
memorable explicit trigger, but its installation and shell permissions vary
by client.

The CLI already writes structured JSON, so a CLI-backed skill would need
little new executable code. MCP adds the SDK, a stdio entry point, and schema
validation, but calls the same shared report service and existing pipeline
directly. A hybrid adds skill distribution and instruction maintenance on top
of that. The MCP binary and CLI ship in the same npm package/version; there
is no separately versioned skill whose flag examples can go stale.

### Set up: Claude Code

Project scope, committed as `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "diffninja": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```

Claude Code expands `${VAR}` in an `env` value, so the entry references the key
from the environment that launched it rather than containing one. Drop the
`env` block for mock-only use. To add it to local or user scope instead:

```bash
claude mcp add --transport stdio diffninja \
  -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
```

Check it with `claude mcp list` or `/mcp`, then approve the project server on
first use. Everything after `--` is the server command. Live reviews need
`TYPESAFE_API_KEY` exported in the shell that starts Claude Code.

### Set up: Codex

`~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.diffninja]
command = "node"
args = ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"]
env_vars = ["TYPESAFE_API_KEY"]   # forwarded from your shell; omit for mock-only
```

`env_vars` forwards a variable that is already set in the local environment, so
the key stays out of the file. Or add it with the CLI:

```bash
codex mcp add diffninja -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
codex mcp list      # verify
```

The CLI form writes the same table without the forward, so add `env_vars` to
the entry (or edit the file) before running a live review; a mock-only setup
needs neither.

`/mcp` inside the TUI lists the connected server.

### Set up: OMP

OMP reads MCP servers natively. Project file `.omp/mcp.json`:

```json
{
  "mcpServers": {
    "diffninja": {
      "command": "node",
      "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"],
      "env": { "TYPESAFE_API_KEY": "TYPESAFE_API_KEY" }
    }
  }
}
```

`type` defaults to `stdio`, and an `env` value that names an environment
variable is resolved from the launching environment, so the key is referenced
rather than stored; drop the `env` block for mock-only. The same entry works in
the user file `~/.omp/agent/mcp.json`, or `~/.omp/profiles/<name>/agent/
mcp.json` under a named profile. OMP also discovers Claude Code, Codex and
Gemini CLI configs, so a server configured for those clients appears
automatically. Manage it in-session with `/mcp add`, `/mcp list`,
`/mcp test diffninja`, and `/mcp reload` after editing JSON — OMP has no `mcp`
shell subcommand. Details, including the env-resolution rules and the
per-server fields, are in the OMP MCP configuration guide:
<https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md>. The
JSON schema for editor validation is
`https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json`.

### Set up: pi

pi's core has no built-in MCP client; MCP support comes from the
`pi-mcp-extension` package:

```bash
pi install npm:pi-mcp-extension
```

Add the server to `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project,
overrides global per server):

```json
{
  "mcpServers": {
    "diffninja": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"],
      "lifecycle": "lazy"
    }
  }
}
```

The extension adds a `transport` field and a `lifecycle` (`lazy` starts the
server on `/mcp:start diffninja`, `eager` at session start), and it prefixes
the tool as `mcp_diffninja_review_diff`. Live reviews need `TYPESAFE_API_KEY`
in the environment that launches pi. The extension is a third-party package,
not part of pi itself: <https://pi.dev/packages/pi-mcp-extension>. A pi-derived
harness that reads a `.pi` config root still needs it; OMP's own loader does
not read `.pi` paths. Without the extension — or in a harness with no MCP
client at all — use the CLI, or wire a generic MCP adapter you configure
yourself.

### `review_diff` arguments

| Argument | Type | Meaning |
|---|---|---|
| `mode` | `"auto"` / `"connected"` / `"static"` | Optional; defaults to auto. Connected requires a PR link; static treats diff/range strings literally and rejects pr/input. |
| `diff` | string | Inline unified diff text. Empty string is valid and yields an empty review. |
| `repo` | string | Absolute path to the git repository. Only valid together with `from` and `to`. |
| `from` | string | Base ref or commit for a range review. |
| `to` | string | Head ref or commit for a range review. Endpoints are compared directly, not the merge base. |
| `pr` | string | GitHub PR link; starts a connected review. |
| `input` | string | Free text containing a GitHub PR link; starts a connected review. |
| `mock` | boolean | Offline fixture judgments for static analysis only. Ignored for connected reviews, which still read GitHub. |

Rules enforced by the schema and the tool:

- In `auto` (default) or `connected`, a GitHub PR link in **any input string field**
  selects connected mode before static input validation. The same PR reuses its
  page within one MCP connection; different links in one call are rejected.
- `connected` requires a link even when a valid or empty diff is supplied.
  Missing context returns an error before gh, git, or TypeSafe access.
- `static` never navigates links in source text; `pr` and `input` are rejected.
- In `auto`, `pr` and `input` must contain a PR link. Without one, only explicit
  diff/range inputs can enter static analysis.
- For static analysis, provide **exactly one** input: `diff`, or `from` **and** `to`.
  `repo` is accepted only for a range review and must be an absolute path.
- Live static analysis (no `mock`) requires `TYPESAFE_API_KEY` in the server process
  environment. There is no API key argument.
- Range reviews use the bundled `calldiff` engine for call flows; inline diffs
  report patch-only warnings instead, since full files are unavailable.

For static inputs, `structuredContent` **is** the `ReviewReport`, with `content`
carrying the same report as JSON text. For PR inputs, both carry
`{ "mode": "connected", "url": "http://127.0.0.1:PORT/", "pr": "https://github.com/OWNER/REPO/pull/N", "snapshot": ... }`.
Open `url` in a browser; MCP does not launch one or submit a review itself.
Pages live for the MCP connection and close on disconnect. The server writes
no report files and reserves stdout for the protocol.
Failures return `isError: true`, an error message, and no partial report.

### Call examples

```json
{ "mode": "connected", "input": "Please review github.com/OWNER/REPO/pull/123/files" }
```

```json
{ "mode": "static", "diff": "--- a/checkout.ts\n+++ b/checkout.ts\n@@ -1 +1 @@\n-old()\n+new()\n" }
```

```json
{ "repo": "/absolute/path/to/repo", "from": "main", "to": "HEAD", "mock": true }
```

```json
{ "repo": "/absolute/path/to/repo", "from": "HEAD~1", "to": "HEAD" }
```

The last one is live: it sends the changed hunks and matching call flows to
TypeSafe and needs `TYPESAFE_API_KEY`. In static mode the report carries
`source` (`MCP inline diff`, the diff path, `Standard input`, or the ref pair)
and `mode` (`live` or `mock`). Mock judgments are placeholders from fixtures —
they do not mean a hunk is safe.

### Natural language and assistant limits

For a PR request, assistants should pass `mode: "connected"` with the user's
actual link and open the returned `url`. If context is missing, ask for the link;
do not invent a URL or replace the PR with an empty diff. For intentional
diff/range analysis, use `mode: "static"` so URLs in code remain source data.
Input `mode` is routing intent; report `mode` remains `live` or `mock`.

The server validates the call it receives. It cannot force an external assistant
to call a tool, recover omitted conversation context, or distinguish a plausible
invented URL from one the user actually supplied. Host-side tool policy and
checking the displayed PR identity remain necessary.

Jev is deliberately **not** in the invocation path. Typed judgments constrain
output shape, not factual identity; adding a classifier would disclose pasted
text and add cost/latency without proving which PR was intended. Jev remains in
static hunk triage. See [the UX analysis](docs/natural-language-ux.md) for options,
ambiguity policy, prerequisites, and safety boundaries.

Client configuration above follows the official docs: Claude Code
(<https://code.claude.com/docs/en/mcp>), Codex
(<https://developers.openai.com/codex/mcp>), OMP
(<https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md>), and pi
(<https://pi.dev/packages/pi-mcp-extension>).

## Also bundled: calldiff

This repo is a fork. The call-flow diff engine underneath — its `diff`, `tree`
and `reach` operations, reached from TypeScript rather than from a shell command
(no `calldiff` binary is installed by this package) — comes from
[calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq Kancharla,
MIT licensed (see LICENSE). diffninja uses its call graphs to show which flows
each hunk touches. For development the forked entry point is still runnable from
a checkout: `node dist/cli.js --help`.

## Dev

```bash
npm run build   # tsc -> dist/
npm run lint    # oxlint
npm test        # vitest run
npm run dev -- --diff examples/review/checkout.patch --mock
npm test -- test/review-*.test.ts  # review contracts without the forked engine suite

# packaging: build, pack, then install the tarball into a throwaway prefix
# and exercise the published surface (bins, mock review, native grammars, MCP)
mkdir -p dist-pack
npm pack --pack-destination dist-pack
node scripts/verify-package.mjs dist-pack
```

For development, launch from the checkout so Node can resolve `tsx`:
`node --import tsx src/review/mcp-cli.ts`. Client setups running from another
directory should use the built absolute path above.

Releases, the npm trusted-publisher configuration and the native prebuild
matrix are covered in [docs/npm-release.md](docs/npm-release.md); that page is
also where the current state — prepared, not published — is stated.
