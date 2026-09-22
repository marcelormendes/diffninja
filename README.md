# diffninja

PR reviews for humans, not prose from a chatbot, run from inside your coding
agent. Ask Claude Code, Codex, pi, or another MCP-capable agent CLI to review a
GitHub PR link and diffninja returns a review workspace where you read the diff,
write inline comments, and submit the review yourself. Give the agent a diff or
a git range and diffninja returns an evidence-backed reading agenda alongside
the complete diff, as structured data for the agent and as a page for you.

diffninja is an MCP server (`review_diff`) plus a `diffninja setup` command that
registers it. It has no terminal review mode.

Analysis is local and deterministic: no model is called, no source leaves your
machine, and the same input always gives the same report. Each hunk gets change
facts — did a comparison, a limit, or an input check change; is a failure handed
to the caller, deferred, or discarded — each pointing at the changed line it
rests on. Interpreting what the change means is left to you and, if you ask it,
to the agent you already use. diffninja writes no review prose. You stay the
reviewer.

## What you need

- **Node.js 22.18 or newer.**
- **An MCP-capable agent CLI:** Claude Code, Codex, OMP, pi, or any client that
  can launch a stdio MCP server.
- **GitHub CLI (`gh`) 2.45.0+, authenticated** (`gh auth login`) — only for
  reviewing pull requests. diffninja never asks for a token; it reuses your
  `gh` session.
- No API key. Git ranges may install missing parsing grammars through npm the
  first time a language is seen.

## Install

Register the MCP server on every agent CLI you use (Claude Code, Codex, OMP,
pi) with one command:

```bash
npx -y diffninja setup
```

It installs the package globally first, then registers the server in each
detected CLI. `diffninja setup --help` lists the options (`--cli`,
`--uninstall`, `--dry-run`, `--no-install`); `docs/mcp-setup.md` has the manual
entries.

The package ships `diffninja` (setup only) and `diffninja-mcp` (the MCP server).
`npx` fetches the latest published version on first run; if a cached copy feels
stale, pin it explicitly (`npx -y diffninja@latest setup`).

`0.1.0` is packaged and heading to the registry; until it lands, build from the
checkout (`npm install && npm run build`) and point your agent at
`node /absolute/path/to/diffninja/dist/review/mcp-cli.js`.

## Review a pull request

Ask your agent to review `https://github.com/OWNER/REPO/pull/123`. It calls
`review_diff` with the link and gives you a loopback review page, loaded from
the canonical GitHub patch through your `gh` authentication. Select diff lines,
write single-line inline comments and a review body, pick Comment, Approve, or
Request changes, preview the exact payload, and submit. Every word is yours;
diffninja only carries it to GitHub. It never approves, blocks, or merges
anything on its own. The page belongs to the agent's MCP connection and closes
when the agent exits.

Above the diff, a **Reading order** panel shows the same local analysis a
static review gives, for exactly that revision: every hunk's status and change
facts with the line each rests on, the checks that ran, a link to the full
report, and "go to the diff" buttons. Questions for your agent (does this
change behavior, does a test exercise it, does it serve the stated goal) show
its answers as they arrive, attributed to the agent's client. If you also tell
the agent where your local clone is (`repo`), and the clone already has the
pull request's commits, call flows and definitions are added; diffninja never
fetches or writes in it.

## Review a diff or a git range

Ask your agent to review a patch, the working tree, or a range such as
`main..HEAD` in a repository. It calls `review_diff` with `diff` text or with
`repo`, `from`, and `to`, and receives the report as the tool result: the exact
expected outcome when supplied (`expectedOutcome`), a short reading agenda,
bounded automatic findings, explicit check coverage, and every hunk, ranked as
**attention**, **uncertain**, **low**, or **passed**; git ranges add call flows
and snapshot-bound source. Claims in a description are not proof that the code
fulfills them. The result also carries `reportUrl`: a read-only page on
`127.0.0.1` with the same report for you to read — the agenda, call-flow graphs,
and every hunk — served from memory for as long as the agent's session lasts.
The tool writes no report files. Arguments and examples:
[docs/mcp-setup.md](docs/mcp-setup.md). Trying it on real reviews:
[docs/pilot.md](docs/pilot.md).

## How static analysis works

1. **Evidence first.** No-op hunks and blank-only document changes pass.
   Repository snapshots support bounded checks for duplicate function bodies and
   unread `errors` response fields, plus caller and contract source cards.
   Optional TypeScript reference checking compares before/after diagnostics,
   including unchanged consumers, using an explicitly trusted installed compiler.
   Unsupported or incomplete checks say so.
2. **Change facts per hunk.** The added and removed lines are read lexically —
   strings and comments set aside, moved lines cancelling out. Code gets six facts:
   comparison changed, limit changed (a numeric bound, or `<` turned into `<=`),
   input check changed (type/shape checks, or a changed guard in front of a
   raise), failure handed to the caller, failure deferred or retried, failure
   discarded (an empty or defaulting `catch`, `except: pass`, …). Documentation
   (`.md`, `.rst`, `.txt`, …) is asked whether an instruction to readers changed
   (must, never, only, at most, …), a link target changed, or a numeric limit
   changed. Configuration (`.yml`, `.json`, `.toml`, Dockerfiles, `.env`, …) is
   asked whether a CI gate was weakened (`continue-on-error`, `|| true`, a
   failure turned into a warning, a check step removed), permissions or secret
   access changed, a version pin changed, or a limit changed. Each `yes` cites
   its changed line. `no` speaks only about the lines the hunk shows. A change
   that only touches formatting, comments, or line breaks is recognized as such.
   JS/TS, Java, C#, Go, Rust, C/C++, Kotlin, Swift, PHP, Python, Ruby,
   documentation and configuration are read; any other file type says that no
   facts were established instead of claiming none.
3. **Status and order.** A code or configuration change outside a test file
   reads **attention**; documentation reads **attention** when it changes an
   instruction, a link, or a limit, **low** otherwise; a test-file change reads
   **attention** only when it changes a limit, discards a failure, or weakens a
   gate, **low** otherwise; a formatting-only change **passed**;
   an unread file type **uncertain**, for a person to read. Priority orders hunks:
   a fixed base, plus 10 for a real change, plus the heaviest fact of the
   boundary group (what the change says or bounds) and of the failure group
   (failures, CI gates, permissions) — each group counts once, never summed. The report lists
   manual work first (binary and other metadata-only units), then the read hunks
   by priority, then passes. Hunks in test files (by path convention: `test/`,
   `*.test.ts`, `test_*.py`, `*_test.go`, …) come after the other hunks, still
   ordered by their own priority: a regression test changes as much as its fix.
   Documentation is not demoted, because prose can be normative. Status is a
   label for filtering and never reorders the report.
4. **Questions for your agent.** Where a judgment needs meaning rather than
   syntax, the report asks the agent that requested it — does this hunk change
   what callers observe, does a test exercise it, does a test change weaken it,
   do the docs match the code, does the hunk serve the stated goal. Questions
   are fixed templates with closed options (always including `cannot-tell`);
   the agent answers through `record_answers`, and the answers appear on the
   report page attributed to that agent, never reordering anything. diffninja
   itself still calls no model.

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
nodes are kept per hunk, each carried whole, never shortened.

Automatic response/caller evidence is narrower than the candidate call graph:
it requires a supported lexical or typed-constructor binding. Relative modules
and simple single-target `paths` aliases from snapshot-local, standalone JSON
`tsconfig.json` files are supported. JSONC, inherited configurations, package or
barrel resolution, and complex receivers remain unproven rather than borrowing
an unrelated same-named function. `referenceProject: "path/to/tsconfig.json"`
opts into the separate TypeScript diagnostic comparison; absent dependencies,
unsupported project layouts, and exceeded bounds are reported as not checked.

## Good to know

- Tool results embed source code, including unchanged code, and stay in your
  agent's session. Keep transcripts that contain them private.
- Connected PR reviews need authenticated `gh`. Nothing else leaves your
  machine: no model is called and no API key is needed.

## Dev

```bash
npm run build   # tsc -> dist/
npm run lint    # oxlint
npm test        # vitest run
```

Run the built server directly with `node dist/review/mcp-cli.js` (it speaks MCP
over stdio and prints nothing else to stdout).

Releases and the npm publishing setup: [docs/npm-release.md](docs/npm-release.md).

## Credits

The call-flow engine is a fork of
[calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq Kancharla
(MIT, see LICENSE). diffninja uses its call graphs to show which flows each
hunk touches.
