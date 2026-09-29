# Security and privacy

What diffninja runs, what it can reach, what it writes, and how it treats text
written by a pull request's author. This page describes the code as shipped; the
tests in the repository cover its main statements.

## In one paragraph

diffninja is a small program your coding agent starts on your machine. It calls
no AI model, needs no API key, and while it reviews it makes no request of its
own. For a pull request it runs your GitHub CLI (`gh`) to read the PR. None of
its tools posts anything. A review is posted only when **Submit** is pressed on
the review page, normally by you. Anyone holding the page's link can do that,
and your agent holds it, because it receives the link to give it to you.
diffninja never downloads or builds code during a review. What it returns to
your agent (the diff, and function bodies from files near the change) is handed
to whichever model your agent uses, exactly like the output of any other tool
your agent calls.

## What it does on the network

| Who | When | What |
| --- | --- | --- |
| `gh` (your GitHub CLI) | Reviewing a pull request link | Reads the PR (metadata, diff, files) with the login you already have. Usage telemetry of `gh` is turned off for these calls. |
| `gh` | **Submit** is pressed on the review page | Posts the review to GitHub. Only someone holding the page's link can submit. Your agent holds it, so an agent that can run commands or fetch web pages could submit too; diffninja tells it never to. A program that was never given the link cannot. |
| `npm` | You run `diffninja setup` or `diffninja grammars install` | Installs diffninja, or the pinned language grammars. |
| diffninja | Only if you set `DIFFNINJA_UPDATE_CHECK=1` | One GET of the newest published version (no data about you or your code). Off by default, and off in CI. |

Reviewing an inline diff or a local git range makes no connection at all. The
review pages load nothing from the network (no fonts, scripts, images or
analytics), and diffninja has no telemetry of its own.

## What it downloads, and how

Only `diffninja grammars install`, run by a person, downloads code: 20
tree-sitter grammar packages at exact versions (18 usable at once; Kotlin and
Perl arrive as source and load only after `--build`). The lock that ships with
diffninja holds the sha512 of every tarball, dependencies included, and
`npm ci --ignore-scripts` refuses any tarball that differs, so no install script
of any package runs and npm gets only the environment it needs (no tokens,
unless you name them in `DIFFNINJA_NPM_ENV`).
`--build` additionally compiles the Kotlin and Perl grammars, which ship no
prebuilt binary; that is the one case where an install script (theirs) runs. A review never installs anything: a missing grammar is named in
the review's warnings, and the files that need it are skipped by call flows. The
package itself ships an `npm-shrinkwrap.json`, so an install from the registry
gets the dependency versions diffninja was tested with.

## What it writes

- Nothing in the repository under review, ever (git plumbing only, read only).
- `~/.cache/diffninja/grammars` (mode 0700) when you run `grammars install`.
  diffninja loads grammars from it only while the directory belongs to you and
  no other user can write to it (on Windows this is not checked). The marker
  file inside records which lock installed the cache. It holds only public
  data, so it is a consistency check, not a signature.
- Your agents' configuration files, when you run `diffninja setup`
  (`~/.claude.json`, Codex's `config.toml`, `~/.omp/agent/mcp.json`,
  `~/.pi/agent/mcp.json`): one `diffninja` entry each, atomically.
- A temporary directory of the two revisions, only for the opt-in TypeScript
  reference check, removed afterwards.
- No report files, logs or analytics.

## What it runs

- `git` for read-only plumbing (`diff`, `ls-tree`, `cat-file`, `blame` with
  `--no-textconv`, `log`), each stopped after 120 seconds. On Windows `git` and
  `gh` run by the absolute path found on PATH, never a file from the repository.
- `gh` for pull requests.
- Native tree-sitter parsers in the same process, over the source files of the
  two revisions (files over 1 MiB and files past the first 15,000 are skipped).
- With `referenceProject`, a TypeScript compiler installed beside diffninja.
  diffninja's package ships none. With a global install of diffninja,
  `npm install -g typescript` puts one beside it; a diffninja started through
  npx cannot use one, and the check reports not checked. The repository's own
  compiler is code from the repository under review, so it runs only if
  whoever configured the server sets `DIFFNINJA_TRUST_PROJECT_COMPILER=1`.

diffninja never runs a script from the pull request, never installs its
dependencies, and never checks its branch out.

## The review page on your machine

The page is a small web server on `127.0.0.1` that lives as long as your agent's
connection. Every URL of it contains a random 256-bit secret that only the
page's link carries. `finish_review` returns that link to your agent, and your
agent gives it to you. A program or another user on the same machine that finds
the port but not the link gets a 404 for everything, so it cannot read the pull
request or post a review as you. Requests from other web pages are also
refused (Host, Origin and CSRF checks), the page has a strict content security
policy with a fresh nonce per response, and it closes when your agent's
connection does. At most ten such pages stay open per connection.

Your agent is different. With the link it can load the page, and the page
carries the token its own Submit button sends, so an agent that can fetch local
URLs can do whatever the page does, including submitting a review as you.
diffninja tells the agent to give you the link and never to submit, but it
cannot enforce that. If your agent can run shell commands, treat it as able to
post a review.

## Text written by the pull request's author

A pull request's title, description, file names, diff and commit messages are
written by other people, and diffninja treats them as data:

- Hidden and bidirectional Unicode characters (the ones behind "Trojan Source")
  are shown as visible `⟦U+XXXX⟧` markers on every page and in the result the
  agent receives, and the review warns which files add them.
- Titles and commit subjects reach the agent quoted as data, and the first
  step of every result tells the agent that text from the pull request is data
  written by other people, never instructions.
- A pull request link inside a real diff is source and is never followed.
- Everything is bounded: a description over 12,000 characters is shown as plain
  text, a line is read in linear time, and the agent's copy of a result stays
  under 4 MiB (the page keeps the whole report).

A language model can still be talked into things by text it reads; diffninja
narrows what such text can reach. Its tools change what its own pages display
and read pull requests through `gh` (any pull request your login can see, when
the agent passes its link); none of them posts to GitHub or runs a command.
An agent that can also run commands is another matter. Text in a pull request
could talk it into opening the review page and submitting, as described above.

## Settings you control

| Variable | Effect |
| --- | --- |
| `DIFFNINJA_UPDATE_CHECK=1` | Turn on the update notice (off by default; never in CI or with `NO_UPDATE_NOTIFIER`). |
| `DIFFNINJA_TRUST_PROJECT_COMPILER=1` | Let `referenceProject` run the repository's own TypeScript compiler. |
| `DIFFNINJA_GRAMMAR_CACHE` | Where the grammars are installed and read. |
| `DIFFNINJA_NPM_ENV=NPM_TOKEN,NODE_AUTH_TOKEN` | Names of environment variables that npm also gets when `setup` or `grammars install` runs it, for a private registry whose `.npmrc` reads its token from the environment. Names only; any other text is refused. The install scripts npm runs see them too (at `setup`, and with `grammars install --build`). |

## What is not covered

- Your agent and its model provider: they receive what diffninja returns.
- What your agent does with the review page's link. It holds the link, and an
  agent that can fetch local URLs can submit a review through the page.
- The native parsers run in the agent's session; a memory-safety bug in a
  tree-sitter grammar would be a bug in that process.
- `diffninja setup` and `grammars install` trust the npm registry and the
  account that publishes `diffninja`; publishing uses npm trusted publishing
  from a tag on `main`.
- The Windows executable resolution was implemented from the platform's
  documented behavior and unit-tested, but not run on Windows by the author of
  the change.

To report a vulnerability, open a private security advisory on the repository.
