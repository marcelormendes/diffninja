# Pilot: reviewing real pull requests with diffninja

A short guide for engineers trying diffninja on their own pull request reviews,
and what to write down so we learn whether it helps.

## Set up (from this checkout)

```bash
cd /path/to/diffninja
npm install && npm run build
npm install -g .          # install this checkout globally
diffninja setup --dry-run # preview which agent configs change
diffninja setup           # register in Claude Code, Codex, OMP, pi
```

Setup finds the global install and registers `node …/dist/review/mcp-cli.js`
in each detected agent; restart the agent afterwards. After pulling new commits
here, run `npm run build && npm install -g .` again. You need `gh` 2.45.0+ signed
in (`gh auth login`). No API key: analysis runs locally.

## Review a pull request

In your agent (Claude Code, Codex, …):

> Review https://github.com/OWNER/REPO/pull/123 with diffninja. My clone is at
> /absolute/path/to/REPO. Answer its questions, then give me the page.

The agent calls `review_diff`, reads the hunks, and sends its whole reading in
one `finish_review` call (answers to the questions, a reading order, comments and
an explanation). `finish_review` returns the page link, which the agent gives you
(a `http://127.0.0.1:…/` address with a 64-character secret in its path). On that
page:

- **Reading order** lists every hunk: production code before tests, formatting
  last, with the facts found in each (a changed condition, limit, input check,
  error handling, public contract, schema or data change, CI gate, …) and the
  exact line each rests on. "Go to the diff" jumps to it.
- **Questions** show the agent's answers as they arrive, with the client that
  gave them. They are a second opinion, not a verdict, and never reorder the list.
- **Call flows** appear when your clone already has the pull request's commits.
  diffninja itself never runs a fetch; if you want them, run
  `git fetch origin pull/123/head` in your clone first. (In a partial clone, git
  may fetch missing objects from that clone's own remote when diffninja reads
  them.)
- The review you write is yours. Nothing is posted until Submit is pressed on
  the page, diffninja tells your agent never to press it, and you do not have
  to submit through diffninja at all.

## What to write down, per pull request

1. PR link, size (files, lines), and whether call flows were available.
2. Time to your first real finding, and total review time, compared with how
   you usually review a PR of that size.
3. Did the reading order put what mattered near the top? Name one hunk it
   ranked too high and one it ranked too low, if any.
4. Which facts were useful, which were noise (quote the line if you can).
5. Agent answers: which were right, which were wrong, which you ignored.
6. Anything you found that diffninja did not point at.
7. Would you use it on your next review? Why or why not?

Keep private code out of these notes; describe hunks by file and line.
