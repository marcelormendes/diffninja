# Security and privacy

What diffninja runs, what it can reach, what it writes, and how it treats text
written by a pull request's author. It states the parts that are not local as
plainly as the parts that are.

This page describes diffninja 0.4.0 and later. Version 0.3.2 and earlier behave
as two security audits found, and this page does not describe them.

- The pull request page's submit API had no secret in its path. Any local
  process, including another user's on a shared machine, could read the pull
  request and post a review as you.
- A git-range review installed language grammars with npm at review time,
  unpinned, with install scripts on and your full environment.
- Hidden characters were not marked.
- The published package had no pinned dependency tree.

Check what you run with `npm ls -g diffninja`, or read the version in the
`diffninja` entry of your agent's config. Update if it shows 0.3.2 or earlier.

## The short version

- diffninja is a Node program that your coding agent starts on your machine. It
  runs with your user rights. It is not sandboxed.
- It calls no AI model, needs no API key, and has no telemetry of its own.
- Reviewing an inline diff runs no other program and opens no connection,
  apart from the optional update notice.
- Reviewing a git range runs `git` in the repository you name.
- Reviewing a pull request runs your GitHub CLI (`gh`), which talks to GitHub
  with your login. It reads the pull request, and it reads which of the changed
  files you marked **Viewed** on GitHub.
- None of its tools posts a review. A review is posted when **Submit** is pressed
  on the review page, normally by you.
- The page has one other write to GitHub. Ticking a change in the page's left
  list marks that change's file **Viewed** on GitHub, as you, once every change
  of the file is ticked. Unticking one clears the mark. The page sends it on a
  click, and only for a file of the loaded pull request.
- Anyone holding the page's link can submit a review and toggle Viewed marks,
  and your agent holds it, because it receives the link to give it to you.
- `diffninja setup` and `diffninja grammars install` run npm, which downloads
  code from the npm registry. `setup` also runs install scripts. A review never
  downloads or builds code.
- What diffninja returns to your agent goes to whichever model your agent uses,
  like the output of any other tool. That is the diff, function bodies from
  files near the change (including files the change did not touch), commit
  subjects and guideline paths.

So "local only" and "uses nothing external" are not accurate summaries. The
sections below list each exception.

## What it does on the network

| Who | When | What |
| --- | --- | --- |
| `gh` (your GitHub CLI) | Reviewing a pull request link | Runs a few read commands (a version check, your login, the PR's metadata, diff and file list, and a GraphQL read of which changed files you marked Viewed) with the login you already have. The Viewed read runs again each time the page loads the pull request, including a load from **Check GitHub state**. diffninja sets `GH_TELEMETRY=false` and `DO_NOT_TRACK=1` so `gh` does not report usage. |
| `gh` | **Submit** is pressed on the review page | Posts the review to GitHub as you, after a preview of the identical review. Only someone holding the page's link can submit. Your agent holds it, so an agent that can run commands or fetch web pages could submit too. diffninja tells it never to. A program that was never given the link cannot. |
| `gh` | A file's Viewed state changes on the review page, because you ticked or unticked a change | Reads the pull request's head again, then marks the file **Viewed** or not Viewed on GitHub as you, with one GraphQL mutation (`markFileAsViewed` or `unmarkFileAsViewed`), and only if the head is still the one that was loaded. It goes through the same gated route as Submit, has no preview, and is sent only for a changed file of the loaded pull request. The mutation text is fixed, and the file path and the pull request's id travel as separate variables, never inside the text. Someone holding the page's link, your agent included, can send it. A program that was never given the link cannot. |
| `npm` | You run `diffninja setup` | `npm root -g`, then `npm install -g diffninja@<version>` when there is no global install or it is older than setup. npm downloads diffninja and its dependencies and runs the install scripts of `diffninja`, `tree-sitter`, `tree-sitter-javascript` and `tree-sitter-typescript`. `--dry-run` and `--no-install` still run `npm root -g` and install nothing. `--uninstall` runs no npm. |
| `npm` | You run `diffninja grammars install` | Downloads the 20 pinned grammar packages. With `--build`, `node-gyp` also downloads the Node headers from nodejs.org unless they are already cached. |
| `npm` (the postinstall script) | After an npm install of diffninja, only where the parser or the TypeScript grammar does not load (Linux ARM64 is the known case) | Installs `tree-sitter-typescript` if it is missing, then rebuilds it from source and keeps a copy of the rebuilt grammar in diffninja's package directory. The rebuild runs install scripts and can download the Node headers. Where the grammar loads, it does nothing. |
| `npx` | Your agent starts diffninja, when `setup` could not install globally and registered the npx form | npx may contact the npm registry, and downloads the package the first time, as it does for any package. |
| `git` | A git-range review, or a pull request review with a local clone, when that clone is a partial clone | May fetch missing objects from that clone's own remote, exactly as `git log -p` would. See below. |
| diffninja | Only if you set `DIFFNINJA_UPDATE_CHECK=1` | One GET of `registry.npmjs.org/diffninja/latest`, at the first review. It carries no identifier, version or code. The registry still sees your IP address and the time of the request. Off by default, and off in CI or with `NO_UPDATE_NOTIFIER` set. |

Reviewing an inline diff, or a git range in a full clone, opens no connection,
unless the update notice is on. The review pages load nothing from the network
(no fonts, scripts, images or analytics), and diffninja has no telemetry of its
own. Its listeners bind to `127.0.0.1` only.

A partial clone is one made with `git clone --filter=blob:none` or similar. It
lacks some objects and knows which remote can supply them. When diffninja reads
an object that is missing, git fetches it from that remote and stores it in the
clone's `.git` directory. diffninja itself never runs `fetch` or `checkout`.
In a normal clone there is no network and no write. This was observed with a
blobless clone of a local remote. Other transports were not tested.

## What it downloads, and how

A review downloads no code. Three things do, and each starts with a command.

**`diffninja grammars install`**, run by a person. It installs 20 tree-sitter
grammar packages at exact versions (18 usable at once; Kotlin and Perl arrive as
source and load only after `--build`). The lock that ships with diffninja holds
the sha512 of every tarball, dependencies included. `npm ci --ignore-scripts`
refuses a tarball that differs, and runs no install script of any package.
`--build` then runs `npm rebuild` for Kotlin and Perl only. That runs their
install scripts and compiles them, and `node-gyp` downloads the Node headers
from nodejs.org unless they are cached. Both packages have individual
maintainers (see the last section).

**`diffninja setup`**, run by a person. `npm install -g` downloads diffninja and
its dependencies from the registry and runs install scripts for the four
packages named above. The package ships an `npm-shrinkwrap.json`, so an install
from the registry gets the dependency versions diffninja was tested with, with
their integrity hashes. If the global install fails, setup registers the npx
form instead.

**The postinstall script**, `scripts/ensure-native-grammar.mjs`. It ships in the
package and runs after every npm install of diffninja. It first checks that
`tree-sitter` and `tree-sitter-typescript` load and parse a line of TypeScript.
If they do, it stops. If not, it installs `tree-sitter-typescript` without its
scripts when that package is missing, deletes the package's `prebuilds/` and
`build/` directories, and runs `npm rebuild tree-sitter-typescript`. When the
rebuilt grammar loads, or when the grammar that loads was compiled on this
machine during the install, it copies the files the grammar needs at run time
into `native-grammar/` in diffninja's own package directory, because npm can
still delete that package at the end of the install, and diffninja loads that
copy when the package itself does not load. It gives each npm command 900
seconds and always exits 0.

A review itself never installs anything. A missing grammar is named in the
review's warnings, and call flows skip the files that need it.

## Which environment each program gets

- **npm, when diffninja runs it** (`setup`, `grammars install`). A short
  allow-list. It has `PATH`, `HOME`, `USER`, `LOGNAME`, locale, `TERM`, `TZ`,
  the temporary and XDG directories, the proxy settings (`HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`), certificate settings, and on Windows
  the variables npm needs to find itself. It also gets every variable whose name
  starts with `npm_config_`, which is your npm configuration and includes any
  registry token you keep there. Proxy settings can hold credentials too, for
  example `https://user:password@proxy`. Other tokens (`GH_TOKEN`,
  `GITHUB_TOKEN`, `NPM_TOKEN`, cloud credentials, `SSH_AUTH_SOCK`) are dropped.
  `DIFFNINJA_NPM_ENV` adds the variable names you list. With `--build`, npm also
  gets compiler and Python settings (`CC`, `CXX`, `CFLAGS`, `PYTHON`, and
  similar). The install scripts npm runs see the same set.
- **`gh` and `git`.** Your full environment. For `gh`, diffninja adds `GH_HOST`,
  `GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `GH_PAGER`, `NO_COLOR`,
  `GH_TELEMETRY` and `DO_NOT_TRACK`. Your `GH_TOKEN`, if set, is visible to `gh`.
- **The postinstall script.** The environment of the npm that runs it, passed on
  to the npm commands it starts. Under `diffninja setup` that is the short set
  above. Under an `npm install -g diffninja` you ran yourself, it is whatever
  your shell holds.
- **The TypeScript compiler for `referenceProject`.** It runs inside diffninja's
  own process, so it sees everything diffninja sees.

## What it writes

- Nothing in the repository under review. diffninja runs only read commands
  there. The one exception is git's own behavior in a partial clone, above.
- On GitHub, as you, and only from the connected review page. A review, when
  **Submit** is pressed. A file's **Viewed** mark, when the ticks in the page's
  left list make every change of that file viewed, or stop doing so. Nothing else
  is written to GitHub.
- `~/.cache/diffninja/grammars` (mode 0700) when you run `grammars install`.
  diffninja loads grammars from it only while the directory belongs to you and
  no other user can write to it (on Windows this is not checked). The marker
  file inside records which lock installed the cache. It holds only public
  data, so it is a consistency check, not a signature.
- npm's global prefix and npm's cache, when npm runs. The postinstall script can
  also delete and rebuild files inside the installed `tree-sitter-typescript`,
  and write its copy of the rebuilt grammar to `native-grammar/` inside
  diffninja's own package directory.
- Your agents' configuration files, when you run `diffninja setup`
  (`~/.claude.json`, Codex's `config.toml`, `~/.omp/agent/mcp.json`,
  `~/.pi/agent/mcp.json`). See the next section.
- A temporary directory for the opt-in TypeScript reference check. It holds a
  full copy of each of the two revisions (up to 512 MiB each, so up to 1 GiB) and
  symlinks to the repository's installed `node_modules`. It is removed
  afterwards.
- In your browser, from the connected review page. A draft of your review
  (its text and comments, which can quote source) goes in `sessionStorage`,
  per tab. So do the changes you ticked as viewed, under a key that starts with
  `diffninja.connected.viewed.v1`, one per version of the pull request. It holds
  change ids such as `hunk-3` and no source text. The layout choice (`guided` or
  `file`) goes in `localStorage`. diffninja writes nothing to disk for these.
- No report files, logs or analytics.

### What setup does to your config files

`diffninja setup` rewrites each JSON config file it changes in full
(`~/.claude.json`, `~/.omp/agent/mcp.json`, `~/.pi/agent/mcp.json`). It parses
the file and writes it back in standard form, so formatting can change.
Indentation becomes two spaces. Escapes such as `\u00e9` become the character.
An integer above 2^53 is rounded (9007199254740993 becomes 9007199254740992).
It writes through a temporary file and a rename, keeps the file's permissions,
follows symlinks, and keeps no backup. `--uninstall` removes the entry but does
not restore the original bytes. If your agent writes the same file at the same
moment, setup narrows the window for a lost update and does not close it. Codex's
TOML file is edited in place and keeps its comments and layout.

`~/.claude.json` is Claude Code's main state file. Before the first run, copy it,
for example `cp ~/.claude.json ~/.claude.json.bak`.

## What it runs

- `git`, for read-only commands (`rev-parse`, `ls-tree`, `cat-file`, `show`,
  `diff`, `diff-tree`, `log`, `merge-base`, and `blame` with `--no-textconv`).
  Text conversion and external diff helpers are switched off for the commands
  that would run them. git uses your repository's configuration and your
  environment. On Windows `git` and `gh` run by the absolute path found on PATH,
  never a file from the repository.
- `gh` for pull requests: reads, the review post, and Viewed marks. Every `gh`
  call of one review session runs one at a time.
- `npm`, and `node` for the postinstall script, as described above.
- Native tree-sitter parsers in the same process, over the source files of the
  two revisions. Files over 1 MiB and files beyond 15,000 per revision are
  skipped, after the diff's own files and their directories are read.
- With `referenceProject`, a TypeScript compiler found the way Node finds
  `typescript` from diffninja's own files. That means the `node_modules`
  directory of diffninja's install and of every directory above it, and
  `NODE_PATH`. diffninja's package ships none. With a global install of
  diffninja, `npm install -g typescript` puts one beside it. A `typescript` in a
  parent directory of an npx cache is found too. The repository's own compiler is
  code from the repository under review, so it runs only if whoever configured
  the server sets `DIFFNINJA_TRUST_PROJECT_COMPILER=1`.

Every command has a time limit, and a command past its limit is stopped.

| Command | Limit |
| --- | --- |
| `git` reading a range (`rev-parse`, `ls-tree`, `cat-file`, `show`, `diff`) | 120 seconds each |
| `git` for the opt-in reference check | 120 seconds each |
| `git` for project history (`blame`, `log`, `diff-tree`, `ls-tree`, `cat-file`, `rev-parse`) | 30 seconds each |
| `git` checking that a local clone has a pull request's commits (`cat-file`, `merge-base`) | 10 seconds each |
| `gh` | 15 seconds per call (each page of the Viewed read and each Viewed mark is one call) |
| `npm` in `grammars install` (`ci`, and `rebuild` with `--build`) | 300 seconds per run |
| `npm` in the postinstall script | 900 seconds per run |
| `npm` in `setup` | none |

diffninja does not run scripts that a pull request defines, does not install
its dependencies, and does not check its branch out. The one path from a
repository's code into diffninja's process is the opt-in project compiler above.

## What your agent can reach through diffninja

Your agent picks the arguments of `review_diff`, and it reads text written by
other people first. These are the things those arguments can make diffninja do.

- Run `git` and `gh` with your rights.
- With `repo`, read any git repository on disk that you can read, given as an
  absolute path. diffninja returns its diffs, function bodies, commit subjects
  and guideline paths to the model. Nothing limits it to the repository you are
  working in.
- With a pull request link, read any pull request your `gh` login can see, and
  return its diff and description.
- With `DIFFNINJA_TRUST_PROJECT_COMPILER=1` set where the server is configured,
  `referenceProject` makes diffninja load the TypeScript compiler from the
  repository under review and run it inside its own process, with your full
  environment, tokens such as `GH_TOKEN` included. Without that variable it uses
  the compiler found from diffninja's own files, not the repository's.

None of the tools writes to GitHub. A review needs the review page's **Submit**,
and a Viewed mark needs a click in the page's list of changes. Both are described
next.

## The review page on your machine

The page is a small web server on `127.0.0.1` that lives as long as your agent's
connection. Every URL of it contains a random 256-bit secret that only the
page's link carries. `finish_review` returns that link to your agent, and your
agent gives it to you. A program or another user on the same machine that finds
the port but not the link gets a 404 for everything, so it cannot read the pull
request, post a review or set a Viewed mark as you. Requests from other web pages
are also refused (Host, Origin and CSRF checks), the page has a strict content
security policy with a fresh nonce per response, and it closes when your agent's
connection does. At most ten such pages stay open per connection; the one used
least recently closes, and finishing its review is then refused.

The page writes to GitHub in two ways. **Submit** posts a review. Ticking a
change marks a file **Viewed**, as you. Both go through one gate (the secret
path, Host, Origin, `Sec-Fetch-Site` and CSRF checks, a 256 KiB body limit and a
15 second request time limit). No route is a general GitHub or command proxy. The
Viewed route takes a snapshot id, a file path and a true or false. It refuses a
snapshot other than the loaded one, and a path that is not one of that pull
request's changed files, before it runs `gh`. It reads the pull request's head
again and refuses when it moved since the load. It takes the pull request's id
from what it loaded, never from the request, and sends one of two fixed GraphQL
documents. The path is a separate variable and is never part of the document.
A mark whose outcome is unknown, because of a timeout or a lost connection,
stops every later mark from reaching GitHub until the pull request is loaded
again. The page keeps its ticks in the tab and says the marks are not synced.

The read-only report page (`reportUrl`) is served under its own 256-bit token
in the path. It answers `GET` only and checks the Host header. At most 20 stay
open per connection, and they close with it.

Your agent is different. With the link it can load the page, and the page
carries the token its own Submit button sends, so an agent that can fetch local
URLs can do whatever the page does, including submitting a review as you. It can
also mark and unmark files Viewed as you. That does little harm. A Viewed mark
changes nothing in the pull request, and a click on GitHub or on the page clears
it. But GitHub then shows a file as viewed that you may not have read, and the
next time the page loads that pull request, it starts that file's changes as
viewed. The page gives the agent no route to submit a review other than its
Submit call, and none to mark a file outside the loaded pull request. diffninja
tells the agent to give you the link and never to submit anything or open the
page, but it cannot enforce that. If your agent can run shell commands, treat it
as able to post a review and to toggle Viewed marks.

## Text written by the pull request's author

A pull request's title, description, file names, diff and commit messages are
written by other people, and diffninja treats them as data.

- Hidden and bidirectional Unicode characters (the ones behind "Trojan Source")
  are shown as visible `⟦U+XXXX⟧` markers on every page and in the result the
  agent receives, and the review warns which files add them. The ids and paths
  your agent echoes back are minted in the shown form. There are three rules.
  - Always marked, wherever they are. The left-to-right and right-to-left marks
    (U+200E and U+200F), the bidirectional embeddings, overrides and isolates
    (U+202A to U+202E, U+2066 to U+2069), the deprecated formatting characters
    U+206A to U+206F, the Arabic letter mark U+061C, and the whole block from
    U+E0000 to U+E0FFF (the tag characters, the supplementary variation
    selectors and the unassigned code points between them).
  - Marked unless a visible non-ASCII character sits directly beside them. Zero
    width space, non-joiner and joiner (U+200B to U+200D), the word joiner and
    the invisible math operators (U+2060 to U+2065), the soft hyphen, the
    combining grapheme joiner, the Hangul and Braille fillers, the Khmer
    inherent vowels, the Mongolian selectors and vowel separator, the variation
    selectors U+FE00 to U+FE0F, and the invisible musical and shorthand format
    controls.
  - A byte order mark (U+FEFF) is marked wherever it appears, except directly
    after the `+`, `-` or space that starts a line of a diff, where it is left
    alone. At the start of a path or an id it is marked.

  A visible non-ASCII character in the second rule means a letter, mark, digit,
  symbol or punctuation mark outside ASCII. That keeps emoji, Persian, Indic and
  accented text readable. A space such as U+00A0 does not count. In practice,
  every second-rule character between ASCII characters is marked. Beside one
  non-ASCII character it is not, so a zero-width space next to an accented
  letter, a curly quote, an em dash, a euro sign or an emoji is not marked. Only
  a character that touches a visible one is spared. In a longer run the ones in
  the middle are marked. Two zero-width spaces between Arabic letters show
  nothing, and three show the middle one. The direction marks are marked even
  beside Arabic or Hebrew letters. Every code point that Unicode lists as
  default-ignorable is on one of the rules, and a test walks that property to keep
  it so. A space that is visible to no one but is not default-ignorable, such as
  U+00A0 or U+2009, is not marked and does not shield a marked one.
- Titles and commit subjects reach the agent quoted as data. The first step of
  every result tells the agent that text from the pull request is data written
  by other people, never instructions. When the update notice is on and a newer
  version exists, that step comes second.
- A pull request link inside a real diff is source and is never followed.
- Everything is bounded. A description over 12,000 characters is shown as plain
  text. A hunk is read in linear time, and one with a changed line over 4,000
  characters is left unread and marked uncertain. Each of the two copies of a
  result (text and structured content) stays under 4 MiB, the text copy measured
  after JSON escaping, so one message can reach about 8 MiB, under the 10 MiB
  that clients built on the MCP SDK accept. The page keeps the whole report. A
  result that cannot be trimmed to fit is refused with a clear error.

A language model can still be talked into things by text it reads. diffninja
narrows what such text can reach, and the previous section lists what remains.
An agent that can also run commands is another matter. Text in a pull request
could talk it into opening the review page, submitting, or marking files viewed,
as described above.

## Settings you control

| Variable | Effect |
| --- | --- |
| `DIFFNINJA_UPDATE_CHECK=1` | Turn on the update notice (off by default; never in CI or with `NO_UPDATE_NOTIFIER`). |
| `DIFFNINJA_TRUST_PROJECT_COMPILER=1` | Let `referenceProject` run the repository's own TypeScript compiler. |
| `DIFFNINJA_GRAMMAR_CACHE` | Where the grammars are installed and read. |
| `DIFFNINJA_NPM_ENV=NPM_TOKEN,NODE_AUTH_TOKEN` | Names of environment variables that npm also gets when `setup` or `grammars install` runs it, for a private registry whose `.npmrc` reads its token from the environment. Names only; any other text is refused. The install scripts npm runs see them too (at `setup`, and with `grammars install --build`). |
| `CODEX_HOME` | Directory of the Codex `config.toml` that `setup` edits. |

## What is not covered, and what was not verified

- Your agent and its model provider. They receive what diffninja returns.
- What your agent does with the review page's link. It holds the link, and an
  agent that can fetch local URLs can submit a review through the page, and can
  mark files Viewed through it.
- The native parsers run in the agent's session. A memory-safety bug in a
  tree-sitter grammar would be a bug in that process.
- The npm registry and the accounts that publish. `setup`, `grammars install`
  and any install of diffninja trust the registry and the account that publishes
  `diffninja`. The grammar packages are not all published by one group. Checked
  in the registry on 2026-09-29, `tree-sitter-kotlin` (fwcd), `tree-sitter-perl`
  (veesh), `tree-sitter-solidity` (joranhonig), `tree-sitter-swift`
  (alexpinkus) and `tree-sitter-elixir` (jonatanklosko and the-mikedavis) are
  each maintained by individuals. Publishing diffninja uses npm trusted
  publishing from a tag on `main`. The npm-side setup of that was not verified.
- The legacy calldiff command line and library entry (`dist/cli.js`,
  `dist/index.js`, with the `incur` dependency) ship in the package. No bin runs
  them, and nothing the MCP server imports reaches them. What `incur` does if you
  import or run them directly was not checked.
- Windows. The executable resolution was implemented from the platform's
  documented behavior and unit-tested, but nothing here was run on Windows.
- `gh` telemetry. diffninja sets the variables `gh` documents for turning it
  off. That was not checked against GitHub's servers.
- The hidden-character markers on the connected page were checked in code, not
  in a real browser.
- GitHub's real behavior for Viewed marks. The two mutations and the query that
  reads the marks were checked only against a scripted fake `gh` and unit tests,
  never against GitHub. Not checked: what GitHub does with a mark on a renamed,
  deleted or binary file, how it counts `DISMISSED` (diffninja treats it as not
  viewed, like `UNVIEWED`), who besides you can see a mark, paging on a very
  large pull request, and rate limits. diffninja talks to github.com only, so
  GitHub Enterprise Server was not tried.
- A push that lands between the head check and the mark. GitHub has no atomic
  check-and-mark, so a mark can still cover a file that changed in that instant,
  as a review can (see [reference.md](reference.md)).
- Which accounts and tokens may mark a file Viewed. A token without the scope, or
  an account without access, was not tried against GitHub. When GitHub refuses,
  diffninja shows GitHub's named message, cleaned and cut to 400 characters, or
  a fixed sentence, and never `gh`'s raw output. That was checked against a fake
  `gh` that refuses.
- Browsers other than Chrome. The Viewed ticks were driven in headless Google
  Chrome 154 only, through playwright-core.
- File names that git quotes in a diff (non-ASCII characters, quotes, backslashes).
  The page cannot match such a file to the path GitHub lists, so its ticks stay in
  the tab and never reach GitHub.

To report a vulnerability, open a private security advisory on the repository.
