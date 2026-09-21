# CLI reference

Full flag and behavior reference for the `diffninja` CLI. The README covers
the everyday flows; this page covers everything else.

## Inputs

```bash
# a PR link anywhere in argv opens a connected review (default)
diffninja https://github.com/OWNER/REPO/pull/123
diffninja --pr github.com/OWNER/REPO/pull/123/files
diffninja "Please review https://github.com/OWNER/REPO/pull/123"

# explicitly export the PR as an offline HTML report (JSON alongside it)
diffninja --static --mock https://github.com/OWNER/REPO/pull/123

# static inputs
diffninja --diff change.patch
git diff main...HEAD | diffninja --stdin
diffninja --repo /path/to/repo --from main --to HEAD

# options
diffninja --diff change.patch --out review.html   # JSON twin written beside it
diffninja --diff change.patch --mock             # offline demo, no API calls
diffninja --diff change.patch --open             # open the report when done
```

Rules:

- A PR link anywhere in argv takes precedence over diff/stdin/range inputs.
- `--pr` / `--pull-request` accept a link; `--static` (alias `--export`) opts
  out of connected mode. Different PR links in one invocation are rejected.
- Connected mode writes no report: `--out` requires `--static` with a PR link.
- `--mock` controls static judgments only; it does not bypass GitHub for PR
  inputs.
- `--connected` asserts that a PR link must be present, even if diff/range
  flags were also supplied. It conflicts with `--static`/`--export`.
- `PR 123`, a bare repository, and an issue URL are not PR targets:
  diffninja asks for exactly one full PR link and exits without loading
  anything. It never searches for or guesses the missing target.
- Use quoted arguments for pasted chat logs; `--stdin` reads a unified diff,
  not chat.

Live **static analysis** needs `TYPESAFE_API_KEY` in the environment (get one
at https://console.typesafe.ai). Connected reviews need authenticated `gh`,
not a TypeSafe key. Static mode writes `review.html` in the current directory
(or the `--out` path) plus a `.json` twin beside it, both mode `600`.

## `--open` platform behavior

`--open` is best effort and platform-specific: it runs `open` on macOS and
`xdg-open` everywhere else. Windows ships neither, so `--open` there prints
`could not open the browser` and exits 0 with the report already written — the
run always prints the `file:///…` URL and the JSON path. Open the HTML
yourself (`start "" review.html` in cmd.exe, `Start-Process .\review.html` in
PowerShell, or the printed URL); nothing in the report depends on an opener.

## Navigating the report

The HTML is one self-contained file: open it directly with `file://` or
`--open`. It makes no external requests and has no frontend dependencies. All
hunks start expanded; full diffs and native folding remain available with
JavaScript disabled. Light/dark colors follow your system preference.

- **Expand all / Collapse all** affect the currently visible hunks.
- **Status chips** show or hide attention, uncertain, low and passed hunks
  without changing their expanded state. Colors appear on hunk headers, left
  borders and navigation dots; no scores or assessment commentary appear in
  the HTML.
- **Focus** or a numbered badge isolates a hunk full-width. Use the **Report**
  breadcrumb or **Escape** to return to your previous folds and scroll
  position.
- **j/k** or **ArrowDown/ArrowUp** move the visible cursor; **Enter** toggles
  its hunk; **f** focuses it. Focused buttons and links retain native Enter
  behavior.
- **Jump to a hunk** opens its target; on small screens the jump list is a
  toolbar dropdown. Without JavaScript the ordinary anchor links remain
  visible.

Use **Diff | Call flow** to switch between source changes and their syntactic
call paths. Call flow files follow their most severe hunk, with a **View
diff** link to that hunk. The coverage count states how many changed files
have trees.

- **Tree** folds with native disclosure arrows. Click a function name to zoom
  into its subtree; **Source** opens the function definition.
- **Graph** opens at readable size in a bounded canvas. Drag or swipe to pan;
  use **− / +** to zoom, **Overview** to fit the shape, and **Readable** to
  reset around the selected function. A focused canvas supports arrow-key pan,
  **+ / −** zoom and **Home** reset. Ordinary wheel scrolling scrolls the
  page. Click a box to select it and inspect source without cropping the
  graph; its `+` control or a numbered edge focuses the receiver's branch.
  **Depth 1 / 2 / 3 / all** limits edges below that branch.
- **Sequence** shows root-to-leaf `A → B → C` chip strips, not runtime
  execution order. It displays up to 10 paths per file in the current focus.

Source is embedded when the report is generated, including resolved
definitions in files outside the diff. It comes from the immutable **to**
commit, or **from** for removed calls, with a path, line range, and commit
reference. Reports therefore contain unchanged code as well as changed hunks;
keep them private.

Only git-range inputs have repository call flows. Patch-only inputs show a
short git-range note, not invented diagrams. `callFlowAvailability`
distinguishes `available`, `needs-git-range`, `no-changes`, and `failed`.

A single note distinguishes mock and live output. Reasons, judgments,
warnings, priorities and request counts remain in the JSON twin; mock data is
only a navigation preview, not a code assessment. The live adapter pins
`jev-1.13.0`, retries transient failures up to twice, and uses a 10-second
attempt timeout inside a 30-second per-hunk budget. See
[the Jev audit](JEV_AUDIT.md) for sources, policy choices, and pricing.

## Connected GitHub reviews

Build locally, install [GitHub CLI](https://cli.github.com) **2.45.0 or
newer**, and authenticate separately:

```bash
gh auth login --hostname github.com
diffninja github.com/OWNER/REPO/pull/123
```

The CLI resolves the PR through `gh`, binds an ephemeral port on
`127.0.0.1`, prints its URL, and automatically opens the loaded review page.
Stop with Ctrl+C. URLs accept an omitted scheme, trailing slash, or trailing
paths such as `/files`. Missing `gh` or authentication fails before starting
a server and gives setup instructions; diffninja never asks for a token.

`serve` remains an advanced alias: with a PR link it follows the same
one-step flow; without one it opens an empty workspace (`--open` launches its
browser). One github.com PR and effective account are bound per session.

Connected mode is a human review workspace over the **canonical GitHub
patch**, not an upload facility for an existing HTML report. It does not call
a model or generate review prose. Select validated diff lines, write
single-line inline comments and a review body, choose Comment, Approve, or
Request changes, then preview the exact JSON payload before submitting.
GitHub enforces permissions: authentication does not establish write access.
GitHub rejects both Approve and Request changes on the authenticated user's
own PR; Comment remains available. The effective `gh api user` login is
displayed and checked again at submission.

The snapshot binds repository, PR, base/head SHAs, and a fingerprint of the
exact diff. Binary, incomplete, and unsupported patches (including submodules
and symlinks) cannot be submitted. Refresh after a snapshot mismatch: every
inline draft is preserved but must be explicitly confirmed against the
displayed current code or attached to a newly selected line before previewing
again. Review payloads include `commit_id`; GitHub has **no atomic "submit
only if head is unchanged"** operation, so a head change between the final
check and POST remains possible. The receipt identifies the actual reviewed
commit.

Only one submission can run at a time. A timeout or ambiguous write outcome
locks submission pending reconciliation against GitHub; absence of a matching
review is not proof that retry is safe. Recoverable failures preserve browser
drafts in per-tab `sessionStorage`. Closing the tab or stopping the server is
not a durable draft recovery system. Drafts contain source/review content;
treat the browser session as private.

Authentication is delegated entirely to `gh`: no diffninja token store, PAT
UI, or credential extraction. `GH_TOKEN` (and GitHub CLI's other environment
overrides) can override stored credentials.

The loopback server validates Host and Origin, requires a per-session CSRF
token on mutations, disables caching/framing, and serves a restrictive CSP.
Its only API routes are `GET /api/state` and `POST /api/load`,
`/api/preview`, `/api/submit`, `/api/reconcile`; none is a generic GitHub or
command proxy. The static `file://` report remains offline, cannot write to
GitHub, and never probes localhost.

Windows uses `rundll32.exe` to launch the default browser; macOS uses `open`,
Linux uses `xdg-open`. PR inputs automatically attempt browser launch; open
the printed URL manually if the desktop launcher is unavailable.

## MCP setup

`diffninja setup` registers the MCP server on every detected agent CLI:

```bash
npx -y diffninja setup [--cli claude,codex,omp,pi] [--dry-run]
diffninja setup --uninstall [--cli codex]
```

Supported CLIs: Claude Code (`~/.claude.json`), Codex
(`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when `CODEX_HOME` is
set), OMP (`~/.omp/agent/mcp.json`), pi (`~/.pi/agent/mcp.json`, needs
`pi-mcp-extension`). The setup installs the
package globally first so each entry points at a permanent `node` plus
`mcp-cli.js`; without a working global install it falls back to `npx`
entries (on Windows, npm's JS entry point run by `node`, since a client that
spawns without a shell cannot launch `npx.cmd`). `--dry-run` previews and
changes nothing, not even the global install; `--no-install` skips the global
install; `--uninstall` removes the entries. The API key is referenced from the
launching environment, never stored in the files.

## Install-time notes

Node `>=22.18` is required. From the npm registry (once `0.1.0` is
published): `npm install -g diffninja`. Both bins ship in the package:
`diffninja` (CLI) and `diffninja-mcp` (MCP server). On Windows, npm generates
`.cmd`, `.ps1` and shell shims per bin; if PowerShell blocks the `.ps1` shim,
call the `.cmd` form (`diffninja.cmd --help`) without changing the execution
policy.

- **Linux ARM64 needs a build toolchain at install time.**
  `tree-sitter-typescript@0.23.2` ships an x86-64 binary mislabeled as
  `linux-arm64`. Because it is an `optionalDependency`, that failure no longer
  aborts the install; a `postinstall` heal deletes the wrong-architecture
  prebuild and recompiles from source (`npm rebuild tree-sitter-typescript`
  with `CXXFLAGS='-std=c++20'`, which the Node 22+ headers require). Python
  and a C/C++ toolchain (build-essential) must be present while installing.
  Without them the heal only warns and TypeScript/TSX extraction falls back to
  the grammar cache.
- **Linux needs a recent libstdc++.** The `tree-sitter@0.25.1` Linux prebuild
  imports `GLIBCXX_3.4.31` (GCC 13.1+, i.e. libstdc++ from Ubuntu 24.04 or
  newer). `npm rebuild --prefix <installed diffninja> tree-sitter
  --build-from-source` rebuilds it against the host toolchain.
- **Grammar cache.** Git-range reviews install a missing grammar with npm
  into `CALLDIFF_GRAMMAR_CACHE` (default `~/.cache/calldiff/grammars`,
  `C:\Users\<you>\.cache\calldiff\grammars` on Windows). It writes there and
  needs the network; inline diff text never does. Preinstalling the same
  grammars keeps a review offline:

  ```bash
  export CALLDIFF_GRAMMAR_CACHE="$HOME/.cache/calldiff/grammars"
  npm install --prefix "$CALLDIFF_GRAMMAR_CACHE" --no-save --no-fund --no-audit \
    --legacy-peer-deps tree-sitter-python
  ```

  A grammar that cannot be installed is reported per file
  (`warn: failed to parse <file>`) and the review still runs on the diff and
  whatever call flows resolved. Some grammar packages have no prebuild for
  the running platform and compile with node-gyp on first use, which needs a
  C/C++ toolchain and Python.
