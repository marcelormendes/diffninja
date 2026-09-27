# MCP setup

`diffninja-mcp` is a stdio MCP server exposing `review_diff`, `finish_review`
(the agent's whole reading, and the only source of page links), and the update
tools `record_answers`, `record_order`, `suggest_comments`, and
`record_explanation`. The process takes no arguments and reads/writes only JSON-RPC
on stdin/stdout, so the client must launch it directly — anything else
writing to its stdout corrupts the stream. It never writes report files; the
report comes back as the tool result. This server is the only way to run a
review: the `diffninja` command only registers it (`diffninja setup`).

Point the client at the built entry point, absolute path required — from a
global install that is `"$(npm root -g)/diffninja/dist/review/mcp-cli.js"`,
from a checkout `/absolute/path/to/diffninja/dist/review/mcp-cli.js`:

```bash
node /absolute/path/to/diffninja/dist/review/mcp-cli.js
```

No install needed, the published package runs as an MCP command too:

```json
{ "command": "npx", "args": ["-y", "-p", "diffninja", "diffninja-mcp"] }
```

(`-p diffninja` selects the package; `diffninja-mcp` is the binary name. Pin
a version with `-p diffninja@0.1.0` when you want a fixed release.)

## One-command setup

```bash
npx -y diffninja setup
```

Detects Claude Code, Codex, OMP, and pi on your machine and registers the MCP
server in each one's user config. It installs the package globally first
(`npm install -g diffninja`) so the registration points at a permanent
binary; if that install fails it registers an `npx`-based entry instead and
tells you. Flags: `--cli claude,codex` to pick CLIs, `--dry-run` to preview
(no install, no writes), `--uninstall` to remove, `--no-install` to skip the
global install. Codex is written to `~/.codex/config.toml`, or to
`$CODEX_HOME/config.toml` when that variable is set. Entries carry no API key
or environment: reviews run locally, and pull requests reuse your `gh` session.
Re-running setup rewrites an entry from an older version that forwarded
`TYPESAFE_API_KEY`.

The sections below are the manual equivalents, one CLI at a time.

## `review_diff` arguments

| Argument | Type | Meaning |
|---|---|---|
| `mode` | `"auto"` / `"connected"` / `"static"` | Optional; defaults to auto. Connected requires a PR link; static treats diff/range strings literally and rejects pr/input. |
| `diff` | string | Inline unified diff text. Empty string is valid and yields an empty review. |
| `repo` | string | Absolute path to the git repository. Only valid together with `from` and `to`. |
| `from` | string | Base ref or commit for a range review. |
| `to` | string | Head ref or commit for a range review. Endpoints are compared directly, not the merge base. |
| `pr` | string | GitHub PR link; starts a connected review. |
| `input` | string | Free text containing a GitHub PR link; starts a connected review. |
| `expectedOutcome` | `{ "title": string, "description": string }` | Exact, untrusted expected-outcome metadata for static analysis. Links here never select a PR. |
| `referenceProject` | string | Static git range only: repository-relative tsconfig for opt-in diagnostics using the trusted installed TypeScript compiler. |

Rules enforced by the schema and the tool:

- In `auto` (default) or `connected`, a GitHub PR link in `diff`, `repo`,
  `from`, `to`, `pr`, or `input` selects connected mode before static input
  validation. Different links in one call are rejected. Expected-outcome text
  is never interpreted as a target.
- `connected` requires a link even when a valid or empty diff is supplied.
  It rejects `expectedOutcome` and `referenceProject`: GitHub supplies connected
  metadata, and reference checking belongs to static analysis.
- `static` never navigates links in source text; `pr` and `input` are
  rejected.
- For static analysis, provide **exactly one** input: `diff`, or `from`
  **and** `to`. `repo` is accepted only for a range review and must be an
  absolute path.
- Static analysis is local: no model, no API key, no network for inline diffs.
- Range reviews use the bundled `calldiff` engine for call flows; inline
  diffs report patch-only warnings instead, since full files are unavailable.
- `expectedOutcome` preserves both strings in `report.pr`. It supports source
  navigation and explicit intent limitations, not an automatic fulfillment
  verdict. Generated and author claims remain separately attributed.
- `referenceProject` compares selected unresolved-reference diagnostics between
  immutable snapshots, including unchanged consumers. It never installs or runs
  PR code; unsupported/incomplete checks are explicit. See
  [check boundaries](reference.md#automatic-check-boundaries).

For static inputs, `structuredContent` **is** the `ReviewReport` plus
`reportUrl` and `reviewId`, with `content` carrying the same object as JSON
text. The report's `questions` ask the agent's own model about specific hunks
(see [`record_answers`](#record_answers)). `reportUrl`
is a read-only `127.0.0.1` page with the same report for the human reviewer;
it lives in memory for this MCP connection (see
[the report page](reference.md#the-report-page)). For PR inputs, both carry
`{ "mode": "connected", "url": "http://127.0.0.1:PORT/", "pr":
"https://github.com/OWNER/REPO/pull/N", "snapshot": ... }` plus the local
analysis of that snapshot: `reviewId`, `reportUrl`, `analysisScope` (whether a
local clone given as `repo` supplied call flows), and `report`, whose
`questions` are answered with `record_answers` like a static review's. Open `url` in a
browser; MCP does not launch one or submit a review itself. Pages live for
the MCP connection and close on disconnect. Failures return `isError: true`,
an error message, and no partial report.

## `record_answers`

diffninja calls no model. Judgments that need meaning rather than syntax are
asked of the agent that requested the review, as `questions` in the static
result: does a hunk change what callers or users observe, does a test in (or
outside) the diff exercise it, does a test change weaken what it checks, does
changed documentation match the code, does a hunk serve the stated goal. Each
question is bound to hunks and has a closed set of options that always includes
`cannot-tell`; at most 36 are asked, earliest hunks first, none about import-only hunks.

| Argument | Type | Meaning |
| --- | --- | --- |
| `reviewId` | string | The `reviewId` a static `review_diff` result returned on this connection. |
| `answers` | array | 1–100 `{ "questionId": "q1", "choice": "cannot-tell" }` objects, each choice one of that question's options. No free text. |

The whole call is refused, keeping nothing, if any answer names an unknown
question, repeats one, or uses an option the question does not list. A later
answer replaces an earlier one. Answers appear on the report page beside their
hunk, attributed to the MCP client that recorded them (its own name and
version, not a model identity), and never change any status, priority, or the
order. The result is `{ reviewId, recorded, answered, unanswered, reportUrl }`.

```json
{ "reviewId": "4f1c…", "answers": [{ "questionId": "q1", "choice": "changes-behavior" }, { "questionId": "q2", "choice": "cannot-tell" }] }
```

## The business explanation (`explanation`, `record_explanation`)

Call flows and hunks name code; a reviewer new to that part of the product
needs to know what it does. So the agent that requested the review writes a
business explanation, and diffninja only checks and draws it (it calls no
model). Every `review_diff` result lists `functions`: each function a reader
meets around the hunks and in the call flows, once, with a stable id
`<defining file>#<name>` (at most 40, product code before tests; calls with no
definition in the repository, such as library calls, are not listed).

`finish_review` takes it as `explanation` (required for a pull request review,
optional for a static report); `record_explanation` `{ reviewId, explanation }`
replaces it later. The object is strict:

| Field | Meaning |
| --- | --- |
| `functions` | `{ id, purpose }` for **every** listed function, each once: one plain sentence (≤200 characters) on what it does for the business or its users. |
| `processes` | 1–4 business flows the change touches: `{ title, steps }`, 2–16 steps each. A step is `{ id, kind, text, change, detail?, before?, functions?, hunks?, next? }`: `kind` is `start`, `action`, `decision` (two or more exits, each with a short `when` such as `yes`), or `end`; `change` is `added`, `changed`, `removed`, or `unchanged`; `before` (changed steps only) says how it worked before; `functions` and `hunks` name listed function ids and `items[].id`s; an action without `next` continues to the step listed after it. |
| `rules` | At most 12 business rules `{ text, change, before?, hunks? }`; a `changed` rule must say what it was `before`. |

Every text is one line of plain prose within its bound: no Markdown, and
nothing that reads like code (a call such as `charge(`, a snake_case name, a
source path, backticks). Any problem refuses the whole call and keeps the
previous explanation. The report page then opens on **How it works**: each
process as a flowchart with new, changed, and removed steps highlighted, a
numbered step list with each step's rule, its former behavior, and the purpose
of the functions that carry it out, and the rules as before and after. In the
call flows every explained call shows its purpose above its code name, and
library-only calls fold away behind a checkbox. The pull request page shows the
same flowcharts under the goal and tags each hunk with the steps and rules that
name it. All of it is attributed to the MCP client that sent it.

## Call examples

```json
{ "mode": "connected", "input": "Please review github.com/OWNER/REPO/pull/123/files" }
```

```json
{ "mode": "static", "diff": "--- a/checkout.ts\n+++ b/checkout.ts\n@@ -1 +1 @@\n-old()\n+new()\n" }
```

```json
{ "repo": "/absolute/path/to/repo", "from": "HEAD~1", "to": "HEAD" }
```

Every static result carries each hunk's status, priority, reasons, and local
change facts (each `yes` with the changed line it rests on), plus deterministic
evidence, a short reading agenda, and check coverage. Nothing is sent anywhere,
and the same input always gives the same result. The facts point at what to
read; interpreting what the change means is up to you and your agent.

Git-range call-flow analysis inherits calldiff's on-demand npm grammar
installation into `CALLDIFF_GRAMMAR_CACHE` (default
`~/.cache/calldiff/grammars`). This can write cache files and access npm; the
tool therefore advertises `readOnlyHint: false`,
although it does not edit repository source. For strictly offline reviews,
supply inline diff text or preinstall the required grammars (see
[reference.md](reference.md#install-time-notes)).

## Per-client setup

### Claude Code

Project scope, committed as `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "diffninja": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"]
    }
  }
}
```

To add it to local or user scope instead:

```bash
claude mcp add --transport stdio diffninja \
  -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
```

Check it with `claude mcp list` or `/mcp`, then approve the project server on
first use.

### Codex

`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when `CODEX_HOME` is set
(a project-local `.codex/config.toml` in a trusted project also works):

```toml
[mcp_servers.diffninja]
command = "node"
args = ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"]
```

Or:

```bash
codex mcp add diffninja -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
codex mcp list      # verify
```

### OMP

OMP reads MCP servers natively. Project file `.omp/mcp.json`:

```json
{
  "mcpServers": {
    "diffninja": {
      "command": "node",
      "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"]
    }
  }
}
```

`type` defaults to `stdio`. The same entry works
in the user file `~/.omp/agent/mcp.json`, or
`~/.omp/profiles/<name>/agent/mcp.json` under a named profile. Manage it
in-session with `/mcp add`, `/mcp list`, `/mcp test diffninja`, and
`/mcp reload` after editing JSON. Details are in the OMP MCP configuration
guide:
<https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md>.

### pi

pi's core has no built-in MCP client; MCP support comes from the
`pi-mcp-extension` package:

```bash
pi install npm:pi-mcp-extension
```

Add the server to `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json`
(project, overrides global per server):

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
the tool as `mcp_diffninja_review_diff`. The extension is a
third-party package, not part of pi itself:
<https://pi.dev/packages/pi-mcp-extension>. Without the extension — or in a
harness with no MCP client at all — wire a generic MCP adapter you configure
yourself; diffninja has no terminal review mode.
