# diffninja

`diffninja` ships two front ends: the `diffninja` CLI and `diffninja-mcp`,
a stdio MCP server exposing the single `review_diff` tool. PR links select a
connected, human-authored GitHub review via `gh`; CLI opens the loopback page,
MCP returns its URL. Static diff/range analysis sends hunks to TypeSafe's Jev
(one unordered outcome Choice and six independent yes/no/unknown atomic
questions; one HTTP attempt per evaluable hunk) and
ranks observations in code. Confidence never controls ranking or acquisition.
CLI static mode writes HTML + JSON; MCP writes no report files. The call-flow
engine underneath is forked from `calldiff` (Tanishq Kancharla, MIT, see
LICENSE and the attribution section in README.md). See `README.md` for usage.

## Project specific instructions

- Single Node.js CLI package (npm, `package-lock.json`). Node `>=22.18` required.
- The package is prepared for public npm distribution as `diffninja`, with
  `diffninja` and `diffninja-mcp` bins only. Preparation is not publication.
  README documents npm-first installation and absolute Node + MCP entry paths;
  `docs/npm-release.md` records publishing prerequisites and platform caveats.
  Never publish, log in to npm, or perform npm-account actions without explicit
  authorization for that action.
- Standard commands live in `package.json` `scripts`:
  - Typecheck/build: `npm run build` (cleans `dist/`, runs `tsc`).
  - Package: `npm pack --dry-run` (`prepack` rebuilds from clean output).
  - Lint: `npm run lint` (`oxlint`).
  - Tests: `npm test` (`vitest run`).
  - Run in dev: `npm run dev -- --diff <patch> --mock` (runs
    `src/review/cli.ts` via `tsx`); run built binaries: `node dist/review/cli.js`
    and `node dist/review/mcp-cli.js`.
- Review code lives in `src/review/`:
  - `service.ts` — `reviewDiff(input, options)`: the shared orchestration
    (diff/range input, call-flow enrichment, report assembly). Transports own
    input reading and output persistence; the CLI and MCP server both call it
    and neither duplicates pipeline logic.
  - `input.ts` (diff parsing + git range), `jev.ts` (TypeSafe client + mock),
    `pipeline.ts` (deterministic checks, routing, fixed-table ranking),
    `context-plan.ts` (bounded whole-node admission before the single request),
    `evidence.ts` / `evidence-syntax.ts` (bounded syntactic findings and agenda),
    `module-resolution.ts` (conservative immutable import bindings),
    `reference-check.ts` (opt-in before/after TypeScript diagnostics),
    `html.ts` / `evidence-html.ts` (report), `types.ts` / `evidence-types.ts`.
  - `setup.ts` — `runSetup()` for `diffninja setup`: CLI detection, config
    writes (atomic, conflict-aware), and `updateFile()`. `toml.ts` — parses
    and edits one TOML table in place by key path, for Codex's config.
  - `cli.ts` — argument parsing, connected auto-open, static HTML/JSON output.
    `pr-input.ts` — shared PR-link detection and canonicalization.
    `github.ts` / `connected.ts` — snapshot-bound review and loopback transport.
  - `mcp.ts` — `createReviewServer()`: builds an `McpServer` and registers
    `review_diff`. `mcp-cli.ts` — executable entry that connects the server to
    `StdioServerTransport`; it accepts no arguments and must keep stdout
    reserved for the protocol (diagnostics go to stderr).
- `review_diff` invariants (see `src/review/mcp.ts`; README documents the
  user-facing contract):
  - Strict input object: `diff?`, `repo?`, `from?`, `to?`, `mock?`, `pr?`, `input?`,
    `mode?` (`auto`/`connected`/`static`; default auto),
    `expectedOutcome?: { title: string, description: string }`,
    `referenceProject?: string` (repository-relative tsconfig).
    Auto and connected detect PR links in diff/repo/from/to/pr/input before
    static validation, never in expected-outcome text. Connected requires a link
    and rejects metadata overrides/reference checking; it never falls back.
    Static skips detection, treats links as source, and rejects pr/input.
    Static analysis requires exactly one of `diff` or `from`+`to`; `repo` must
    be absolute for a range. In auto, `pr`/`input` require a PR link.
  - Static success returns `structuredContent` equal to the `ReviewReport`.
    Connected success returns `{ mode: "connected", url, pr, snapshot }`.
    Both include the same JSON in text `content`. Failures return `isError: true`
    with the message as text and no partial report.
  - Connected pages belong to the MCP connection and close on disconnect.
    Repeated calls for one PR reuse its page; no review is submitted by the tool.
  - No output files, no CLI flags, no key arguments: live static analysis reads
    `TYPESAFE_API_KEY` from the server process environment; connected uses `gh`.
  - Keep `readOnlyHint: false` and `destructiveHint: false`: git-range analysis
    can install missing grammars into calldiff's cache through npm, including
    in mock mode. It does not edit repository source.
- Live static analysis needs `TYPESAFE_API_KEY`. `--mock` / `mock: true` uses
  placeholder judgments, never a real assessment. Inline mock diffs are offline;
  ranges may need npm for missing grammars. PR inputs still read authenticated
  `gh` even with mock. CLI `--static` / `--export` explicitly exports a PR report
  rather than serving it. Never commit a real API key.
- CLI `--connected` requires one PR link and conflicts with --static/--export.
  Invocation resolution is deterministic; never use Jev to guess a PR or intent.
  Missing/ambiguous references ask for one full link without echoing pasted text.
- Keep connected safeguards: immutable snapshot binding, canonical line anchors,
  stale-snapshot and duplicate-submit blocking, loopback-only Host/Origin/CSRF
  checks, and no general GitHub/command proxy.
- Static reports lead with exact expected-outcome metadata and a deterministic
  review agenda. Description/source matches are navigation hints, never proof
  of fulfillment; generated claims remain separately attributed. All hunks stay
  accessible through native folding, including without JavaScript.
- Jev has no ensemble, adaptive loop, shuffle, or retry. State is capped at
  24,000 serialized characters; at most eight complete context nodes are
  considered. Oversized essentials route uncalled to a human; optional context
  is omitted whole. Preserve explicit uncertainty and snapshot provenance.
- The report renders model answers only from their closed sets: the outcome
  choice and the six independent atomic properties. A value outside its set is
  named as unrecognized, never echoed. Any answer whose reported option did not
  hold a majority of its own distribution is recorded as `unknown` before it
  reaches the report, so a scattered or tied answer is never rendered as a
  supported `yes` or `changed`. `unknown` means the supplied state could not
  determine the answer and is never rendered as `no`, as absence, or as a
  defect. Missing or malformed answers, and an answer to a question this run did
  not ask, fail the whole hunk closed.
- Reference checks are opt-in and use only the trusted installed compiler and
  dependencies. Never execute PR scripts, install its dependencies, check out
  snapshots, or turn incomplete diagnostics into a clean bill of health.
- Tests live in `test/` and run with `vitest`. `review-pipeline.test.ts` covers
  the deterministic checks, routing, ranking, and Jev request shape;
  `review-input.test.ts`, `review-html.test.ts`, and `review-cli.test.ts` cover
  parsing, rendering, and the CLI end to end (including the shared
  `reviewDiff` path). `review-mcp.test.ts` covers the MCP tool through
  `createReviewServer()`: input validation, the structured report, its JSON
  text twin, and error cases — assert the outward result, not internal wiring.
  `review-setup.test.ts` covers `runSetup()` (detection, dry-run, entry
  resolution, atomic writes) and `review-toml.test.ts` the TOML table editor.
- Verify changes by running the built artifacts (`node dist/review/cli.js …`,
  `node dist/review/mcp-cli.js` driven over stdio) or the targeted vitest file,
  not by re-reading the diff.
- The `calldiff` engine sources (`src/calltree.ts`, `diff.ts`, `git.ts`, …)
  are forked code: keep the MIT LICENSE attribution intact, do not strip
  Tanishq Kancharla's copyright.
