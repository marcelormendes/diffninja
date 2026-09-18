# diffninja

`diffninja` ships two front ends over one review engine: the `diffninja` CLI
(writes HTML + JSON reports) and `diffninja-mcp`, a stdio MCP server exposing
the single `review_diff` tool (writes no report files; the report is the tool result).
Both send diff hunks to TypeSafe's Jev (typed Choice/Score/Noul questions, one
call per hunk) and rank them by a weighted priority in code. The call-flow
engine underneath is forked from `calldiff` (Tanishq Kancharla, MIT, see
LICENSE and the attribution section in README.md). See `README.md` for usage.

## Project specific instructions

- Single Node.js CLI package (npm, `package-lock.json`). Node `>=22.18` required.
- The package is `private: true` and nothing is published from this repo, so
  setup docs point at a local build and an absolute `node dist/...` path.
  Do not write instructions that assume an npm-published binary exists; local
  `npm run build` plus the absolute path is authoritative.
- Standard commands live in `package.json` `scripts`:
  - Typecheck/build: `npm run build` (runs `tsc`, emits `dist/`).
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
    `pipeline.ts` (deterministic checks, routing, weighted ranking),
    `html.ts` (report), `types.ts` (`ReviewReport` and friends).
  - `cli.ts` — argument parsing plus HTML/JSON file output only.
  - `mcp.ts` — `createReviewServer()`: builds an `McpServer` and registers
    `review_diff`. `mcp-cli.ts` — executable entry that connects the server to
    `StdioServerTransport`; it accepts no arguments and must keep stdout
    reserved for the protocol (diagnostics go to stderr).
- `review_diff` invariants (see `src/review/mcp.ts`; README documents the
  user-facing contract):
  - Strict input object: `diff?`, `repo?`, `from?`, `to?`, `mock?`. Exactly one
    of `diff` or `from`+`to`; `repo` is required and must be absolute for a
    range; `mock` is per-call and never implied.
  - Success returns `structuredContent` equal to the `ReviewReport` plus the
    same report as JSON text in `content`. Failures return `isError: true`
    with the message as text and no partial report.
  - No output files, no CLI flags, no key arguments: live mode reads
    `TYPESAFE_API_KEY` from the server process environment.
  - Keep `readOnlyHint: false` and `destructiveHint: false`: git-range analysis
    can install missing grammars into calldiff's cache through npm, including
    in mock mode. It does not edit repository source.
- Live mode needs `TYPESAFE_API_KEY` in the environment. `--mock` / `mock: true`
  uses placeholder judgments and is never a real review. Inline mock diffs
  are fully offline; ranges may need npm for missing call-flow grammars.
  Never commit a real API key.
- Tests live in `test/` and run with `vitest`. `review-pipeline.test.ts` covers
  the deterministic checks, routing, ranking, and Jev request shape;
  `review-input.test.ts`, `review-html.test.ts`, and `review-cli.test.ts` cover
  parsing, rendering, and the CLI end to end (including the shared
  `reviewDiff` path). `review-mcp.test.ts` covers the MCP tool through
  `createReviewServer()`: input validation, the structured report, its JSON
  text twin, and error cases — assert the outward result, not internal wiring.
- Verify changes by running the built artifacts (`node dist/review/cli.js …`,
  `node dist/review/mcp-cli.js` driven over stdio) or the targeted vitest file,
  not by re-reading the diff.
- The `calldiff` engine sources (`src/calltree.ts`, `diff.ts`, `git.ts`, …)
  are forked code: keep the MIT LICENSE attribution intact, do not strip
  Tanishq Kancharla's copyright.
