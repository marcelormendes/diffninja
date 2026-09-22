# diffninja

`diffninja` runs inside agent CLIs (Claude Code, Codex, OMP, pi, …) through
`diffninja-mcp`, a stdio MCP server exposing the single `review_diff` tool. The
`diffninja` bin only registers that server (`diffninja setup`); there is no
terminal review mode. PR links select a connected, human-authored GitHub review
via `gh`, and the tool returns its loopback URL. Static diff/range analysis is
local and deterministic: no model is called and no source leaves the machine.
Each hunk gets lexical change facts (`change-facts.ts`: code, prose, and config
questions) with the changed line each rests on, and is ranked in code. No review writes report files: a static
result adds `reportUrl`, a read-only loopback page (`report-pages.ts`) serving
the `html.ts` report from memory. The call-flow
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
  - Run in dev: `npm run dev` (runs the MCP server `src/review/mcp-cli.ts` via
    `tsx` on stdio); built binaries: `node dist/review/mcp-cli.js` (server) and
    `node dist/review/cli.js setup` (registration).
- Review code lives in `src/review/`:
  - `service.ts` — `reviewDiff(input, options)`: the shared orchestration
    (diff/range input, call-flow enrichment, report assembly). The MCP server
    owns input validation and never duplicates pipeline logic.
  - `input.ts` (diff parsing + git range), `change-facts.ts` (local lexical
    facts per hunk), `file-role.ts` (test-file path classification),
    `pipeline.ts` (deterministic checks, status, fixed-table ranking, order),
    `evidence.ts` / `evidence-syntax.ts` (bounded syntactic findings and agenda),
    `module-resolution.ts` (conservative immutable import bindings),
    `reference-check.ts` (opt-in before/after TypeScript diagnostics),
    `html.ts` / `evidence-html.ts` (report), `types.ts` / `evidence-types.ts`.
  - `setup.ts` — `runSetup()` for `diffninja setup`: CLI detection, config
    writes (atomic, conflict-aware), and `updateFile()`. `toml.ts` — parses
    and edits one TOML table in place by key path, for Codex's config.
  - `cli.ts` — the setup-only `diffninja` command; any other invocation
    explains how to review through an agent, without echoing its arguments.
    `pr-input.ts` — shared PR-link detection and canonicalization.
    `github.ts` / `connected.ts` — snapshot-bound review and loopback transport.
  - `mcp.ts` — `createReviewServer()`: builds an `McpServer` and registers
    `review_diff`. `report-pages.ts` — per-connection read-only report pages.
    `mcp-cli.ts` — executable entry that connects the server to
    `StdioServerTransport`; it accepts no arguments and must keep stdout
    reserved for the protocol (diagnostics go to stderr).
- `review_diff` invariants (see `src/review/mcp.ts`; README documents the
  user-facing contract):
  - Strict input object: `diff?`, `repo?`, `from?`, `to?`, `pr?`, `input?`,
    `mode?` (`auto`/`connected`/`static`; default auto),
    `expectedOutcome?: { title: string, description: string }`,
    `referenceProject?: string` (repository-relative tsconfig).
    Auto and connected detect PR links in diff/repo/from/to/pr/input before
    static validation, never in expected-outcome text. Connected requires a link
    and rejects metadata overrides/reference checking; it never falls back.
    Static skips detection, treats links as source, and rejects pr/input.
    Static analysis requires exactly one of `diff` or `from`+`to`; `repo` must
    be absolute for a range. In auto, `pr`/`input` require a PR link.
  - Static success returns `structuredContent` equal to the `ReviewReport` plus
    `reportUrl`. Report pages are `GET /report/<256-bit token>` only, Host-checked,
    CSP-pinned by hash, no-store, at most 20 per connection, and close with it.
    Connected success returns `{ mode: "connected", url, pr, snapshot }`.
    Both include the same JSON in text `content`. Failures return `isError: true`
    with the message as text and no partial report.
  - Connected pages belong to the MCP connection and close on disconnect.
    Repeated calls for one PR reuse its page; no review is submitted by the tool.
  - No output files, no CLI flags, no key arguments, no environment: static
    analysis is local; connected uses `gh`.
  - Keep `readOnlyHint: false` and `destructiveHint: false`: git-range analysis
    can install missing grammars into calldiff's cache through npm. It does not
    edit repository source. Inline diffs are fully offline.
- Invocation resolution is deterministic; never guess a PR or intent.
  Missing/ambiguous references ask for one full link without echoing pasted text.
- Keep connected safeguards: immutable snapshot binding, canonical line anchors,
  stale-snapshot and duplicate-submit blocking, loopback-only Host/Origin/CSRF
  checks, and no general GitHub/command proxy.
- Static reports lead with exact expected-outcome metadata and a deterministic
  review agenda. Description/source matches are navigation hints, never proof
  of fulfillment; generated claims remain separately attributed. All hunks stay
  accessible through native folding, including without JavaScript.
- Change facts are lexical and bounded to the changed lines each side shows:
  `no` never claims absence elsewhere; a file type the analysis cannot read
  answers `unknown` everywhere and reads `uncertain`, never `no` or `passed`.
  Every `yes` carries the changed line it rests on. The same input always yields
  the same report. Preserve explicit uncertainty and snapshot provenance.
- Status: code or configuration outside a test file is `attention`; prose is
  `attention` only for an instruction, link, or limit change, else `low`; a test
  file is `attention` only for a limit change, a discarded failure, or a weakened
  gate, else `low`; a formatting-, comment-, or reflow-only change `passed`. Order: manual units, read hunks by
  priority (test files after the rest), passes. Docs are never demoted by path.
- Semantic interpretation belongs to the host agent's model or the human, never
  to a model diffninja calls itself.
- Reference checks are opt-in and use only the trusted installed compiler and
  dependencies. Never execute PR scripts, install its dependencies, check out
  snapshots, or turn incomplete diagnostics into a clean bill of health.
- Tests live in `test/` and run with `vitest`. `review-pipeline.test.ts` covers
  the deterministic checks, status, ranking, and order; `review-change-facts.test.ts`
  the lexical facts; `review-report-pages.test.ts` the report pages;
  `review-input.test.ts` and `review-html.test.ts` cover parsing and rendering;
  `review-cli.test.ts` covers the setup-only command. `review-mcp.test.ts` covers the MCP tool through
  `createReviewServer()`: input validation, the structured report, its JSON
  text twin, and error cases — assert the outward result, not internal wiring.
  `review-setup.test.ts` covers `runSetup()` (detection, dry-run, entry
  resolution, atomic writes) and `review-toml.test.ts` the TOML table editor.
- Verify changes by running the built artifacts (`node dist/review/mcp-cli.js`
  driven over stdio, `node dist/review/cli.js setup --dry-run`) or the targeted vitest file,
  not by re-reading the diff.
- The `calldiff` engine sources (`src/calltree.ts`, `diff.ts`, `git.ts`, …)
  are forked code: keep the MIT LICENSE attribution intact, do not strip
  Tanishq Kancharla's copyright.
