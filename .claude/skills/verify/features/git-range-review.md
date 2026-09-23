# Static review of a git range

An agent passes an absolute `repo` with `from` and `to` in mode `static`. diffninja compares the two endpoints, adds call flows from the local checkout, and attaches `project` context from local git: blame origins of removed lines, related reverts, applicable guideline paths, and sibling conventions for new files.

## Sub-features

- `range-diff` reviews the endpoint diff `from..to`, not a merge-base diff.
- `range-callflow` returns `callFlows` and a bounded `callFlow` tree.
- `range-project` returns `project` with `history` (`complete` or `shallow`), `reverts`, `guidelines`, and `conventions`, plus `items[].history`.
- `range-questions` adds history questions: `undoesFix`, `repeatsRevert`, `followsGuidelines`, and `followsConvention`.
- `range-readonly` never fetches, checks out, or writes in the repository.

## How to get to it (user POV)

- The user asks the agent to review a branch or a commit range in a local clone. The agent calls `review_diff` with `repo`, `from`, `to`, and `mode: "static"`.

## Driving it with drive.mjs

Preconditions:

- Doctor passes.
- The repository is a full clone. A shallow one reports `history: "shallow"`.

- **Snapshot the repository state.** Run `git status --short > <evidence>/git-status.before.txt`.
- **Review this repository's own commits.** Run `node .claude/skills/verify/drive.mjs review --args "{\"mode\":\"static\",\"repo\":\"$PWD\",\"from\":\"bce0b09\",\"to\":\"b8bb652\"}"`. Every line reads `PASS`, and `INFO` shows 6 items and 6 questions (as of b8bb652).
- **Read the project context.** Run `node -e 'console.log(JSON.stringify(require(process.argv[1]).structuredContent.project))' <evidence>/review_diff.json`. It prints `history: "complete"` and lists `AGENTS.md` among the guidelines.
- **Confirm no writes.** Run `git status --short` again and compare it with the snapshot. Nothing changed.
- **Refuse a relative repo.** Run `node .claude/skills/verify/drive.mjs review --args '{"mode":"static","repo":".","from":"HEAD~1","to":"HEAD"}'`. The error reads `Git range requires an absolute repo path.`
- **Proof.** Keep `review_diff.json`, `reportUrl.html`, and both `git status` snapshots.

## Gotchas

- The first range review in a language can install tree-sitter grammars through npm into calldiff's cache. It is slow and uses the network once.
- Large ranges take minutes. The harness allows a 15-minute tool timeout.
- `referenceProject` (a repository-relative tsconfig) turns on the TypeScript reference check for ranges only. It uses the installed compiler and never installs anything from the reviewed code.
