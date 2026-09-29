# Review reference

What `review_diff` returns, the limits of its checks, the connected review
workspace, setup, and install-time notes. diffninja runs inside an agent CLI
through MCP; tool arguments and call examples are in
[mcp-setup.md](mcp-setup.md).

## Report contents

A static review (diff text or a git range) returns one `ReviewReport`: the exact
expected outcome when supplied, intent cross-checks, a short reading agenda,
automatic findings, checked/not-checked scope, and every hunk with its status,
priority, reasons, and lexical facts. Agent answers remain separately
attributed. Navigation matches do not establish that an
author or generated claim is fulfilled.

## The report page

`finish_review` returns `reportUrl` only after accepting the agent's complete
reading. It is a read-only `127.0.0.1` page serving that report as one
self-contained HTML document.
Once the agent sent a business explanation, the page opens on **How it
works**: its processes as flowcharts with new, changed, and removed steps
highlighted, a step list with each step's rule and the functions behind it,
and the business rules as before and after.
It makes no external requests and has no frontend dependencies. Hunks
start folded; full diffs and native folding remain available with JavaScript
disabled. Light/dark colors follow your system preference.

- **Expand all / Collapse all** affect the currently visible hunks.
- **Status chips** show or hide attention, uncertain, low and passed hunks
  without changing their expanded state. Colors appear on hunk headers, left
  borders and navigation dots. Priorities and reasons stay in the
  tool result; the Outcome view shows deterministic evidence and its limits.
- **Focus** or a numbered badge isolates a hunk full-width. Use the **Report**
  breadcrumb or **Escape** to return to your previous folds and scroll
  position.
- **j/k** or **ArrowDown/ArrowUp** move the visible cursor; **Enter** toggles
  its hunk; **f** focuses it. Focused buttons and links retain native Enter
  behavior.
- **Jump to a hunk** opens its target; on small screens the jump list is a
  toolbar dropdown. Without JavaScript the ordinary anchor links remain
  visible.

Use **Outcome | Call flow | Diff** to switch views. Outcome leads with exact
expected-outcome metadata, intent cross-checks, the first five reading tasks,
automatic findings, and checked/not-checked scope. Source cards fold natively;
their file, line range, and snapshot identify the evidence. Navigation matches
do not establish that an author or generated claim is fulfilled. Agenda links
clear filters/focus when needed so their target cannot remain hidden.

Call flow files follow their most severe hunk, with a **View diff** link to that
hunk. The coverage count states how many changed files have trees.

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
  Graph and Sequence DOM is materialized on first use; the complete tree and diff
  remain available without JavaScript.

The page belongs to the agent's MCP connection: it is served from memory, never
written to disk, and stops when the agent exits. Each report has its own
256-bit URL token; a connection keeps its 20 most recent reports. The server
answers only `GET /report/<token>`, rejects any other Host, forbids caching and
framing, and allows the inline script and stylesheet only by their SHA-256
hashes. The URL carries source code access: do not share it.

Source is embedded in the report when it is generated, including resolved
definitions in files outside the diff. It comes from the immutable **to**
commit, or **from** for removed calls, with a path, line range, and commit
reference. Reports therefore contain unchanged code as well as changed hunks;
keep them private.

Git-range inputs have repository call flows. Patch-only inputs show a short git-range note, not
invented diagrams. `callFlowAvailability` distinguishes `available`,
`needs-git-range`, `no-changes`, and `failed`.

Hunk reasons, local change facts (each `yes` with the changed line it rests
on), warnings, and priorities are fields of the report. The analysis is local
and deterministic: no AI model is called and the same input gives the same
report. Facts point at what to read; they are not a verdict. See
[how the analysis works](how-it-works.md).

### Automatic-check boundaries

Duplicate-body and unread-`errors` checks operate on supported JS/TS syntax,
with bounded candidate and excerpt counts. A finding is a source observation,
not a runtime defect verdict. Unknown bindings, dynamic calls, and unsupported
syntax remain unproven. The report lists check coverage and limitations.

The optional reference checker runs the repository's **trusted installed**
TypeScript compiler against immutable before/after trees. It does not run PR
scripts, install dependencies, emit code, or change the checkout. It compares
only diagnostics 2304, 2305, 2307, 2339, 2503, 2551, 2552, and 7016, subtracting
pre-existing errors even when lines moved; unchanged consumers can be findings.
Both revisions use the current installed dependencies, not historical installs.

Missing dependencies, unsupported project references or escaping configurations,
and exceeded bounds produce **not checked**, not a pass. Bounds include 50,000
files, 8 MiB per file, 512 MiB total snapshot content, and at most 500 selected
diagnostics per revision. This is not a project build, test run, or safety proof.

## Connected GitHub reviews

Install [GitHub CLI](https://cli.github.com) **2.45.0 or newer** and
authenticate separately (`gh auth login --hostname github.com`). Then give your
agent a pull request link; it calls `review_diff`, which resolves the PR
through `gh`, binds an ephemeral port on `127.0.0.1`, and returns the loaded
review page URL. URLs accept an omitted scheme, trailing slash, or trailing
paths such as `/files`. Missing `gh` or authentication fails before starting a
server and gives setup instructions; diffninja never asks for a token. Pages
belong to the agent's MCP connection: repeated calls for one PR reuse its page,
and every page closes when the agent disconnects.

Connected mode is a human review workspace over the **canonical GitHub
patch**. It does not call
a model or generate review prose. Select validated diff lines, write
single-line inline comments and a review body, choose Comment, Approve, or
Request changes, then preview the exact JSON payload before submitting.
GitHub enforces permissions: authentication does not establish write access.
GitHub rejects both Approve and Request changes on the authenticated user's
own PR; Comment remains available. The effective `gh api user` login is
displayed and checked again at submission.

The snapshot binds repository, PR, base/head SHAs, exact title and description,
and a fingerprint of the exact diff. Metadata edits invalidate it too. Binary,
incomplete, and unsupported patches (including submodules
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

Every route of the loopback server lives under an unguessable path,
`http://127.0.0.1:PORT/<64 hex characters>/`, which only the link the agent
hands you contains: another program or user on the same machine that finds the
port gets a 404 for everything and cannot read the pull request or post a
review as you. On top of that the server validates Host and Origin, requires a
per-session CSRF token on mutations, disables caching/framing, and serves a
CSP with a fresh nonce per response. Its only API routes are
`GET api/state`, `GET api/analysis` and `POST api/load`, `api/preview`,
`api/submit`, `api/reconcile` under that path; none is a generic GitHub or
command proxy. At most ten of these pages stay open per agent connection; the
oldest closes and reviewing its pull request again opens a fresh one.

## Setup

`diffninja setup` registers the MCP server on every detected agent CLI:

```bash
npx -y diffninja@latest setup [--cli claude,codex,omp,pi] [--dry-run]
diffninja setup --uninstall [--cli codex]
```

Supported CLIs: Claude Code (`~/.claude.json`), Codex
(`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when `CODEX_HOME` is
set), OMP (`~/.omp/agent/mcp.json`), pi (`~/.pi/agent/mcp.json`, needs
`pi-mcp-extension`). The setup installs the
package globally first (`diffninja@<its version>`) so each entry points at a
permanent `node` plus `mcp-cli.js`, and updates a global install older than
itself to its own version (never downgrading a newer one); without a working
global install it falls back to `npx` entries pinned to its version (on Windows, npm's JS entry point run by `node`, since a client that
spawns without a shell cannot launch `npx.cmd`). `--dry-run` previews and
changes nothing, not even the global install; `--no-install` skips installing or
updating the global package; `--uninstall` removes the entries. No API key is required or stored
in the configuration.

## Install-time notes

Node `>=22.18` is required. From the npm registry (once `0.1.0` is
published): `npm install -g diffninja`. Both bins ship in the package:
`diffninja` (setup only) and `diffninja-mcp` (MCP server). On Windows, npm generates
`.cmd`, `.ps1` and shell shims per bin; if PowerShell blocks the `.ps1` shim,
call the `.cmd` form (`diffninja.cmd setup`) without changing the execution
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
- **Grammars.** Call flows read JavaScript and TypeScript with grammars that
  ship in the package. Every other language needs its tree-sitter grammar,
  and a review never downloads one: run `diffninja grammars install` once, with
  the diffninja version your agent runs (a review's warning prints the exact
  `npx -y diffninja@<version> grammars install`; a cache another version's lock
  installed is not read, so `@latest` can install grammars an older server
  ignores). It installs 20 exact versions
  (18 usable at once, see `--build` below) with `npm ci --ignore-scripts` from a lock that ships with diffninja (the
  sha512 of every tarball, dependencies included, is checked, and no package
  runs an install script) into `~/.cache/diffninja/grammars`
  (`C:\Users\<you>\.cache\diffninja\grammars` on Windows; `DIFFNINJA_GRAMMAR_CACHE`
  moves it), a private directory diffninja trusts only if it wrote it for this
  lock and it belongs to you with no other user able to write to it (not checked
  on Windows). `diffninja grammars status` shows what is installed. Kotlin and Perl
  grammars ship no prebuilt binary: `diffninja grammars install --build`
  compiles them on your machine and needs Python and a C/C++ toolchain. A
  review without a grammar still runs on the diff, and its warnings name the
  grammars its call flows skipped. Source files over 1 MiB and files beyond the
  first 15,000 of a revision are left out of call flows, and the review says so.
