# Finish a review and get its page

`review_diff` returns the hunks and questions but no page link. The agent reads the change and sends its whole reading in one `finish_review` call:
- `answers`: an answer to every question;
- `order`: every hunk id exactly once;
- `comments`: its line comments, or `[]` for none.

diffninja checks all of it before keeping anything. Only a complete, valid call returns the links: `reportUrl`, plus `url` for a pull request review. So every page a human opens already carries the agent's answers, its order, and its comment decision. No host can skip them and still show a page.

## Sub-features

- `finish-gate`: `review_diff` results carry no `url` or `reportUrl` (except a connected review whose analysis is unavailable, which has nothing to finish).
- `finish-refuse` refuses the whole call, keeping nothing and handing out no link, when the reading has any of these problems:
  - it leaves a question out;
  - the order leaves out or repeats a hunk;
  - a comment breaks the `suggest_comments` rules;
  - `comments` is missing.
- `finish-accept` applies all three and returns `{ reviewId, answered, ordered, suggested, reportUrl, url?, next }`.
- `finish-repeat`: a later `review_diff` of a finished pull request returns its `url` and `reportUrl` again.

## Verify

- **Drive it.** Every `drive.mjs review` run exercises it. `review_diff hands out no page link before finish_review`, `finish_review refuses a reading that leaves a question out`, and `finish_review accepted the whole reading` all PASS.
- **Connected.** Add `--suggest`. `pull request page has the agent's order`, `has every answer`, and `has the suggested comments` all PASS.
- **Proof.** Keep `review_diff.json`, `finish_review.refused.json`, `finish_review.json`, and `url.analysis.json`.
