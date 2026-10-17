# Blocker eval

Measures how good the blockers are that an agent suggests through diffninja on
real pull requests: how many are real, how many are false alarms, and how many
known problems it misses. Not part of the npm package (`package.json` `files`
lists only `dist/`, one script and the shrinkwrap).

- `manifest.json`: the labelled set and the prompt every run uses. A `problem`
  case is a merged pull request whose own diff introduced a bug that a later
  fix or revert names (`problems[]`: file and line at the PR head, what goes
  wrong, the link that proves it). A `clean` case was merged with no later fix,
  revert or bug report tied to it.
- `run.mjs`: prepares the clones, runs the reviews, and lists the results.
- `fake-gh.mjs`: the `gh` the reviews see (below).
- `results-v1.json`: the scored first run (each blocker judged real, false
  alarm or unclear, with the reason; each known problem found or missed).
- `results-v2.json`: the second round, scored the same way: Sonnet on main
  with no rule change, two variants of guidance that asks the agent to test its
  suspicions (texts in `rules`; Sonnet with both, Opus with B), and the
  comparison with v1. The variants were not merged: they found no more known
  problems and Opus raised two false alarms on clean pull requests.
- `results-v3.json`: the run-to-run spread and one context experiment, Sonnet
  only. The same code found 4 to 7 of the 15 known problems over four runs, so
  a difference of two is noise. Adding, next to each hunk, the test files that
  name each function it changes found 5 to 6 over three runs, with the same
  false alarm on a clean pull request, so it was not kept (the prototype is
  described in `prototype`).

## Run it

Needs `gh` signed in (for `prepare` only), `claude` on PATH, and a build
(`npm run build`). The work directory must be outside this repository.

```bash
npm run build
node eval/run.mjs prepare --work /tmp/dn-eval            # clones, recordings, grammars
node eval/run.mjs review  --work /tmp/dn-eval --model sonnet --jobs 3
node eval/run.mjs review  --work /tmp/dn-eval --model opus --budget 8
node eval/run.mjs summary --work /tmp/dn-eval --tag opus
```

`--only id,id` picks cases, `--tag` names a run (default: the model), and a
case that already has a result is skipped unless `--force`. Each case writes
`runs/<tag>/<id>/transcript.jsonl` (the full `stream-json` session),
`stderr.log`, and `result.json`: cost, turns, whether `finish_review` was
accepted, the summary, the blockers that stand (the last accepted
`finish_review` or `suggest_comments`), every Bash command with the start of
its output (to check an `evidence: "ran"` claim), and the final reply.

## How a review runs

`claude -p "Review <PR link> with diffninja. My clone is at <dir>. Answer its
questions, then give me the page."` (the prompt in `docs/pilot.md`), with
diffninja as its only MCP server (`--strict-mcp-config`), no user or project
settings (`--setting-sources ""`), all tools but WebFetch and WebSearch, and a
dollar cap per run (`--budget`, default 5).

These pull requests are merged, and diffninja refuses a merged one, so the
review sees each pull request as open, as it was before the merge:

- `prepare` records GitHub's own answers to the read calls diffninja makes
  (`gh pr view`, the diff, the file list) with the state set to `OPEN`.
  `fake-gh.mjs`, first on PATH during a review, serves them and refuses every
  other call and every write. gh 2.87 reports `headRepository.nameWithOwner`
  as `""`, which diffninja 0.4.2 reads as "head repository unavailable"; the
  recording fills it from the owner and name.
- The clone has the PR head checked out, a branch at the base, no remote, and
  no later commits (its objects are borrowed from a bare cache clone, and only
  the base and head are referenced), so its history cannot show the fix.
- The run has no gh or git credentials (`GH_CONFIG_DIR` empty, no token
  variables, an empty global git config) and `npm_config_ignore_scripts=true`.
  Nothing can be posted to GitHub.

The agent still has Bash and could reach the network on its own; a transcript
shows it if it did.

## Score it

Read each `result.json`: for each blocker, decide real, false alarm or unclear
against the code and the case's `problems`; for each known problem, whether a
blocker names it (same defect, not just the same file). For a blocker with
`evidence: "ran"`, check the Bash commands show it ran something that proves
it. Record the judgments next to `results-v1.json`.
