# Connected pull request review

When the user gives a github.com pull request link, `review_diff` (mode `auto` or `connected`) loads that exact pull request through the authenticated `gh` CLI. It returns a loopback `url` where a human reads the canonical diff beside its reading order and change facts, and can post their own review. The result also carries the local analysis of exactly that snapshot: `reviewId`, `reportUrl`, `analysisScope`, and `report` (or `analysisUnavailable`). The tool itself never submits a review and never marks a file Viewed. On the page, a click on a change in the left list does mark the change's file Viewed on GitHub, as the `gh` user, once every change of that file is ticked.

## Sub-features

- `connected-load` loads one pull request snapshot bound to its head SHA and returns `{ mode: "connected", url, pr, snapshot }`.
- `connected-analysis` returns the local analysis of that snapshot, served to the page by `GET /api/analysis`.
- `connected-reuse` reuses the same page when the same pull request is requested again on one connection.
- `connected-refusals` refuses a missing or ambiguous link, `expectedOutcome` or `referenceProject` alongside a link, and never falls back to a local diff.
- `connected-clone` uses an optional absolute `repo` clone for call flows only when it already has the base and head commits. It never fetches, checks out, or writes in it.
- `connected-viewed-read` reads the signed-in account's per-file Viewed state from GitHub (GraphQL) each time the pull request loads, and `GET api/state` carries it as `viewed`. The page starts every hunk of a viewed file as viewed.
- `connected-viewed-write` marks or unmarks one changed file of the loaded snapshot through `POST api/viewed`, behind the same gate as `api/submit`. The left list's checkboxes send it. Scrolling marks nothing.

## How to get to it (user POV)

- The user asks their agent to review a pull request and pastes its full link. The agent calls `review_diff` with `pr` (or `input`, or `diff` containing the link), and gives the user the returned `url`.
- On the page, the user ticks a change in the left list (a checkbox named "Mark change N of <file> as viewed"). Clicking it does not jump to the change. The progress line says "N of M viewed".

## Driving it with drive.mjs

Preconditions:

- Doctor reports `gh CLI: authenticated`.
- The user supplied a pull request link, or approved a specific public one. Never guess or search for one.

- **Load it.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"connected","pr":"<full PR link>"}' --hold 120`. `url` and `reportUrl` each pass the loopback, 200, CSP, and foreign-Host checks.
- **Read the state.** During the hold, open `url` in Chrome. The `Review identity` and snapshot sections show the pull request title and head SHA from `snapshot` in `review_diff.json`.
- **Refuse without a link.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"connected","diff":"no link here"}'`. The result is an error asking for one full pull request URL, and no `gh` call happens.
- **Proof.** Keep `review_diff.json` (`snapshot`), `url.html`, and the screenshots.

### Viewed marks

**NOTE.** Never drive this against a real pull request, and above all not against the owner's work repositories (for example SecondNature-com/rbp-api). Ticking a change WRITES to GitHub. It marks a file Viewed as the `gh` user, and unticking clears it. Use a fake `gh` on PATH only. Against a real pull request, load it and read it, nothing more. Loading runs one GraphQL read of the Viewed marks, which is a read.

Preconditions:

- A fake `gh`, described below, first on PATH for this drive only. Check with `command -v gh` in the same shell that starts the drive. After the load, the fake's call log must show the loader's calls, starting with `--version`. An empty log means the real `gh` ran, so stop.
- A browser that can reach `127.0.0.1`. If the claude-in-chrome tools cannot, use a local headless Chrome or Chromium through playwright-core. Record which browser and version you used.

- **Build the fake `gh`.** It is an executable named `gh` in a scratch directory outside the repository. Start the drive with `PATH=<scratch>/bin:$PATH`. It answers exactly the argv the loader sends and exits non-zero with a loud message for any other argv, so a call that would have reached GitHub fails visibly.
  - `gh --version` (2.45.0 or newer), `gh auth status` (for doctor), and `gh api --hostname github.com -H <accept> user`.
  - `gh pr view <url> --json <fields>`, with the pull request's GraphQL node `id` among the fields.
  - `gh api --hostname github.com -H "Accept: application/vnd.github.diff" repos/OWNER/REPO/pulls/N` for the diff, and the `--paginate` reads of `repos/OWNER/REPO/pulls/N/files?per_page=100` and `.../reviews?per_page=100`. The file list must name every file of the diff.
  - `gh api --hostname github.com graphql -f query=<document> -f pullRequestId=<id>` with an optional `-f after=<cursor>` for the read, and a `-f path=<file>` for a mutation. The read answers `{"data":{"node":{"files":{"nodes":[{"path","viewerViewedState"}],"pageInfo":{"hasNextPage","endCursor"}}}}}`. A mutation answers `{"data":{"markFileAsViewed":{"clientMutationId":null}}}`, or the same with `unmarkFileAsViewed`.
  - Keep the fake GitHub's state in a file (path to `VIEWED`, `UNVIEWED` or `DISMISSED`), append one line per call with its argv to a call log, and read a control file for failure injection. Useful switches are a refused mutation (a GitHub-style `FORBIDDEN` body), a `502`, a delay in the mutation, a failing read, and a page size of 2 for the read.
  - Make it strict. It should reject a mutation whose keys are not exactly `query`, `pullRequestId` and `path`, and a `pullRequestId` it does not know. Then a wrong argument shows up as a failure of the fake, not as a pass.
  - The fixture needs a file with three hunks, a single-hunk file, and a file the fake reports `DISMISSED`. A renamed file is worth adding, because its mark must use the new path.
  - An example built for this feature is at `/tmp/viewed/kit/bin/gh` while it lasts, with its state in `/tmp/viewed/state/viewed.json`, `calls.log` and `ctl.json`. Treat it as a sketch of the approach. Nothing in this repository depends on it.
- **Load it.** Run the drive with the fake on PATH and the fixture's link: `PATH=<scratch>/bin:$PATH node .claude/skills/verify/drive.mjs review --args '{"mode":"connected","pr":"https://github.com/OWNER/REPO/pull/N"}' --summary '<your own reading of the fixture pull request>' --explain FILE --hold 600`. Open the printed `url`.
- **Read the marks.** `GET <url>api/state` (with the loopback `Host`) has `viewed.available: true` and one `{ path, viewed }` per changed file, `true` only where the fake says `VIEWED`. On the page, every hunk of a viewed file starts ticked and `DISMISSED` does not.
- **Scroll.** Scroll the whole page. No item becomes ticked (`aria-checked` stays `false`, and the call log gains nothing). The current-change highlight and "Change N of M" still follow the scroll, and `j` and `k` still step.
- **Click.** Tick the only hunk of a single-hunk file. The call log gains exactly one call, `gh api --hostname github.com graphql -f query=mutation... -f pullRequestId=<id> -f path=<file>`, the fake's state changes for that file, the item shows `aria-checked="true"`, the page does not jump, and the progress line counts one more viewed. Untick it and expect one call with `unmarkFileAsViewed`.
- **A file with several hunks.** In the three-hunk file, tick the first two hunks and expect no new call. Tick the third and expect one call that marks the file. Untick any one and expect one call that clears it. Tick that hunk again and expect one more mark.
- **Quick clicks.** Delay the mutation in the control file and click one item several times. The call log shows one call at a time, the fake ends in the state of the last click, and the page agrees with it.
- **Reload.** Reload the browser tab. Files the fake holds as `VIEWED` come back ticked. Partial ticks of the three-hunk file come back from `sessionStorage` (keys under `diffninja.connected.viewed.v1`). Change a mark in the fake's state file and load the pull request again through the page (`POST api/load`, or **Check GitHub state**), and expect the change to show.
- **A refusal.** Make the next mutation fail with a GitHub-style refusal. The click reverts, the message shows next to the list, and nothing else on the page changes. The message is GitHub's named message, cleaned and cut to 400 characters, or a fixed sentence. It is never gh's stderr or the raw body.
- **An unknown outcome.** Make the mutation return a `502`, or hold it past 15 seconds. The click reverts, and `GET api/state` has `viewed.available: false` with the reason "the last Viewed mark did not finish". The page shows "not synced with GitHub: the last Viewed mark did not finish", keeps ticks in the tab, and sends nothing more until the pull request is loaded again.
- **A failed read.** Fail the read in the control file and load again. The page still loads, `viewed.available` is `false` with a short fixed reason, the note reads "not synced with GitHub: <reason>", and a click sends no request.
- **The route on its own.** Read the CSRF token from the page (`var CSRF = "..."`) and POST `<url>api/viewed` with it and `Origin` set to the page's origin. For each of these, expect a refusal and no new line in the call log. A snapshot id that is not the loaded one, a path that is not in the pull request (also `./app.ts`, or another case), `"viewed":"true"`, an extra key (`pullRequestId`, `query`), and a missing key each get a 400. A missing or wrong CSRF token, a wrong `Origin`, `Sec-Fetch-Site: cross-site`, and a foreign `Host` each get a 403. A GET gets a 404, and so does any path without the secret prefix.
- **Look at it.** Take screenshots and read them, in the light and dark themes and in a 420 px window. Check that a ticked item is readable, the checkbox is reachable by keyboard with a visible focus, the error message is legible, and the note fits.
- **Proof.** Keep the fake's call log (every gh argv of the drive), its state file before and after each step, `api/state` before and after, the `GET api/state` from the failure cases, and the screenshots. Record the browser and version.

## Gotchas

- The page can POST `/api/submit`, which posts a real GitHub review as the `gh` user, and `/api/viewed`, which marks a file Viewed on GitHub as the `gh` user. Never choose Submit, and never tick a change, on a real pull request. Use `/api/preview` only. Drive `/api/viewed` and the checkboxes against the fake `gh` and nothing else.
- SecondNature-com/rbp-api pull requests are strictly read-only for this project. Load and read them, but never comment, preview-then-submit, reconcile, or tick a change (which marks a file Viewed).
- A file whose name git quotes in a diff (non-ASCII characters, quotes, backslashes) cannot be matched to the path GitHub lists, so the page keeps its ticks in the tab and sends nothing for it. Do not expect a mutation for such a file.
- The fake proves diffninja's side only. GitHub's real behavior of the two mutations and of the files query, GHES, token scopes, rate limits, `DISMISSED` semantics, and browsers other than the one you drove were not verified. Say so in the report.
- A pull request link anywhere in the inputs of an `auto` call starts connected review. That includes a link inside diff text.
- Connected review reads GitHub on every load, so its results change as the pull request changes. Record `snapshot.headSha` with the evidence.
