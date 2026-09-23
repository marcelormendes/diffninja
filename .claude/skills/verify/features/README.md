# diffninja verification map

This directory is the maintained source for verifying diffninja's user-facing behavior. Read this index before driving anything, then use the matching feature file as the recipe. The harness is `node .claude/skills/verify/drive.mjs`, described in `../SKILL.md`.

## Baseline preconditions

- Run `npm run build` after any change under `src/`.
- Run `node .claude/skills/verify/drive.mjs doctor` and require every line to read `PASS`.
- Run every command from the repository root.
- Every drive spawns its own server. Never attach to, or kill, a `diffninja-mcp` process the user's agent CLI started.

## Driving conventions

- Pass `review_diff` arguments exactly as a host would, as strict JSON in `--args`. Build diff text with `node -e` and `JSON.stringify` so quoting survives.
- Pass `"mode":"static"` unless the feature is connected review.
- Fetch pages through the harness or, for visual proof, through the browser during `--hold`. Pages send `Host` checks, `no-store`, and a CSP.
- Assert against the saved `review_diff.json` and the page HTML, not against source code.

## Proof and skip reporting

- Keep the evidence directory the harness prints, including `request.json`, `review_diff.json`, the page HTML, and `checks.json`.
- For a mutation, keep the before and after views: the page before and after `record_answers`, and `git status --short` in the reviewed repository before and after.
- Record the feature ID and the entry point with every artifact.
- Report an unreachable path with the command you tried and the precondition that was not met, for example no `gh` authentication or no pull request link from the user.
- Do not report connected review as verified through a static drive, or the reverse.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph about the user-visible behavior, followed by four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs`, and `Gotchas`.

## Features

- [Static review of an inline diff](./static-inline-review.md) covers ranking, statuses, change facts, questions, and the report URL for pasted diff text.
- [Static review of a git range](./git-range-review.md) covers repository ranges, call flows, and project context from local git.
- [Answer review questions](./record-answers.md) covers `record_answers` acceptance, refusal, replacement, and attribution on the page.
- [Record the agent's reading order](./record-order.md) covers `record_order` acceptance, refusal, replacement, and the attributed list on the page.
- [Report page](./report-page.md) covers the loopback page a human reads: agenda, views, filters, and its security headers.
- [Connected pull request review](./connected-pr-review.md) covers loading a GitHub pull request through `gh` into a loopback review page.
- [Setup registration](./setup.md) covers `diffninja setup` detection and config edits, and what `--dry-run` actually does.
