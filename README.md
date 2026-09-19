# diffninja

Focused PR reviews. Jev reads the diff behind the scenes; you review only what
matters.

Paste a diff (or point at a git range) and diffninja returns a navigable PR-style
report: full diffs, line numbers, and color cues for where to start. Assessment
details stay in the JSON sidecar, not in the review interface.

Two front ends share one engine:

- `diffninja` — the CLI. Writes an HTML report plus a JSON twin.
- `diffninja-mcp` — a stdio MCP server exposing one tool, `review_diff`, for
  coding agents. Writes no report files; the report is the tool result.

## How it works

1. **Deterministic checks first.** No-op hunks, blank-only doc changes, and
   oversized hunks are settled in code without calling any model. Oversized
   hunks go to manual review, never truncated, never auto-passed.
2. **One Jev judgment per hunk.** TypeSafe's Jev answers four typed questions
   about impact scope, visible bug likelihood, change category and missing
   context together. No generated prose.
3. **Ranked in code.** Answers are combined with weights into a 0-100 priority
   and sorted into attention / uncertain / low / passed. Uncertain calls fail
   closed to human review instead of degrading into a pass.

Both front ends return the same `ReviewReport`: `items` (per-hunk status,
priority, reasons, judgment), `callFlow` (ASCII assessment context), `callFlows`
(structured per-file trees), `callFlowAvailability`, `warnings`, `modelCalls`,
`mode`, `source`, `createdAt`, `title`.

## Local build first

This checkout is not published by this work: the package is `private` and both
`diffninja` and `diffninja-mcp` are absent from the npm registry as of this
writing, so the setup below builds the checkout and points clients at the
absolute path of the built entry point. The `bin` entries in `package.json`
(`diffninja`, `diffninja-mcp`, `calldiff`) describe what an install would
expose; until a release exists, use `node /absolute/path/to/diffninja/dist/...`
instead of a bare command. If the package does get published, a client entry
can shell out to the installed binary the same way.

```bash
git clone https://github.com/marcelormendes/diffninja.git
cd diffninja
npm install
npm run build   # tsc -> dist/
```

Node `>=22.18` is required.

## CLI usage

```bash
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

Replace `diffninja` with `node dist/review/cli.js` when running from an
unpublished checkout. The CLI writes `review.html` in the current directory
(or the `--out` path) plus a `.json` twin beside it, both mode `600`.

Live mode needs `TYPESAFE_API_KEY` in the environment (get one at
https://console.typesafe.ai). Reports contain source code, keep them private.
diffninja never approves, blocks, or merges anything. A human still owns the
decision.

### Navigating the report

The HTML is one self-contained file: open it directly with `file://` or `--open`.
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

## MCP server: the `review_diff` tool

MCP is the recommended way to hand diff review to a coding agent. The server
speaks MCP over stdio and exposes exactly one tool. Point the client at the
built entry point, absolute path required:

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
the required grammars. Mock always disables TypeSafe calls.

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
| `diff` | string | Inline unified diff text. Empty string is valid and yields an empty review. |
| `repo` | string | Absolute path to the git repository. Only valid together with `from` and `to`. |
| `from` | string | Base ref or commit for a range review. |
| `to` | string | Head ref or commit for a range review. Endpoints are compared directly, not the merge base. |
| `mock` | boolean | Offline fixture judgments for this call only. Not a real Jev review. |

Rules enforced by the schema and the tool:

- Provide **exactly one** input: `diff`, or `from` **and** `to` together.
- `repo` is accepted only for a range review and must be an absolute path.
- Live mode (no `mock`) requires `TYPESAFE_API_KEY` in the server process
  environment. There is no API key argument.
- Range reviews use the bundled `calldiff` engine for call flows; inline diffs
  report patch-only warnings instead, since full files are unavailable.

Returns a tool result whose `structuredContent` **is** the `ReviewReport`, with
`content` carrying the same report as JSON text. Failures (ambiguous input, a
missing repo, a live call with no key) come back as a tool error with
`isError: true` and no partial report.

### Call examples

```json
{ "diff": "--- a/checkout.ts\n+++ b/checkout.ts\n@@ -1 +1 @@\n-old()\n+new()\n" }
```

```json
{ "repo": "/absolute/path/to/repo", "from": "main", "to": "HEAD", "mock": true }
```

```json
{ "repo": "/absolute/path/to/repo", "from": "HEAD~1", "to": "HEAD" }
```

The last one is live: it sends the changed hunks and matching call flows to
TypeSafe and needs `TYPESAFE_API_KEY`. In every mode the report carries
`source` (`MCP inline diff`, the diff path, `Standard input`, or the ref pair)
and `mode` (`live` or `mock`). Mock judgments are placeholders from fixtures —
they do not mean a hunk is safe.

Client configuration above follows the official docs: Claude Code
(<https://code.claude.com/docs/en/mcp>), Codex
(<https://developers.openai.com/codex/mcp>), OMP
(<https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md>), and pi
(<https://pi.dev/packages/pi-mcp-extension>).

## Also bundled: calldiff

This repo is a fork. The call-flow diff engine (`calldiff diff|tree|reach`)
comes from [calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq
Kancharla, MIT licensed (see LICENSE). diffninja uses its call graphs to show
which flows each hunk touches.

## Dev

```bash
npm run build   # tsc -> dist/
npm run lint    # oxlint
npm test        # vitest run
npm run dev -- --diff examples/review/checkout.patch --mock
npm test -- test/review-*.test.ts  # review contracts without the forked engine suite
```

For development, launch from the checkout so Node can resolve `tsx`:
`node --import tsx src/review/mcp-cli.ts`. Client setups running from another
directory should use the built absolute path above.
