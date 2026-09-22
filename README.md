# diffninja

PR reviews for humans, not prose from a chatbot. Give diffninja a GitHub PR
link and it opens a review workspace where you read the diff, write inline
comments, and submit the review yourself. Feed it a diff or a git range and it
returns an evidence-backed reading agenda alongside the complete diff.

Live static analysis sends each evaluable hunk to TypeSafe's Jev model once,
with a typed question set: one unordered outcome choice — does the edit change
what a consumer of the code can observe or rely on — and six independent
yes/no/unknown properties. Connected GitHub reviews do not call a model. Neither
mode writes review prose for you. You stay the reviewer.

## What you need

- **Node.js 22.18 or newer.**
- **GitHub CLI (`gh`) 2.45.0+, authenticated** (`gh auth login`) — only for
  reviewing pull requests. diffninja never asks for a token; it reuses your
  `gh` session.
- **`TYPESAFE_API_KEY`** (get one at https://console.typesafe.ai) — only for
  live static analysis. Connected PR reviews don't call a model and don't need
  it. `--mock` substitutes fixture judgments; PR inputs still need GitHub access,
  and git ranges may install missing parsing grammars.

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

You get `review.html` plus a JSON twin beside it. **Outcome** starts with the
exact PR title and description when supplied, then a short reading agenda,
bounded automatic findings, and explicit check coverage. Claims in a description
are not proof that the code fulfills them. **Diff** retains every hunk, ranked
as **attention**, **uncertain**, **low**, or **passed**; git-range reviews add
call-flow diagrams and snapshot-bound source cards.

For local inputs, pass `--pr-title` and `--pr-description` to include expected
outcomes. A static GitHub PR export reads its own metadata. Full flag reference:
[docs/cli-reference.md](docs/cli-reference.md).

## Use it from a coding agent

`diffninja-mcp` is a stdio MCP server exposing one tool, `review_diff`. Point
your agent's MCP config at it:

```json
{ "command": "node", "args": ["/absolute/path/to/diffninja/dist/review/mcp-cli.js"] }
```

Pass a PR link to get back a connected review URL, or diff/range text to get
the full report as the tool result. Per-client setup (Claude Code, Codex, OMP,
pi) and the tool's arguments: [docs/mcp-setup.md](docs/mcp-setup.md).

## How static analysis works

1. **Deterministic evidence first.** No-op hunks and blank-only document changes
   need no model call. Repository snapshots support bounded checks for duplicate
   function bodies and unread `errors` response fields, plus caller and contract
   source cards. Optional TypeScript reference checking compares before/after
   diagnostics, including unchanged consumers, using an explicitly trusted
   installed compiler. Unsupported or incomplete checks say so.
2. **One typed Jev request.** Each evaluable hunk gets one request with an
   unordered outcome choice — `changed`, `unchanged`, or `unknown` — and six
   independent yes/no/unknown questions about the added and removed lines:
   comparison changed, limit changed, validation changed, failure propagated,
   failure deferred, failure discarded. All seven are the same kind of question:
   closed options with fixed order, non-exclusive, and no repeated judgments,
   option shuffles, adaptive context rounds, or HTTP retries.
   `changed` means an added or removed line changes something a consumer of the
   code can observe or rely on: a consumable result or returned value, an effect,
   an accepted input, an interface or schema, or a normative instruction or
   guarantee callers, operators, or users must follow. Prose is judged by its
   content, never by its file type. `unchanged` requires evidence of semantic
   equivalence for those consumers, and `unknown` is the answer when this state
   cannot separate the two. Each atomic `no` speaks only about the lines the
   state shows; `unknown` means that answer could not be determined from the
   supplied context.
   Context-presence counts come from the admitted definitions' extractor
   provenance, separately for each snapshot; callers and contracts can both be
   present.
3. **A majority answer or nothing.** An answer whose reported option holds at most
   half of its own accounted probability — an exact tie included — is recorded as
   `unknown` instead of as the option a plurality happened to name, so a scattered
   or tied answer can never read as a finding. Missing or malformed answers, or an
   answer to a question this run did not ask, fail the hunk closed. Priority is
   still deterministic: a fixed base, plus 10 when the outcome separated as
   `changed`, plus the heaviest affirmative answer in the boundary group
   (comparison, limit, validation) and the heaviest in the failure group
   (propagated, deferred, discarded) — each group contributes its maximum, never a
   sum, and nothing is summed twice. `unknown` adds nothing anywhere: there is no
   bonus for an answer the state could not settle and no confidence gate.
   Any `unknown` answer routes to `uncertain`; otherwise a hunk reads
   **attention** when the outcome separated as `changed` outside a test file, when a limit, size,
   offset, or timeout bound changed, or when a failure was discarded, and **low**
   otherwise. Returned confidence is recorded but never used for ranking,
   thresholds, or weighting.
   The report lists unjudged work first — a hunk no model saw, or one whose call
   failed closed — then the judged hunks by priority descending regardless of
   status, then the deterministic passes. Judged hunks in test files (by path
   convention: `test/`, `*.test.ts`, `test_*.py`, `*_test.go`, …) come after the
   other judged hunks, still ordered by their own priority: a regression test is
   honestly `changed` too, so the answers alone cannot keep it from outranking
   the code it exercises. Documentation is not demoted, because prose can be
   normative. Status is a label for filtering and never reorders the report.
   The short review agenda comes from deterministic evidence, independently of
   stochastic hunk judgments. A live rerun can change those judgments and their
   hunk ordering; neither priority nor confidence is a correctness probability.

Intent cross-checks keep author claims and generated summaries separate.
Source matches are navigation evidence, not proof of fulfillment. Broad goals,
missing metadata, and behavior not established by the available code remain
explicitly unestablished. Findings likewise state their scope: duplicated syntax
is not necessarily duplicated responsibility, and an unread field alone does not
prove that a real failure was mishandled.

Git-range analysis supplies selected call-site blocks from both snapshots,
including written arguments, declared parameters, locations, and explicit target
and binding uncertainty. Unambiguous same-file JS/TS and Python calls support
positional binding; Python also supports named arguments. Imports, member
dispatch, dynamic targets, and other grammars do not get guessed mappings.
These are static source expressions, not runtime values or data-flow analysis.
TypeScript/TSX extraction includes methods of decorated exported classes,
including stacked and custom decorators; method source spans retain their
decorators so decorator-only changes still select the method body. Simple explicit class-field and
constructor-property types identify candidate dependency methods; unsupported
receiver types stay unresolved rather than borrowing the containing class's
method. These are not type-checked or proven runtime bindings.

Review context also follows candidate event and queue relations: static
`emit`/`emitAsync` keys match `@On*Event` handlers; injected queue `.add` keys
match `@Processor` consumers' `job.name` cases or `@Process` methods only on a
matching queue channel. String enum values can connect member keys to literal
cases. These are source-derived relations, not runtime calls or proof of
delivery; dynamic keys, aliases, and unrecognized framework syntax can be absent.
Constant resolution is snapshot-local, including when extraction is cached.

Module-level TypeScript/TSX interfaces, type aliases, and enums are addressable
non-callable context nodes. Signature, body, and generic type references connect
them to reviewed methods and other contracts. Relative import bindings take
precedence; unique module-path suffixes and unimported names are candidate
matches, not type checking. Unresolved imports do not borrow same-named types.
Barrel re-exports, nested declarations, and class-field contracts may be absent.

Context prioritizes calls adjacent to the hunk, with depth limited to four,
at most eight arguments per call, and 120 characters per argument excerpt.
Snapshot-bound changed definitions, callers, callees, dispatch endpoints, and
type contracts carry complete source plus selected relation evidence. Bodies not
already shown in the hunk take precedence over duplicate source. Unseen type
declarations and dispatch endpoints precede ordinary caller chains, nearest
first, with resulting-snapshot evidence ahead of prior-snapshot duplicates.
Unresolved own-call expressions remain verbatim in a whole source body rather
than repeating unknown-binding boilerplate. At most eight distinct definition
nodes are considered per hunk. Context is gathered once before the request;
definitions that do not fit are omitted whole, never shortened or fetched later.

The serialized model state is capped at 24,000 characters. Optional context is
pruned before sacrificing evaluation; the hunk is never truncated. If the
essential file/hunk/diff/disclaimer state itself cannot fit, the hunk enters the
human-review queue once, with `item.routing.evaluation: "not_evaluated"`,
`reasonCode: "context_limit_exceeded"`, `requiredChars`, and `limitChars`.
There is no model call or fabricated judgment for that hunk. The HTML identifies
the skip and its sizes; the JSON and MCP results carry the routing metadata.

The adapter pins `jev-1.13.0`, sends no temperature override, and allows at most
four concurrent requests, each with a 10-second timeout including its response
body. JSON/MCP results retain typed judgments, routing, priorities, and the
actual HTTP request count; obsolete round/ensemble traces are no longer emitted.

Automatic response/caller evidence is narrower than the candidate call graph:
it requires a supported lexical or typed-constructor binding. Relative modules
and simple single-target `paths` aliases from snapshot-local, standalone JSON
`tsconfig.json` files are supported. JSONC, inherited configurations, package or
barrel resolution, and complex receivers remain unproven rather than borrowing
an unrelated same-named function. `--reference-project path/to/tsconfig.json`
opts into the separate TypeScript diagnostic comparison; absent dependencies,
unsupported project layouts, and exceeded bounds are reported as not checked.

## Good to know

- Reports embed source code, including unchanged code. Keep them out of shared
  directories.
- Connected PR reviews need authenticated `gh`. Live static analysis needs
  `TYPESAFE_API_KEY`; `--mock` skips only that model dependency.
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
