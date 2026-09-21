# diffninja

PR reviews for humans, not prose from a chatbot. Give diffninja a GitHub PR
link and it opens a review workspace where you read the diff, write inline
comments, and submit the review yourself. Feed it a diff or a git range and it
returns a ranked HTML report that tells you where to look first.

Under the hood, TypeSafe's Jev model triages every hunk silently in the
background. It never writes review text. You stay the reviewer.

## What you need

- **Node.js 22.18 or newer.**
- **GitHub CLI (`gh`) 2.45.0+, authenticated** (`gh auth login`) — only for
  reviewing pull requests. diffninja never asks for a token; it reuses your
  `gh` session.
- **`TYPESAFE_API_KEY`** (get one at https://console.typesafe.ai) — only for
  live analysis of diffs. PR reviews don't call any model and don't need it.
  `--mock` runs fully offline with fixture data if you just want to try the
  report.

## Install

Try it without installing anything:

```bash
npx -y diffninja https://github.com/OWNER/REPO/pull/123
```

Or install it globally:

```bash
npm install -g diffninja
```

Both `diffninja` (CLI) and `diffninja-mcp` (MCP server) ship in the package.
`npx` fetches the latest published version on first run; if a cached copy
feels stale, pin it explicitly (`npx -y diffninja@latest ...`).

`0.1.0` is packaged and heading to the registry; until it lands, build from
the checkout (`npm install && npm run build`) and use
`node /absolute/path/to/diffninja/dist/review/cli.js` wherever the examples
below say `diffninja`.

## Review a pull request

```bash
diffninja https://github.com/OWNER/REPO/pull/123
```

This opens a review page in your browser, loaded from the canonical GitHub
patch through your `gh` authentication. Select diff lines, write single-line
inline comments and a review body, pick Comment, Approve, or Request changes,
preview the exact payload, and submit. Every word is yours; diffninja only
carries it to GitHub. It never approves, blocks, or merges anything on its
own.

## Review a diff

```bash
diffninja --diff change.patch                         # a diff file
git diff main...HEAD | diffninja --stdin               # piped diff
diffninja --repo /path/to/repo --from main --to HEAD  # a git range

diffninja --diff change.patch --out review.html  # choose the output file
diffninja --diff change.patch --mock             # offline demo, no API calls
diffninja --diff change.patch --open             # open the report when done
```

You get `review.html` plus a JSON twin beside it. The report ranks every hunk
as **attention**, **uncertain**, **low**, or **passed**, and git-range reviews
add call-flow diagrams showing which code paths each hunk touches. Full flag
reference: [docs/cli-reference.md](docs/cli-reference.md).

## Use it from a coding agent

`diffninja-mcp` is a stdio MCP server exposing one tool, `review_diff`. Point
your agent's MCP config at it:

```json
{ "command": "node", "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"] }
```

Pass a PR link to get back a connected review URL, or diff/range text to get
the full report as the tool result. Per-client setup (Claude Code, Codex, OMP,
pi) and the tool's arguments: [docs/mcp-setup.md](docs/mcp-setup.md).

## How the analysis works

1. **Deterministic checks first.** No-op hunks and blank-only changes are
   settled in code, with no model call.
2. **One Jev judgment per hunk.** Four typed questions (impact scope, bug
   likelihood, change category, missing context). Answers are numbers and
   categories only — no generated prose.
3. **Ranked in code.** The answers combine into a 0–100 priority. Low
   confidence fails closed to `uncertain`; it never degrades into a pass.

## Good to know

- Reports embed source code, including unchanged code. Keep them out of shared
  directories.
- PR (connected) reviews need authenticated `gh`. Live diff analysis needs
  `TYPESAFE_API_KEY`. `--mock` needs neither.
- On Windows, `--open` can't launch a browser — open the printed `file:///…`
  URL yourself.

## Dev

```bash
npm run build   # tsc -> dist/
npm run lint    # oxlint
npm test        # vitest run
```

Releases and the npm publishing setup: [docs/npm-release.md](docs/npm-release.md).

## Credits

The call-flow engine is a fork of
[calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq Kancharla
(MIT, see LICENSE). diffninja uses its call graphs to show which flows each
hunk touches.
