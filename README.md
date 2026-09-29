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
- **See what the change does to the product, not just the code.** Your agent
  explains the change in business terms: the processes it touches as
  flowcharts, with new and changed steps highlighted, the business rules it
  adds or changes (before and after), and one plain sentence on what each
  function does. Call flows show that sentence above each function's name.
- **Your agent does the first pass.** For each change, the agent answers simple
  questions: does it change behavior, is it tested, does it match the PR's
  goal. The answers sit above the code.
- **Suggested comments are blockers only, never posted for you.** The agent
  suggests a comment only for what blocks the merge, and shows its proof: the
  case that fails, how it checked, and what would make it fine. No comment at
  all is the normal result, and anything that does not block is dropped. You
  add a comment with one click, edit it, or dismiss it.
  None of diffninja's tools posts anything. The review reaches GitHub when
  Submit is pressed on your review page, and your agent is told never to do
  that itself.
- **Facts you can check.** diffninja points at the exact lines that changed a
  comparison, a limit, an input check, or error handling. It also shows call
  flows: which functions call the changed code.
- **The analysis runs on your machine.** diffninja calls no AI model, needs no
  API key, has no telemetry of its own, and does not download or build code
  during a review. It makes no request of its own while it reviews, except an
  update notice that is off unless you turn it on. It uses your existing GitHub
  CLI login to read the PR, and to post your review when Submit is pressed.
  Installing diffninja and adding language grammars use npm. Your agent sends
  what diffninja returns, source text included, to its own model, as it does
  with any tool result. It is not "local only" in every respect.
  [docs/security.md](docs/security.md) lists what runs, what is downloaded, what
  is written and what your agent can reach, including the parts that are not
  local.

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

It installs diffninja globally with `npm install -g` (if that fails, it registers
an `npx` entry instead), and adds diffninja to every agent CLI it finds on your
machine by editing that CLI's config file. Then restart your agent CLI.

Setup rewrites a JSON config file in full, in standard formatting, and keeps no
backup. Indentation, string escapes and integers above 2^53 in it can change.
`~/.claude.json` is Claude Code's main state file, so copy it before the first
run (`cp ~/.claude.json ~/.claude.json.bak`).

[docs/security.md](docs/security.md) and this README describe diffninja 0.3.3
and later. Version 0.3.2 and earlier behave as two security audits found. The
review page's submit API had no secret in its path, so any local process could
use it. Reviews installed grammars with npm at review time. Hidden characters
were not marked, and the package had no pinned dependency tree.
`npx -y diffninja@latest setup` installs the newest published version. Check
that it is 0.3.3 or later with `npm ls -g diffninja`, or read the version in the
entry setup wrote to your agent's config.

To update later, run the same command again: setup brings an older global
install up to its own version, then restart your agent CLI. (Setup from
0.3.0 or earlier does not update an existing install; if yours reports an
older version, run `npm install -g diffninja@latest` once.) To remove
diffninja from your agent CLIs, run `npx -y diffninja@latest setup --uninstall`.
Other options: `npx -y diffninja@latest setup --help`.

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
   Under it, **How it works** draws the business processes the change touches,
   with its new and changed steps highlighted, and each change in the diff
   says which step or rule it belongs to.
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
changed files. Call flows read JavaScript and TypeScript out of the box. For
other languages (Python, Go, Java, Rust, C#, Ruby, and more), install their
grammars once. This step downloads grammar code through npm at exact versions,
checked against hashes shipped with diffninja, and runs no install script. Use
the version of diffninja your agent runs, because diffninja may not read
grammars that another version installed. A review that needs them says which
files its call flows skipped and prints the exact command, which has the form
`npx -y diffninja@<version> grammars install`. Kotlin and Perl also need
`--build`, which compiles them on your machine and runs their install scripts.
A review never installs anything itself.

If the local clone is a partial clone (for example made with
`git clone --filter=blob:none`), git may fetch missing objects from that clone's
own remote while diffninja reads it, as `git log -p` would. diffninja itself
never runs a fetch or a checkout.

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
- No diffninja tool approves, blocks, merges or posts anything. A review is
  submitted when Submit is pressed on the review page. Anyone holding that
  page's link can press it through the page's API, and your agent holds the
  link. diffninja tells the agent never to submit. It cannot enforce that.

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
