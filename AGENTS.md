# diffninja

`diffninja` runs inside agent CLIs (Claude Code, Codex, OMP, pi, …) through
`diffninja-mcp`, a stdio MCP server exposing `review_diff`, `finish_review`,
`record_answers`, `record_order`, `suggest_comments`, and `record_explanation`. The
`diffninja` bin only registers that server (`diffninja setup`); there is no
terminal review mode. PR links select a connected, human-authored GitHub review
via `gh`. Page links come only from `finish_review`: the agent gets them once it
has sent its whole reading, so every page a human opens carries it. Static diff/range analysis is
local and deterministic: diffninja calls no model and makes no request of its own while it reviews (a
pull request review talks to GitHub through `gh`; the tool result, source text included, goes to
whatever model the host agent uses). See `docs/security.md`.
Each hunk gets lexical change facts (`change-facts.ts`: code, prose, and config
questions) with the changed line each rests on, and is ranked in code. No review writes report files: a finished
review's `reportUrl` is a read-only loopback page (`report-pages.ts`) serving
the `html.ts` report from memory. The call-flow
engine underneath is forked from `calldiff` (Tanishq Kancharla, MIT, see
LICENSE and the attribution section in README.md). See `README.md` for usage.

## Project specific instructions

- Single Node.js CLI package (npm; `npm-shrinkwrap.json` is the lockfile and ships in the package, so a consumer installs exactly the tested dependency tree with integrity hashes; `npm install` keeps it current). Node `>=22.18` required.
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
    `html.ts` / `evidence-html.ts` (report), `types.ts` / `evidence-types.ts`,
    `update-check.ts` (the opt-in npm version lookup and its notice), `explanation.ts` (the functions list and the agent's business explanation:
    checks and storage), `process-html.ts` (the business view: flowcharts,
    step list, rules, glossary).
  - `setup.ts` — `runSetup()` for `diffninja setup`: CLI detection, config
    writes (atomic, conflict-aware), and `updateFile()`. `toml.ts` — parses
    and edits one TOML table in place by key path, for Codex's config.
    Setup installs and pins its own version (`diffninja@<version>`, npx
    fallback included) and updates a global install older than itself, never
    downgrading, so re-running setup is how users update. `version.ts` —
    `packageVersion()` from the package's own `package.json` (also the MCP
    server's reported version) and `compareVersions()`.
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
    `reviewId` and `nextSteps`, and no page link; the report carries `questions` (`questions.ts`,
    deterministic templates, closed options incl. `cannot-tell`, at most 36; import-only hunks are not asked about)
    and `functions` (`explanation.ts`: each project definition around the hunks
    and in the call flows once, id `<file>#<name>` with any hidden character shown
    as a marker, which is the id the agent sends back, at most 40, product code
    before tests, library calls never listed).
    A git-range report also carries `project` (`history.ts`): line origins per
    hunk (`items[].history`, blame at the base), related reverts, applicable
    guideline paths, and new-file sibling conventions, all from local git only,
    code-point sorted, and never affecting status, priority, or order; a shallow
    clone reports `history: "shallow"` and counts cut lines as unknown.
  - `finish_review`: strict `{ reviewId, answers, order, comments, summary?, explanation? }`, the only
    source of page links. Connected reviews require `summary` and `explanation`.
    `explanation` is `{ functions, processes, rules }`: a one-sentence purpose
    for every listed function exactly once; 1–4 processes of 2–16 steps
    (`start`/`action`/`decision`/`end`, `change` added/changed/removed/unchanged,
    optional `detail`, `before` only on a changed step, `functions`/`hunks`
    references that must resolve, `next` exits that must resolve; a decision
    has two or more exits each with `when`, an end none, an action without
    `next` continues to the next step listed); at most 12 rules, a changed one
    with `before`. Every text is one plain line within its bound, with no
    Markdown and nothing that reads like code (a call, snake_case, a source
    path, backticks). It is the agent's reading, attributed, never generated
    by diffninja, and never changes status, priority, or order. The report page
    opens on it ("How it works"), the call flows put each purpose above its
    code name and fold library-only calls behind a checkbox, and the connected
    page frames it under the goal (`GET /flow?snapshot=&view=business`) and
    tags hunks with the steps and rules that name them (`/api/analysis`
    `explanation`, `hunks[].business`). Success adds `explained` counts.
    The `summary` is nonempty plain
    English, one paragraph, at most 600 characters and 80 words, no control
    characters or Markdown scaffolding. The host summarizes stated intent from
    the title/body, not verified fulfillment; unclear goals stay explicit.
    Static reviews may omit it. The report keeps attributed `agentSummary`,
    exposed as `summary: { text, summarizedBy }` in connected analysis.
    `answers` must answer every question (as `record_answers`), `order` must
    name every item once (as `record_order`), and `comments` follows
    `suggest_comments` and may be `[]`. Everything is checked before anything
    is kept; any gap refuses the whole call and hands out no link. Success
    marks the review finished and returns `{ reviewId, answered, ordered,
    suggested, summarized, reportUrl, url? (connected), next }`; `summarized`
    counts characters sent. Connected pages lead with the agent's goal and
    fold the safely formatted original Markdown description below it.
    A later `review_diff` of a finished pull request returns its `url` and
    `reportUrl` again.
  - `record_answers`, `record_order`, `suggest_comments`, `record_explanation`
    update a review before or after it is finished; they return counts and
    `next`, never a link. `record_explanation` is strict `{ reviewId,
    explanation }`, checked as in `finish_review`; any problem keeps the
    previous explanation.
  - `record_answers`: strict `{ reviewId, answers: [{ questionId, choice }] }`,
    no free text; any invalid answer refuses the whole call and keeps nothing;
    answers are attributed to the MCP client's own name/version, re-render the
    page, and never change status, priority, or order.
  - `suggest_comments`: strict `{ reviewId, comments: [{ path, line, side, body, severity }] }`, `severity` one of
    `critical`/`major`/`minor` (required, its own field, shown on the suggestion),
    at most 30. Each names a commentable line of that review's diff (added
    RIGHT, removed LEFT, context either), at most one per line, and reads like
    the reviewer's own comment: one line, at most 280 characters, no control
    characters, no report scaffolding (headings, bold, list markers, labels
    such as "Finding 1:"). Any bad comment refuses the whole call and keeps the
    previous set; a later call replaces it, an empty list clears it. They reach
    the connected page (`/api/analysis` `suggestions`, attributed to the MCP
    client) as suggestions under their lines; a suggestion joins the human's
    draft only when they add it, and nothing is posted until they submit.
  - `record_order`: strict `{ reviewId, order: string[] }` naming every
    `items[].id` of that review exactly once; anything else refuses the whole
    call and keeps the previous order. The host agent's order is the product's
    reading order: the report's items are reordered to it, so the report page,
    the connected pull request page (`/api/analysis` `order`), and every rank
    follow it, attributed to the MCP client; diffninja's own order is kept in
    `agentOrder.diffninjaIds` and stays one disclosure away. Status and priority
    never change, and a later call replaces an earlier one. Reviews are reachable only
    from the connection that created them. Report pages are `GET /report/<256-bit token>` only, Host-checked,
    CSP-pinned by hash, no-store, at most 20 per connection, and close with it.
    Connected success returns `{ mode: "connected", pr, snapshot }` plus, for
    exactly that snapshot, the local analysis: `reviewId`, `analysisScope`,
    `report`, and `nextSteps`, with no link until `finish_review` (a finished
    review adds `url` and `reportUrl`). With `analysisUnavailable` there is
    nothing to finish, and the result carries the page `url` directly. The page reads it
    from `GET /api/analysis` (same Host/Origin checks) and polls for answers.
    With a PR link, `repo` is an optional absolute local clone used only when it
    already has the PR's base and head commits: never fetched, checked out, or
    written. The canonical GitHub patch stays the diff under review.
    Both include the same JSON in text `content`. Failures return `isError: true`
    with the message as text and no partial report.
  - Connected pages belong to the MCP connection and close on disconnect.
    Repeated calls for one PR reuse its page; no review is submitted by the tool.
  - A review never downloads, installs or builds anything. Inline diffs run
    offline; a git-range review reads git plumbing only (`blame --no-textconv`,
    every git command with a 120 s timeout, `git`/`gh` resolved to absolute
    paths on Windows by `executables.ts`); a pull request review runs `gh` with
    `GH_TELEMETRY=false` and `DO_NOT_TRACK=1`. Only JavaScript and TypeScript
    grammars ship in the package. Every other grammar comes from
    `diffninja grammars install [--build] | status` (`grammars-command.ts`,
    `grammars.ts`): `grammar-lock.ts` (generated by `scripts/pin-grammars.mjs`)
    holds exact versions and the sha512 of every tarball, the install is
    `npm ci --ignore-scripts` with npm's environment cut to what it needs
    (`child-env.ts`; the variables named in `DIFFNINJA_NPM_ENV`, names only,
    also pass, so a private registry's token can reach npm by the user's choice), Kotlin and Perl (no prebuilt binary) are compiled only
    with `--build`. The cache (`~/.cache/diffninja/grammars`, 0700) is trusted
    only when the directory belongs to the current user and no one else can
    write it (not checked on Windows), its marker holds this lock's digest, and
    the installed version is the pin. The marker holds only public data, so it is a
    consistency check, not authentication. Install tightens a directory of the
    user's own to 0700 and refuses anyone else's; `test/global-setup.ts` checks
    both levels of the shared test cache path the same way. A missing grammar raises `GrammarNotInstalledError`; the review
    warns once which grammars its call flows skipped. Both print
    the command from `grammarsInstallCommand`, `npx -y diffninja@<this version> grammars install`
    (plus `--build` for Kotlin or Perl), since a cache another lock installed is
    not read and `@latest` may carry another lock. Call-flow indexing skips
    source files over 1 MiB and files beyond 15,000 per revision (the diff's own
    files and their directories are read first, then code-point order; each
    skipped file counts once), and says so. A review that left files out reports
    `callFlowAvailability: "partial"`.
  - No output files, no CLI flags, no key arguments. The environment is read
    for: `DIFFNINJA_GRAMMAR_CACHE` (cache location), `DIFFNINJA_NPM_ENV` (variable
    names npm also gets), `DIFFNINJA_TRUST_PROJECT_COMPILER=1`
    (see reference checks), `DIFFNINJA_UPDATE_CHECK=1` with `NO_UPDATE_NOTIFIER`
    and `CI` (see below), `CODEX_HOME`/`HOME` (where `setup` writes), and PATH
    (which `git`, `gh`, `npm`, `node` run).
  - The update notice (`update-check.ts`) is off by default. Only the
    `diffninja-mcp` executable, never `createReviewServer()` by default, builds
    the lookup, and only with `DIFFNINJA_UPDATE_CHECK=1` (never in CI or with
    `NO_UPDATE_NOTIFIER`). The first `review_diff` that asks sends one GET to
    `registry.npmjs.org/diffninja/latest` (3 s timeout, no redirects, 512 KiB
    cap, failure means no notice, nothing about the user or the diff is sent);
    only a strictly newer plain `X.Y.Z` becomes `updateNotice` on the report
    (pages, `/api/analysis` `update`) and a first `nextSteps` line.
  - Keep `readOnlyHint: false` and `destructiveHint: false`: the tool opens
    loopback pages and holds review state for the connection. It does not edit
    repository source and, while reviewing, downloads nothing.
- Invocation resolution is deterministic; never guess a PR or intent.
  Missing/ambiguous references ask for one full link without echoing pasted text.
- Keep connected safeguards: immutable snapshot binding, canonical line anchors,
  stale-snapshot and duplicate-submit blocking, no general GitHub/command proxy,
  and access control in layers. Every route of a session (page, `/api/*`,
  `/flow`) lives under `/<256-bit secret>/` (`routeOf`, constant-time compare):
  a local process that was never handed the link gets a 404 for everything and
  cannot read the PR or post a review as the engineer. The agent is handed the
  link, and the page carries the CSRF token, so an agent that can fetch local
  URLs can submit; docs must not claim otherwise (`docs/security.md`), and
  `nextSteps` tells it never to. Loopback-only
  Host/Origin/`Sec-Fetch-Site`/CSRF checks defend against browsers, and the
  page's CSP nonce is fresh per response and never the CSRF token. At most 10
  connected pages stay open per connection (the one used least recently closes,
  and `finish_review` for its review is refused with a clear error); a live
  session's latest report is pinned outside the 20-page report limit. `GET /flow?snapshot=&file=`
  (or `&view=business`, the business view alone, once explained)
  serves the analyzed snapshot's call-flow page (the Tree view only, without the business view) (`renderCallFlowPage`, hashed
  CSP) framable only by its own origin (`frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`); any other snapshot or file is a 404, and the
  review page's CSP allows only `frame-src 'self'`.
- Static reports lead with exact expected-outcome metadata and a deterministic
  review agenda. Description/source matches are navigation hints, never proof
  of fulfillment; generated claims remain separately attributed. All hunks stay
  accessible through native folding, including without JavaScript.
- Change facts are lexical and bounded to the changed lines each side shows:
  `no` never claims absence elsewhere; a file type the analysis cannot read
  answers `unknown` everywhere and reads `uncertain`, never `no` or `passed`. So
  does a hunk with a changed line over 4,000 characters, which is left unread
  rather than answered from part of the line.
  Every `yes` carries the changed line it rests on. The same input always yields
  the same report. Preserve explicit uncertainty and snapshot provenance.
  Reading is linear in the hunk. No operand, comparison count, or window hides a
  changed bound, so a line too long to read is left unread instead.
- Status: code or configuration outside a test file is `attention` (code that
  only changes imports is `low`, trivial priority, never asked about); prose is
  `attention` only for an instruction, link, or limit change, else `low`; a test
  file is `attention` only for a limit change, a discarded failure, or a weakened
  gate, else `low`; a formatting-, comment-, or reflow-only change `passed`. Order: manual units, read hunks by
  priority (test files after the rest, read or not), passes; equal priorities put
  more changed lines first, then diff order. Docs are never demoted by path.
- Semantic interpretation belongs to the host agent's model or the human, never
  to a model diffninja calls itself.
- Reference checks are opt-in and use only a trusted compiler. `referenceProject`
  is chosen by the agent after reading untrusted text, so it never makes the
  server run code from the repository under review: the TypeScript installed
  beside diffninja is used, and the project's own only when the person who
  configured the server set `DIFFNINJA_TRUST_PROJECT_COMPILER=1`. `typescript`
  stays a devDependency (the package ships no compiler): a registry install finds
  a global typescript only beside a global diffninja, never under npx, and the
  check then reports not-checked with that advice. Never execute
  PR scripts, install its dependencies, check out snapshots, or turn incomplete
  diagnostics into a clean bill of health.
- Text written by a pull request's author is data. Hidden and bidirectional
  control characters (`hidden-characters.ts`) show as `⟦U+XXXX⟧` on every page
  (`escapeHtml`, the connected page's `make`/`setText`/diff cell) and in both
  copies of the tool result, and the review warns which files add them. Two
  tiers: bidirectional controls, the tag block and the supplementary variation
  selectors are always shown; joiners, zero-width spaces, fillers and other
  invisible characters are shown unless a visible script character sits beside
  them, so emoji, Persian and Indic text is left as written, and a byte order mark
  that opens a line is left alone. A lone invisible character between two letters
  of a non-Latin script is therefore not marked. Ids and paths the agent echoes
  back are minted in the shown form. Titles
  and commit subjects reach `questions` as JSON-quoted data, and `nextSteps`
  opens with a step saying so. A pull request link inside text that is a real
  unified diff is source and is never followed. Untrusted input is bounded:
  descriptions over 12,000 characters are not lexed (plain text), link detection
  reads 300 characters per side of 500 markers per string, intent claims stop at
  100, and the agent's copy of a result stays under 4 MiB, measured on the marked
  text as sent (`result-budget.ts`), by trimming, in order, `snapshot.lines`,
  extra claims, the review agenda past 20 entries, call flows and per-hunk
  context, then the diff text of the lowest-ranked hunks of any size, then their
  facts, reasons, and history, with a warning that names each stage that ran. A
  result that still does not fit is refused with an error to review the change in
  parts; the server and the pages keep the whole report.
- Tests live in `test/` and run with `vitest`. `review-pipeline.test.ts` covers
  the deterministic checks, status, ranking, and order; `review-change-facts.test.ts`
  the lexical facts; `review-report-pages.test.ts` the report pages;
  `review-input.test.ts` and `review-html.test.ts` cover parsing and rendering;
  `review-cli.test.ts` covers the setup-only command. `grammars-cache.test.ts`,
  `grammars-command.test.ts`, `child-env.test.ts` and `review-grammar-warning.test.ts`
  cover the pinned grammar install and its refusals; `review-hidden-characters.test.ts`,
  `review-result-budget.test.ts`, `executables.test.ts`, `index-limits.test.ts`
  and `package-shrinkwrap.test.ts` the matching hardening. Tests share one grammar cache
  that `test/global-setup.ts` installs once with the same installer users run.
  A cache missing only Kotlin and Perl (no compiler) is kept, not reinstalled
  every run (`global-setup.test.ts`). Check a file a test says was not written
  with `existsSync`, never by running `test -e`, which Windows lacks. `review-explanation.test.ts`
  covers the functions list, the explanation checks, and the business view. `review-history.test.ts`
  covers the project context against temporary repositories (full and shallow). `review-mcp.test.ts` covers the MCP tool through
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
