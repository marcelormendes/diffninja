# Finish a review and get its page

`review_diff` returns the hunks and questions but no page link. The agent reads the change and sends its whole reading in one `finish_review` call:
- `answers`: an answer to every question;
- `order`: every hunk id exactly once;
- `comments`: its line comments, or `[]` for none;
- `summary`: required for connected PR reviews, a plain-English goal in one paragraph (at most 80 words and 600 characters); optional for static.

diffninja checks all of it before keeping anything. Only a complete, valid call returns the links: `reportUrl`, plus `url` for a pull request review. So every page a human opens already carries the agent's answers, its order, and its comment decision. No host can skip them and still show a page.

## Sub-features

- `finish-gate`: `review_diff` results carry no `url` or `reportUrl` (except a connected review whose analysis is unavailable, which has nothing to finish).
- `finish-refuse` refuses the whole call, keeping nothing and handing out no link, when the reading has any of these problems:
  - it leaves a question out;
  - the order leaves out or repeats a hunk;
  - a comment breaks the `suggest_comments` rules;
  - `comments` is missing;
  - a connected review's `summary` is missing, or a supplied summary is blank, oversized, multiline, or contains Markdown scaffolding.
- `finish-accept` applies the whole reading and returns `{ reviewId, answered, ordered, suggested, summarized, reportUrl, url?, next }`; `summarized` is the number of summary characters sent.
- `finish-repeat`: a later `review_diff` of a finished pull request returns its `url` and `reportUrl` again.

## Verify

- **Drive it.** Every `drive.mjs review` run exercises it. `review_diff hands out no page link before finish_review`, `finish_review refuses a reading that leaves a question out`, and `finish_review accepted the whole reading` all PASS.
- **Connected.** Supply `--summary '<your concise reading of the PR goal>'` and optionally `--suggest`. The missing-summary refusal, attributed PR goal, order, answers, and suggested-comment checks all PASS.
- **Proof.** Keep `review_diff.json`, `finish_review.refused.json`, `finish_review.json`, and `url.analysis.json`.
