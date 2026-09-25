# diffninja

diffninja helps you review pull requests faster without handing the review to
a bot. You ask your coding agent (Claude Code, Codex, and others) to review a
PR. diffninja gives you a review page that shows the changes in the order worth
reading them, with the agent's notes next to the code. You read, comment, and
submit the review to GitHub yourself.

## Why use it

- **Read the important changes first.** Big PRs are hard to follow file by
  file. diffninja numbers each change, most important first, and lets you step
  through them with `j` and `k`.
- **Your agent does the first pass.** For each change, the agent answers simple
  questions: does it change behavior, is it tested, does it match the PR's
  goal. The answers sit above the code.
- **Suggested comments, never posted for you.** The agent can suggest short
  line comments. You add them with one click, edit them, or dismiss them.
  Nothing reaches GitHub until you press Submit.
- **Facts you can check.** diffninja points at the exact lines that changed a
  comparison, a limit, an input check, or error handling. It also shows call
  flows: which functions call the changed code.
- **Private.** The analysis runs on your machine. diffninja calls no AI model,
  needs no API key, and sends your code nowhere. It uses your existing GitHub
  CLI login to read the PR and post your review.

## What you need

- **Node.js 22.18 or newer**
- **An agent CLI:** Claude Code, Codex, OMP, or pi (or any tool that supports
  MCP servers)
- **GitHub CLI (`gh`) 2.45.0 or newer, logged in:** run `gh auth login` once.
  Only needed for pull requests.

## Install

Run this once:

```bash
npx -y diffninja@latest setup
```

It installs diffninja and adds it to every agent CLI it finds on your machine.
Then restart your agent CLI.

To update later, run the same command again. To remove diffninja from your
agent CLIs, run `npx -y diffninja setup --uninstall`. Other options:
`npx -y diffninja setup --help`.

## How to use it

Inside your agent CLI, ask in plain words:

```text
Review https://github.com/OWNER/REPO/pull/123 with diffninja
```

The agent reads the PR, then gives you a link to the review page (it runs on
your machine at `127.0.0.1`). On the page:

1. Start with **Goal**: the reviewing agent's short, plain-English explanation
   of what the PR is meant to do and its important limits. The full
   **Original PR description** stays one click away, with Markdown formatting.
   The goal is stated intent, not proof the code fulfills it.
   `j` and `k` move to the next and previous change, and the list on the left
   shows where you are. The agent sets the reading order; the connected page
   does not label changes “Attention”.
2. Hover a line and press **+** to write a comment, or add the agent's
   suggestions.
3. Write a summary, choose **Comment**, **Approve**, or **Request changes**.
4. Press **Check the review** to see exactly what will be sent, then
   **Submit review**.

Tip: if your agent is running inside a local clone of the repository, it can
pass the clone to diffninja. You then also get call-flow diagrams for the
changed files.

You can also review changes that aren't a PR yet:

```text
Review my changes on this branch against main with diffninja
```

The agent gets a report of every changed piece of code, ranked by importance,
and gives you a link to read the same report in your browser.

## Good to know

- The review page closes when you exit your agent CLI.
- The page and the agent's session contain source code. Treat them like the
  code itself.
- diffninja never approves, blocks, or merges anything on its own.

## More

- [How the analysis works](docs/how-it-works.md): what diffninja checks and
  how it ranks changes
- [Manual setup and tool reference](docs/mcp-setup.md): for agent CLIs that
  `setup` doesn't configure
- [Releasing](docs/npm-release.md): how new versions are published

## Development

```bash
npm install
npm run build   # compile to dist/
npm run lint
npm test
```

## Credits

The call-flow engine is a fork of
[calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq Kancharla
(MIT, see LICENSE).
