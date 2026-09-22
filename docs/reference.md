# Review reference

What `review_diff` returns, the limits of its checks, the connected review
workspace, setup, and install-time notes. diffninja runs inside an agent CLI
through MCP; tool arguments and call examples are in
[mcp-setup.md](mcp-setup.md).

## Report contents

A static review (diff text or a git range) returns one `ReviewReport`: the exact
expected outcome when supplied, intent cross-checks, a short reading agenda,
automatic findings, checked/not-checked scope, and every hunk with its status,
priority, reasons, and judgment. Navigation matches do not establish that an
author or generated claim is fulfilled.

Source is embedded in the report when it is generated, including resolved
definitions in files outside the diff. It comes from the immutable **to**
commit, or **from** for removed calls, with a path, line range, and commit
reference. Reports therefore contain unchanged code as well as changed hunks;
keep them private.

Git-range inputs have repository call flows. Patch-only inputs show a short git-range note, not
invented diagrams. `callFlowAvailability` distinguishes `available`,
`needs-git-range`, `no-changes`, and `failed`.

A single note distinguishes mock and live output. Hunk reasons, judgments,
warnings, priorities and HTTP request counts are fields of the report; mock
judgments are navigation fixtures, not a code assessment. The live adapter pins
`jev-1.13.0`: one HTTP attempt per evaluable hunk, a 10-second timeout, no retries,
no ensemble, and no adaptive context loop. Every question is a closed choice with
fixed options — one unordered outcome (changed, unchanged, unknown) and six
non-exclusive atomic properties — and no temperature override is sent. An answer
whose reported option did not hold a majority of its own distribution is recorded
as `unknown`, so a scattered answer is never reported as a finding; a missing,
malformed, or unasked answer fails that hunk closed. Confidence is informational
only; the deterministic
agenda is independent of stochastic model hunk ordering. See the
[analysis policy](../README.md#how-static-analysis-works).

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

The loopback server validates Host and Origin, requires a per-session CSRF
token on mutations, disables caching/framing, and serves a restrictive CSP.
Its only API routes are `GET /api/state` and `POST /api/load`,
`/api/preview`, `/api/submit`, `/api/reconcile`; none is a generic GitHub or
command proxy.

## Setup

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
