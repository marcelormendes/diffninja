# Connected pull request review

When the user gives a github.com pull request link, `review_diff` (mode `auto` or `connected`) loads that exact pull request through the authenticated `gh` CLI. It returns a loopback `url` where a human reads the canonical diff beside its reading order and change facts, and can post their own review. The result also carries the local analysis of exactly that snapshot: `reviewId`, `reportUrl`, `analysisScope`, and `report` (or `analysisUnavailable`). The tool itself never submits a review.

## Sub-features

- `connected-load` loads one pull request snapshot bound to its head SHA and returns `{ mode: "connected", url, pr, snapshot }`.
- `connected-analysis` returns the local analysis of that snapshot, served to the page by `GET /api/analysis`.
- `connected-reuse` reuses the same page when the same pull request is requested again on one connection.
- `connected-refusals` refuses a missing or ambiguous link, `expectedOutcome` or `referenceProject` alongside a link, and never falls back to a local diff.
- `connected-clone` uses an optional absolute `repo` clone for call flows only when it already has the base and head commits. It never fetches, checks out, or writes in it.

## How to get to it (user POV)

- The user asks their agent to review a pull request and pastes its full link. The agent calls `review_diff` with `pr` (or `input`, or `diff` containing the link), and gives the user the returned `url`.

## Driving it with drive.mjs

Preconditions:

- Doctor reports `gh CLI: authenticated`.
- The user supplied a pull request link, or approved a specific public one. Never guess or search for one.

- **Load it.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"connected","pr":"<full PR link>"}' --hold 120`. `url` and `reportUrl` each pass the loopback, 200, CSP, and foreign-Host checks.
- **Read the state.** During the hold, open `url` in Chrome. The `Review identity` and snapshot sections show the pull request title and head SHA from `snapshot` in `review_diff.json`.
- **Refuse without a link.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"connected","diff":"no link here"}'`. The result is an error asking for one full pull request URL, and no `gh` call happens.
- **Proof.** Keep `review_diff.json` (`snapshot`), `url.html`, and the screenshots.

## Gotchas

- The page can POST `/api/submit`, which posts a real GitHub review as the `gh` user. Never choose Submit during verification. Use `/api/preview` only.
- SecondNature-com/rbp-api pull requests are strictly read-only for this project. Load and read them, but never comment, preview-then-submit, or reconcile.
- A pull request link anywhere in the inputs of an `auto` call starts connected review. That includes a link inside diff text.
- Connected review reads GitHub on every load, so its results change as the pull request changes. Record `snapshot.headSha` with the evidence.
