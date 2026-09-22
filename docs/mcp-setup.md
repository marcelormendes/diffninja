# MCP setup

`diffninja-mcp` is a stdio MCP server exposing exactly one tool,
`review_diff`. The process takes no arguments and reads/writes only JSON-RPC
on stdin/stdout, so the client must launch it directly — anything else
writing to its stdout corrupts the stream. It never writes report files; the
report comes back as the tool result. Use the CLI when you want HTML on disk.

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
`$CODEX_HOME/config.toml` when that variable is set. The
TypeSafe API key is never written into config files; each entry references it
from the environment that launches the CLI, so export `TYPESAFE_API_KEY` in
your shell for live reviews.

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
| `mock` | boolean | Offline fixture judgments for static analysis only. Ignored for connected reviews, which still read GitHub. |
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
- Live static analysis (no `mock`) requires `TYPESAFE_API_KEY` in the server
  process environment. There is no API key argument.
- Range reviews use the bundled `calldiff` engine for call flows; inline
  diffs report patch-only warnings instead, since full files are unavailable.
- `expectedOutcome` preserves both strings in `report.pr`. It supports source
  navigation and explicit intent limitations, not an automatic fulfillment
  verdict. Generated and author claims remain separately attributed.
- `referenceProject` compares selected unresolved-reference diagnostics between
  immutable snapshots, including unchanged consumers. It never installs or runs
  PR code; unsupported/incomplete checks are explicit. See
  [check boundaries](cli-reference.md#automatic-check-boundaries).

For static inputs, `structuredContent` **is** the `ReviewReport`, with
`content` carrying the same report as JSON text. For PR inputs, both carry
`{ "mode": "connected", "url": "http://127.0.0.1:PORT/", "pr":
"https://github.com/OWNER/REPO/pull/N", "snapshot": ... }`. Open `url` in a
browser; MCP does not launch one or submit a review itself. Pages live for
the MCP connection and close on disconnect. Failures return `isError: true`,
an error message, and no partial report.

## Call examples

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
`source` and `mode` (`live` or `mock`). Mock judgments are placeholders from
fixtures — they do not mean a hunk is safe.
The result also includes deterministic evidence, a short reading agenda, and
check coverage. Live Jev evaluation makes one HTTP attempt per evaluable hunk,
with a fixed-order typed question set and no retries or adaptive rounds.
Confidence does not rank hunks; stochastic judgments may differ between runs
without changing the deterministic evidence agenda.

Git-range call-flow analysis inherits calldiff's on-demand npm grammar
installation into `CALLDIFF_GRAMMAR_CACHE` (default
`~/.cache/calldiff/grammars`). This can write cache files and access npm even
with `mock: true`; the tool therefore advertises `readOnlyHint: false`,
although it does not edit repository source. For strictly offline reviews,
supply inline diff text or preinstall the required grammars (see
[cli-reference.md](cli-reference.md)).

## Per-client setup

### Claude Code

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

Claude Code expands `${VAR}` in an `env` value, so the entry references the
key from the environment that launched it rather than containing one. Drop
the `env` block for mock-only use. To add it to local or user scope instead:

```bash
claude mcp add --transport stdio diffninja \
  -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
```

Check it with `claude mcp list` or `/mcp`, then approve the project server on
first use. Live reviews need `TYPESAFE_API_KEY` exported in the shell that
starts Claude Code.

### Codex

`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when `CODEX_HOME` is set
(a project-local `.codex/config.toml` in a trusted project also works):

```toml
[mcp_servers.diffninja]
command = "node"
args = ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"]
env_vars = ["TYPESAFE_API_KEY"]   # forwarded from your shell; omit for mock-only
```

`env_vars` forwards a variable that is already set in the local environment,
so the key stays out of the file. Or:

```bash
codex mcp add diffninja -- node /absolute/path/to/diffninja/dist/review/mcp-cli.js
codex mcp list      # verify
```

The CLI form writes the same table without the forward, so add `env_vars` to
the entry (or edit the file) before running a live review; a mock-only setup
needs neither.

### OMP

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
rather than stored; drop the `env` block for mock-only. The same entry works
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
the tool as `mcp_diffninja_review_diff`. Live reviews need
`TYPESAFE_API_KEY` in the environment that launches pi. The extension is a
third-party package, not part of pi itself:
<https://pi.dev/packages/pi-mcp-extension>. Without the extension — or in a
harness with no MCP client at all — use the CLI, or wire a generic MCP
adapter you configure yourself.
