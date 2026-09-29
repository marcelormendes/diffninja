# diffninja

`diffninja` runs inside agent CLIs (Claude Code, Codex, OMP, pi, …) through
`diffninja-mcp`, a stdio MCP server exposing `review_diff`, `finish_review`,
`record_answers`, `record_order`, `suggest_comments`, and `record_explanation`. The
`diffninja` bin registers that server (`diffninja setup`) and installs grammars
(`diffninja grammars`); there is no terminal review mode. PR links select a
connected, human-authored GitHub review via `gh`. Page links come from
`finish_review`: the agent gets them once it has sent its whole reading, so every
page a human opens carries it. The one exception is a pull request that cannot be
analyzed (closed or merged, no readable head repository, an incomplete patch, or
a failed local analysis), where `review_diff` returns the page `url` directly
with `analysisUnavailable`. Static diff/range analysis is local and
deterministic: diffninja calls no model and makes no request of its own while it
reviews (the opt-in update notice aside; a pull request review talks to GitHub
through `gh`; in a partial clone git may fetch missing objects; the tool result,
source text included, goes to whatever model the host agent uses). See
`docs/security.md`, which is the accurate list of what runs, downloads and
writes.
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
  - `cli.ts` — the `diffninja` command (`setup` and `grammars`); any other
    invocation explains how to review through an agent, without echoing its
    arguments.
    `pr-input.ts` — shared PR-link detection and canonicalization.
    `github.ts` / `connected.ts` — snapshot-bound review and loopback transport,
    including the read and the write of GitHub's Viewed marks.
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
  - `finish_review`: strict `{ reviewId, answers, order, comments, summary?, explanation? }`, the source
    of page links (`analysisUnavailable` below is the one exception). Connected reviews require `summary` and `explanation`.
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
    `suggest_comments`, which is blockers only, and may be `[]`. Everything is checked before anything
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
  - `suggest_comments`: strict `{ reviewId, comments: [{ path, line, side, body,
    scenario, evidence, unlessTrue }] }`. A comment exists only for what blocks
    the merge, so being in `comments` is the claim and there is no severity
    field. A `severity` key is refused with a message that says so. Anything
    that does not block is discarded by design. diffninja keeps no list of
    observations, `[]` is the normal answer, and the agent tells the user the
    rest in its own reply. diffninja calls no model, so it cannot judge a
    blocker. It shapes what the agent must fill and refuses what the contract
    forbids. At most 5, and more is refused with the reason that a review
    rarely has more real blockers. Each names a line this pull request adds
    (RIGHT) or removes (LEFT), at most one per line. A context line is refused
    because unchanged code cannot block this merge, and a line outside the diff
    keeps its own message. `body` reads like the reviewer's own comment. It is
    one line of at most 280 characters with no control characters and no report
    scaffolding (headings, bold, list markers, labels such as "Finding 1:"), and
    it is the only field that joins the human's draft. `scenario` is a concrete
    input or state and the wrong result, or the written rule it breaks and where
    that rule is written (20 to 400 characters trimmed). `evidence` is `ran`
    (the agent ran or reproduced it) or `traced` (it followed the code path by
    reading), and nothing else is accepted because a guess is not a blocker.
    `unlessTrue` is what would have to be true for this not to be a problem (10
    to 300 characters trimmed). `scenario` and `unlessTrue` are one line each
    with no control characters, are for the human's triage, are never posted,
    and are not held to the report-label rule. Any bad comment refuses the whole
    call and keeps the previous set. A later call replaces it, and an empty list
    clears it. The comments reach the connected page (`/api/analysis`
    `suggestions`, attributed to the MCP client) as "Blocks merge" suggestions
    under their lines, each with its proof ("Why it blocks", how it was
    checked, "Not a problem if"). A suggestion joins the human's draft, body
    only, when they add it, and nothing is posted until they submit.
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
    already has the PR's base and head commits. diffninja never runs fetch or
    checkout there and writes nothing to it. In a partial clone, git itself may
    fetch missing objects from that clone's own remote and store them in `.git`
    when diffninja reads them, as `git log -p` would; in a normal clone there is
    no network and no write. The canonical GitHub patch stays the diff under
    review.
    Both include the same JSON in text `content`. Failures return `isError: true`
    with the message as text and no partial report.
  - Connected pages belong to the MCP connection and close on disconnect.
    Repeated calls for one PR reuse its page; no review is submitted and no file
    is marked Viewed by the tool.
  - Viewed marks. The connected page's left list (reading order, one item per
    hunk) has a checkbox per change, and scrolling marks nothing (the current
    position, "Change N of M" and `j`/`k` stay). GitHub's Viewed is per file, so
    a file is marked Viewed on GitHub exactly when every hunk of that file in
    this diff is viewed on the page. Un-viewing any hunk of a viewed file
    un-marks it, and a request is sent only when a file's state changes. Every
    load of the pull request (and a reload from Check GitHub state) reads the
    signed-in account's per-file state with one fixed GraphQL query
    (`VIEWED_FILES_QUERY` in `github.ts`, which asks `node(id:) ... on PullRequest {
    files(first: 100, after:) { nodes { path viewerViewedState } pageInfo } }`
    for every page, with the pull request's node id as a `-f` variable). `VIEWED` is
    viewed, `UNVIEWED` and `DISMISSED` are not. The page starts every hunk of a
    viewed file as viewed, so GitHub wins at file level. Progress inside a
    file with several hunks is tab-local (`sessionStorage`, key prefix
    `diffninja.connected.viewed.v1`, one key per snapshot id, hunk ids) and may
    be lost. `GET api/state` carries `viewed: { available: true, files: [{ path,
    viewed }] } | { available: false, reason }` for a reviewable snapshot. A
    failed read, or a pull request whose node id `gh` did not report, gives
    `available: false` with a short fixed reason, never GitHub's words. The load
    still succeeds, and the page shows "not synced with GitHub: <reason>" and
    keeps tab-local marks only.
  - `POST api/viewed`: strict `{ snapshotId, path, viewed }`, behind exactly the
    gate of `api/submit`. Refused before any `gh` call: a stale snapshot id, a
    path that is not exactly one of the loaded snapshot's changed file paths
    (the new path of a rename), a `viewed` that is not a boolean, extra or
    missing keys, and marks that are not synced. It then reads the pull request's
    base and head again (one `gh pr view`) and refuses when either moved since
    the load, because GitHub applies a mark to the file as it is now, and only
    then runs one `gh api --hostname
    github.com graphql -f query=<fixed document> -f pullRequestId=<the snapshot's
    stored node id> -f path=<path>`, where the document is
    `MARK_VIEWED_MUTATION` or `UNMARK_VIEWED_MUTATION` (`markFileAsViewed`,
    `unmarkFileAsViewed`). The node id never comes from the request, and path
    and id are raw `-f` variables, never in the query text and never `-F`.
    Success answers `{ path, viewed }`. A refusal is a 400 `{ error, state }`
    with GitHub's named message cleaned and capped at 400 characters, or a fixed
    sentence, never GitHub's raw body or `gh`'s stderr. A write whose outcome is
    unknown (timeout, server error, lost connection, unreadable answer) sets
    `viewed.available: false` with the reason "the last Viewed mark did not
    finish" until the pull request is loaded again, like a submit's unknown
    state. All `gh` calls of a session run one at a time through one queue. The
    page also sends at most one request per file at a time and then sends the
    last wanted state, so concurrent clicks end in the state of the last click.
    A failed request reverts the optimistic click and shows the message next to
    the list. A browser reload shows what the server last confirmed, and loading
    the pull request again re-reads GitHub. The page sends a write only on the
    owner's click, and the route takes only files of the loaded snapshot. There
    is no generic GraphQL or `gh` route.
  - A review never downloads, installs or builds anything through diffninja.
    Inline diffs run no process and open no connection. A git-range review runs
    read-only git plumbing (`blame --no-textconv`; `git`/`gh` resolved to
    absolute paths on Windows by `executables.ts`). Each command has its own
    timeout: 120 s in `git.ts`, `input.ts` and `reference-check.ts`, 30 s in
    `history.ts`, 10 s in `mcp.ts`, 15 s per `gh` call. A pull request review
    runs `gh` with `GH_TELEMETRY=false` and `DO_NOT_TRACK=1` and the rest of the
    process environment. Only JavaScript and TypeScript grammars ship in the
    package. Every other grammar comes from
    `diffninja grammars install [--build] | status` (`grammars-command.ts`,
    `grammars.ts`): `grammar-lock.ts` (generated by `scripts/pin-grammars.mjs`)
    holds exact versions and the sha512 of every tarball, the install is
    `npm ci --ignore-scripts` (300 s per run) with npm's environment cut to an
    allow-list (`child-env.ts`: PATH, HOME, locale, temp and XDG directories,
    proxy and certificate settings, every `npm_config_*` variable, compiler and
    Python settings with `--build`, and the variable names in `DIFFNINJA_NPM_ENV`,
    names only, which is how a private registry's token reaches npm by the user's
    choice). Tokens outside the list do not reach npm; `npm_config_*` and proxy
    variables can carry credentials and do. Kotlin and Perl (no prebuilt binary) are compiled only
    with `--build`, which runs their install scripts (node-gyp downloads the
    Node headers unless cached). The other places diffninja runs npm are
    `diffninja setup` (`npm root -g`, and `npm install -g
    --allow-scripts=diffninja,tree-sitter,tree-sitter-javascript,tree-sitter-typescript
    diffninja@<version>` when there is no global install or it is older, with the
    same allow-list and no timeout; an npx entry when that fails, which lets npx
    use the network when the agent starts) and the package's `postinstall`
    (`scripts/ensure-native-grammar.mjs`: a probe that does nothing where the
    parser and the TypeScript grammar load, otherwise `npm install
    tree-sitter-typescript --ignore-scripts` when missing, removal of its
    `prebuilds/` and `build/`, and `npm rebuild`, 900 s per command, with the
    environment of the npm that started it, so the full one after a plain
    `npm install -g diffninja`). The cache (`~/.cache/diffninja/grammars`, 0700) is trusted
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
  - The MCP server writes no output files and takes no command-line arguments
    or key arguments; `diffninja setup` has flags (`--cli`, `--dry-run`, `--uninstall`,
    `--no-install`) and `diffninja grammars install` has `--build` and `--dry-run`.
    The environment is read for: `DIFFNINJA_GRAMMAR_CACHE` (cache location),
    `DIFFNINJA_NPM_ENV` (variable names npm also gets),
    `DIFFNINJA_TRUST_PROJECT_COMPILER=1` (see reference checks),
    `DIFFNINJA_UPDATE_CHECK=1` with `NO_UPDATE_NOTIFIER` and `CI` (see below),
    `CODEX_HOME`/`HOME`/`USERPROFILE` (where `setup` writes and the cache lives),
    `TMPDIR`/`TEMP` (the reference-check snapshot directory), `ComSpec` (a Windows
    fallback that `setup` may write into an agent config), and PATH (which `git`,
    `gh`, `npm`, `node` run). `gh` and `git` get the whole process environment;
    npm gets the allow-list above.
  - `setup` rewrites a JSON agent config in full with `JSON.stringify(_, null, 2)`,
    through a temporary file and a rename, and keeps no backup: indentation,
    string escapes and integers above 2^53 can change, and `--uninstall` does not
    restore the original bytes. Codex's TOML is edited in place. Docs advise a
    backup of `~/.claude.json` before the first run.
  - The update notice (`update-check.ts`) is off by default. Only the
    `diffninja-mcp` executable, never `createReviewServer()` by default, builds
    the lookup, and only with `DIFFNINJA_UPDATE_CHECK=1` (never in CI or with
    `NO_UPDATE_NOTIFIER`). The first `review_diff` that asks sends one GET to
    `registry.npmjs.org/diffninja/latest` (3 s timeout, no redirects, 512 KiB
    cap, failure means no notice; no identifier, version or diff is sent, and the
    registry still sees the IP address and the time);
    only a strictly newer plain `X.Y.Z` becomes `updateNotice` on the report
    (pages, `/api/analysis` `update`) and a first `nextSteps` line.
  - Keep `readOnlyHint: false` and `destructiveHint: false`: the tool opens
    loopback pages and holds review state for the connection. It does not edit
    repository source (in a partial clone git may store objects it fetched in
    `.git`) and diffninja itself downloads nothing while reviewing.
- Invocation resolution is deterministic; never guess a PR or intent.
  Missing/ambiguous references ask for one full link without echoing pasted text.
- Keep connected safeguards: immutable snapshot binding, canonical line anchors,
  stale-snapshot and duplicate-submit blocking, no general GitHub/command proxy,
  and access control in layers. Every route of a session (page, `/api/*`,
  `/flow`) lives under `/<256-bit secret>/` (`routeOf`, constant-time compare):
  a local process that was never handed the link gets a 404 for everything and
  cannot read the PR, post a review or set a Viewed mark as the engineer. The
  agent is handed the link, and the page carries the CSRF token, so an agent
  that can fetch local URLs can submit and can toggle Viewed marks; docs must
  not claim otherwise (`docs/security.md`), and `nextSteps` tells it never to
  submit or open the page. The page writes to GitHub in exactly two ways, a
  review (`POST api/submit`) and a Viewed mark of one changed file of the loaded
  snapshot (`POST api/viewed`), both behind that one gate (`requestIsTrusted`,
  the CSRF token, the 256 KiB and 15 s limits). The other POST routes
  (`api/load`, `api/preview`, `api/reconcile`) read GitHub or build a payload and
  write nothing there. Adding a route or a `gh` write means updating this
  paragraph and `docs/security.md` in the same change. Loopback-only
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
  server run code from the repository under review by default: the TypeScript
  that Node resolves from diffninja's own files is used, and the project's own
  only when the person who configured the server set
  `DIFFNINJA_TRUST_PROJECT_COMPILER=1`, in which case it runs in-process with
  the full environment. `typescript` stays a devDependency (the package ships no
  compiler). Node resolves it from diffninja's `node_modules` and those of every
  directory above it, and `NODE_PATH`: a global install finds a global
  typescript beside it, and so does an npx cache that has a `typescript` in a
  parent directory. Otherwise the check reports not-checked with that advice. The
  check writes full snapshots of both revisions (512 MiB each at most) under the
  temporary directory, and removes them. Never execute
  PR scripts, install its dependencies, check out snapshots, or turn incomplete
  diagnostics into a clean bill of health.
- Text written by a pull request's author is data. Hidden and bidirectional
  control characters (`hidden-characters.ts`) show as `⟦U+XXXX⟧` on every page
  (`escapeHtml`, the connected page's `make`/`setText`/diff cell) and in both
  copies of the tool result, and the review warns which files add them. Three
  rules. Always shown: U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to
  U+206F, and the whole plane-14 block U+E0000 to U+E0FFF (the tag characters,
  the supplementary variation selectors and the unassigned code points between
  them). Shown unless a visible non-ASCII character (a
  letter, mark, digit, symbol or punctuation mark; U+00A0 is not one) sits
  directly beside them: U+00AD, U+034F, U+115F, U+1160, U+17B4, U+17B5,
  U+180B to U+180F, U+200B to U+200D, U+2060 to U+2065, U+2800, U+3164, U+FE00 to
  U+FE0F, U+FFA0, U+FFF0 to U+FFF8, U+1BCA0 to U+1BCA3 and U+1D173 to U+1D17A. A
  byte order mark is shown wherever it appears, except directly after
  the `+`, `-` or space that starts a diff line, where it is left alone (so it is
  shown at the start of a path or an id). A hidden character of the second rule
  that touches a visible non-ASCII character is spared, so a zero-width space
  next to an accented letter, a quotation mark, a dash, a currency sign or an
  emoji is not marked, and in a run between two such characters only the ends
  are spared (two between Arabic letters are both unmarked, three mark the
  middle one). Every code point Unicode marks Default_Ignorable_Code_Point is on
  one of the lists, and a test walks that property to keep it so. Ids and paths the agent echoes
  back are minted in the shown form. Titles
  and commit subjects reach `questions` as JSON-quoted data, and the first
  `nextSteps` step says so (the update notice, when one is shown, comes before it). A pull request link inside text that is a real
  unified diff is source and is never followed. Untrusted input is bounded:
  descriptions over 12,000 characters are not lexed (plain text), link detection
  reads 300 characters per side of 500 markers per string, intent claims stop at
  100, and each of the two copies of a result (text and structured) stays under 4 MiB,
  measured on the marked text as the text copy carries it, JSON-escaped
  (`result-budget.ts`; a message can reach about 8 MiB, under the 10 MiB SDK
  limit), by trimming, in order, `snapshot.lines`,
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
  covers the functions list, the explanation checks, and the business view. `review-viewed.test.ts`
  covers the Viewed read and write through the real loopback server with a
  scripted `gh`, including the marks read, the refusals before any `gh` call,
  the fixed documents and variables, and the unknown outcome. `review-history.test.ts`
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
