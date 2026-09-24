# Answer review questions

The agent's first answers arrive inside `finish_review` (see [finish-review.md](./finish-review.md)); `record_answers` updates them, choosing only from each question's listed options. Accepted answers appear on the report page beside their hunk, attributed to the MCP client's name and version. They never change status, priority, or order.

## Sub-features

- `answers-accept` records valid answers and returns `recorded` and `next`, never a page link.
- `answers-refuse` refuses the whole call when any answer names an unknown question, repeats one, or uses an unlisted option. Nothing is kept.
- `answers-replace` lets a later answer to the same question replace the earlier one.
- `answers-attribution` shows the client's `name version` on the re-rendered page.
- `answers-scope` accepts only a `reviewId` created on the same connection.

## How to get to it (user POV)

- The agent reads a question's hunks, then calls `record_answers` with `{ reviewId, answers: [{ questionId, choice }] }`.
- A human sees the answers on the report page, or on the connected pull request page for a connected review.

## Driving it with drive.mjs

Preconditions:

- Doctor passes.

- **Answer everything.** Run the static sample drive with `--answer cannot-tell`. `record_answers accepted every answer`, `record_answers refuses an unlisted option`, and `page shows the answers attributed to this client` all read `PASS`.
- **See the before and after.** Run `grep -c diffninja-verify <evidence>/reportUrl.html <evidence>/reportUrl.after-answers.html`. The first count is 0 and the second is greater than 0.
- **Read the refusal.** Open `<evidence>/record_answers.refused.json`. It has `isError: true`, and its text lists the question's real options.
- **Order is unchanged.** Compare `items[].id` in `review_diff.json` with the order on the page after answering. It is identical.
- **Proof.** Keep `record_answers.json`, `record_answers.refused.json`, and both page files.

## Gotchas

- `--answer first` picks each question's first option, which is usually a substantive answer rather than `cannot-tell`. Use it to see how answers render, not as a claim about the code.
- A `reviewId` from a finished drive is gone with its connection. You cannot answer across drives.
- Free text is rejected by the schema. `choice` is at most 40 characters and must match an option exactly.
