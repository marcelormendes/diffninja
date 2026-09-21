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

Rules enforced by the schema and the tool:

- In `auto` (default) or `connected`, a GitHub PR link in **any input string
  field** selects connected mode before static input validation. Different
  links in one call are rejected.
- `connected` requires a link even when a valid or empty diff is supplied.
- `static` never navigates links in source text; `pr` and `input` are
  rejected.
- For static analysis, provide **exactly one** input: `diff`, or `from`
  **and** `to`. `repo` is accepted only for a range review and must be an
  absolute path.
- Live static analysis (no `mock`) requires `TYPESAFE_API_KEY` in the server
  process environment. There is no API key argument.
- Range reviews use the bundled `calldiff` engine for call flows; inline
  diffs report patch-only warnings instead, since full files are unavailable.

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

`~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

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
