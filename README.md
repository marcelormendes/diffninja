# diffninja

Focused PR reviews. Jev reads the diff behind the scenes; you review only what
matters.

Paste a diff (or point at a git range) and diffninja returns a ranked HTML
report: risky hunks first with reasons, trivial ones auto-passed in one line.
No more reading every line to find the three that count.

## How it works

1. **Deterministic checks first.** No-op hunks, blank-only doc changes, and
   oversized hunks are settled in code without calling any model. Oversized
   hunks go to manual review, never truncated, never auto-passed.
2. **One Jev call per hunk.** TypeSafe's Jev (a System One model) answers
   small typed questions about each hunk: risk score, bug likelihood, change
   category. No text generation, no parsing.
3. **Ranked in code.** Answers are combined with weights into a 0-100 priority
   and sorted into attention / uncertain / low / passed. Uncertain calls fail
   closed to human review instead of degrading into a pass.

## Install

```bash
npm install -g diffninja
```

## Usage

```bash
# review a diff file
diffninja --diff change.patch

# review piped diff text
git diff main...HEAD | diffninja --stdin

# review a git range directly
diffninja --repo /path/to/repo --from main --to HEAD

# choose output (JSON is written next to the HTML)
diffninja --diff change.patch --out review.html

# offline demo, no API calls
diffninja --diff change.patch --mock
```

Live mode needs `TYPESAFE_API_KEY` in the environment (get one at
https://console.typesafe.ai). Reports contain source code, keep them private.
diffninja never approves, blocks, or merges anything. A human still owns the
decision.

## Also bundled: calldiff

This repo is a fork. The call-flow diff engine (`calldiff diff|tree|reach`)
comes from [calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq
Kancharla, MIT licensed (see LICENSE). diffninja uses its call graphs to show
which flows each hunk touches.

## Dev

```bash
npm run build   # tsc -> dist/
npm run lint    # oxlint
npm test        # vitest run
npm run dev -- --diff examples/review/checkout.patch --mock
```
