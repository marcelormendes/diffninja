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

Register the MCP server on every agent CLI you use (Claude Code, Codex, OMP,
pi) with one command:

```bash
npx -y diffninja setup
```

It installs the package globally first, then registers the server in each
detected CLI. See `docs/mcp-setup.md` for the manual entries.

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
2. **Adaptive, typed Jev rounds.** Each round makes three independent runs with
   four assessment questions (impact scope, bug likelihood, change category,
   missing context) and a fifth `needs_more_context` question. It selects a
   closed list of zero, one, or two collapsed node keys via Choice, never free
   text. With no collapsed nodes, a Noul answer normalizes to an empty list.
   Category options are shuffled independently on every request; ordinal impact
   levels keep their order. If the round requests context and its mean lower
   risk/category confidence is below 0.8, only requested definitions that fit
   are expanded. The loop stops on an empty request, confidence at or above 0.8,
   no expansion progress, or three total rounds. Only the final round's three
   probability vectors are averaged by option name; earlier answers remain
   recorded but do not dilute the expanded-context assessment.
3. **Ranked in code.** The averaged answers combine into a 0–100 priority.
   A category or impact-level top probability below 0.6, or run-to-average
   total-variation distance at or above 0.35, routes to `uncertain`, alongside
   the bug-probability and missing-context gates. Vendor confidence controls
   context acquisition only, not ranking. Failed or malformed runs fail closed
   for the whole hunk.

Git-range analysis supplies selected call-site blocks from both snapshots,
including written arguments, declared parameters, locations, and explicit target
and binding uncertainty. Unambiguous same-file JS/TS and Python calls support
positional binding; Python also supports named arguments. Imports, member
dispatch, dynamic targets, and other grammars do not get guessed mappings.
These are static source expressions, not runtime values or data-flow analysis.
TypeScript/TSX extraction includes methods of decorated exported classes,
including stacked and custom decorators. Simple explicit class-field and
constructor-property types identify candidate dependency methods; unsupported
receiver types stay unresolved rather than borrowing the containing class's
method. These are not type-checked or proven runtime bindings. Decorator
execution and framework event/queue dispatch are not resolved as call edges.

Context prioritizes calls adjacent to the hunk, with depth limited to four,
at most eight arguments per call, and 120 characters per argument excerpt.
Snapshot-bound changed definitions, callers, and resolved callees carry their
complete source plus selected call-site bindings. Up to eight definition nodes are addressable per
hunk; other nodes are explicitly omitted. The initial state targets 12,000
serialized characters, reserving key, label, file, and line descriptors before
admitting whole definition details. Definitions that do not fit remain visible
as collapsed nodes. Expansion never silently truncates a function or includes
unrequested nodes.

The serialized model state is capped at 24,000 characters. Optional context is
pruned before sacrificing evaluation; the hunk is never truncated. If the
essential file/hunk/diff/disclaimer state itself cannot fit, the hunk enters the
human-review queue once, with `item.routing.evaluation: "not_evaluated"`,
`reasonCode: "context_limit_exceeded"`, `requiredChars`, and `limitChars`.
There is no model call or fabricated judgment for that hunk. The HTML identifies
the skip and its sizes; the JSON and MCP results carry the routing metadata.

Each hunk has one shared 30-second deadline and at most 27 HTTP attempts
(three rounds × three runs × three attempts, including retries). Expansion adds
at most 24,000 UTF-8 bytes, counting JSON escaping and field overhead, while
every state remains under the 24,000-character cap. JSON/MCP `item.evaluation`
records each round's state, validated answers, requested/expanded keys, call and
iteration counts, added bytes, and stop reason. The existing deterministic
aggregation can be replayed from the final recorded round. Report warnings log
these per-hunk counts, including failures, without writing to MCP protocol stdout.

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
