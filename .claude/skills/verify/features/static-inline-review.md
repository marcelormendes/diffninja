# Static review of an inline diff

An agent passes unified diff text to `review_diff` in mode `static` and gets back ranked hunks with statuses, priorities, reasons, change facts, closed-option questions, and a `reportUrl` for the human. No model is called and nothing leaves the machine.

## Sub-features

- `inline-rank` returns `items` in reading order with `status` values `attention`, `uncertain`, `low`, or `passed`.
- `inline-facts` attaches lexical change facts, each `yes` citing the changed line it rests on.
- `inline-questions` returns at most 36 `questions`, each with closed `options` that include `cannot-tell`.
- `inline-outcome` echoes `expectedOutcome` as untrusted claims at the top of the report.
- `inline-refusals` refuses bad input combinations with `isError` and no partial report.

## How to get to it (user POV)

- The user pastes a diff into their agent and asks for a review. The agent calls `review_diff` with `diff` and `mode: "static"`.
- The user pastes a diff without a mode. `auto` behaves as static unless the text contains a github.com pull request link.

## Driving it with drive.mjs

Preconditions:

- Doctor passes.
- `examples/review/checkout.patch` exists. It is the repository's own sample diff.

- **Review the sample.** Run the Drive example in `../SKILL.md` with `--answer cannot-tell`. Every line reads `PASS`, and `INFO` shows `"items":5` with statuses `attention, attention, attention, low, passed` and 10 questions (as of b8bb652).
- **Inspect the report.** Run `node -e 'const r=require(process.argv[1]).structuredContent;for(const i of r.items)console.log(i.status,i.priority,i.file)' <evidence>/review_diff.json`. The hunks print in report order.
- **Refuse two inputs.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"static","diff":"","from":"a","to":"b"}'`. It prints `FAIL review_diff succeeded — Choose exactly one input: diff or from with to.` and exits 1. Here that failure is the expected result.
- **Refuse pr in static.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"static","diff":"","pr":"https://github.com/o/r/pull/1"}'`. The result is an error, and no GitHub call happens.
- **Proof.** Keep `review_diff.json`, `reportUrl.html`, and `checks.json` from the sample drive.

## Gotchas

- An empty `diff` is valid and means no changes. It is not an error.
- Counts shift when ranking rules change. Assert the specific item or fact your change affects, not the total.
- Import-only hunks get trivial priority and no question. A test file is `attention` only for a limit change, a discarded failure, or a weakened gate.
