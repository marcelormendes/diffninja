# diffninja

`diffninja` is a CLI for focused PR reviews: it sends diff hunks to TypeSafe's
Jev (typed Choice/Score/Noul questions, one call per hunk), ranks them by a
weighted priority in code, and renders a ranked HTML report. The call-flow
engine underneath is forked from `calldiff` (Tanishq Kancharla, MIT, see
LICENSE and the attribution section in README.md). See `README.md` for usage.

## Project specific instructions

- Single Node.js CLI package (npm, `package-lock.json`). Node `>=22` required.
- Standard commands live in `package.json` `scripts`:
  - Typecheck/build: `npm run build` (runs `tsc`, emits `dist/`).
  - Lint: `npm run lint` (`oxlint`).
  - Tests: `npm test` (`vitest run`).
  - Run in dev: `npm run dev -- --diff <patch> --mock` (runs
    `src/review/cli.ts` via `tsx`); run built binary: `node dist/review/cli.js`.
- Review pipeline lives in `src/review/`: `input.ts` (diff parsing),
  `jev.ts` (TypeSafe client + mock), `pipeline.ts` (deterministic checks,
  routing, weighted ranking), `html.ts` (report), `cli.ts`, `types.ts`.
- Live mode needs `TYPESAFE_API_KEY` in the environment. `--mock` runs fully
  offline with placeholder judgments. Never commit a real API key.
- The `calldiff` engine sources (`src/calltree.ts`, `diff.ts`, `git.ts`, …)
  are forked code: keep the MIT LICENSE attribution intact, do not strip
  Tanishq Kancharla's copyright.
