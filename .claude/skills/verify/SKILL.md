---
name: verify
description: Drive the real diffninja MCP server (dist/review/mcp-cli.js over stdio) the way an agent host does, call review_diff, record_answers, and record_order, fetch the loopback report pages, and capture evidence. Use to prove a change to diffninja's review output, report page, answers, agent reading order, connected PR review, or `diffninja setup` works in the built artifact, not just in vitest.
---

# Verify diffninja

diffninja has no UI of its own. Its users touch four surfaces:

- **Primary:** the stdio MCP server `diffninja-mcp` (`dist/review/mcp-cli.js`). An agent host calls its tools `review_diff`, `record_answers`, and `record_order`.
- **Report pages:** loopback HTTP pages the server returns as `reportUrl` (static reviews) or `url` (connected PR reviews). Humans read them in a browser. They live in server memory and close when the MCP connection closes.
- **Setup CLI:** `node dist/review/cli.js setup` registers the server with Claude Code, Codex, OMP, or pi. It has no other command.
- **Library:** `dist/index.js`, the calldiff engine. It is not user-facing here.

`drive.mjs` in this directory is the harness. It is an MCP SDK client that spawns the built server, calls the tools, fetches the pages with the exact `Host` header they require, and writes everything to an evidence directory. The feature map in `features/` lists what to drive and what proves it.

## Launch

There is no long-lived server to start: each drive spawns its own server, and it exits when the drive closes stdin.

1. Build once, after any change under `src/`:

   ```sh
   npm run build
   ```

   It is ready when the command exits 0 and `dist/review/mcp-cli.js` exists. The drive runs the build, not `src/`, so a stale build proves nothing.
2. Drive with `node .claude/skills/verify/drive.mjs review --args '<review_diff arguments as JSON>'`. See the Drive section.

**Isolation:** every drive gets its own server process and its own 127.0.0.1 port (port 0). Parallel drives never share state, and none touches a server the user's agent CLI is running.

## Doctor

Run this first, and again whenever anything looks off. It is read-only.

```sh
node .claude/skills/verify/drive.mjs doctor
```

It checks:

- Node is at least 22.18.
- The build exists and is newer than every file in `src/`.
- The server refuses arguments, exiting 1 with an error on stderr and nothing on stdout. stdout is reserved for the protocol.
- `tools/list` returns exactly `record_answers`, `record_order`, and `review_diff`.
- `gh auth status`. This is reported as INFO only, because only connected PR review needs `gh`.

Any `FAIL` makes the exit code 1. On "build is newer than src/", run `npm run build`.

## Drive

```sh
node .claude/skills/verify/drive.mjs review --args '<json>' [--answer cannot-tell|first] [--order reverse] [--hold SECONDS] [--out DIR]
```

- `--args`: the exact `review_diff` arguments. It is a strict schema: `diff`, `repo`, `from`, `to`, `pr`, `input`, `mode`, `expectedOutcome {title, description}`, and `referenceProject`. Any other key is an error.
- `--answer`: answers every returned question through `record_answers` with `cannot-tell` or with each question's first option. Then it checks that an unlisted option is refused and that the re-fetched page shows answers attributed to the `diffninja-verify` client.
- `--order reverse`: sends the reverse of the report's order through `record_order`, then checks that a partial order is refused, that the page lists the agent's order attributed to `diffninja-verify`, and that diffninja's own card order did not move.
- `--hold N`: keeps the connection, and so the pages, alive for N seconds, and prints the URLs. Use it to open a page in a browser while the drive waits (see `features/report-page.md`).
- `--out`: the evidence directory. The default is `<os tmpdir>/diffninja-verify/<ISO timestamp>/`, and the path is printed on the first line.

Checks run for every successful result:

- The text content equals `structuredContent`.
- Each page URL is on 127.0.0.1.
- Each page answers 200 `text/html`, with `no-store` and a CSP.
- A request with a foreign `Host` gets 403.
- After the drive closes, the report page no longer answers.

Each check prints PASS or FAIL. The exit code is 0 only when every check passed, and 2 on a usage or harness error.

Build the diff argument from a file with node, so quoting stays exact:

```sh
ARGS=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({mode:"static",diff:fs.readFileSync("examples/review/checkout.patch","utf8"),expectedOutcome:{title:"Checkout: charge before reserving inventory",description:"Example patch."}}))')
node .claude/skills/verify/drive.mjs review --args "$ARGS" --answer cannot-tell
```

To assert something specific to your change, read the saved `review_diff.json` (`structuredContent` is the report) or the page HTML with node or grep. Do not re-derive it from source.

## Evidence

Each drive writes these files to its evidence directory:

| File | Contents |
|---|---|
| `request.json` | The arguments sent to `review_diff`. |
| `review_diff.json` | The full tool result: `content` and `structuredContent`. |
| `reportUrl.html`, `reportUrl.headers.json` | The report page and its response headers. |
| `url.html`, `url.headers.json` | The connected PR page and its headers (connected reviews only). |
| `record_answers.json` | The result of recording the answers (with `--answer`). |
| `record_answers.refused.json` | The refused call with an unlisted option (with `--answer`). |
| `record_order.json`, `record_order.refused.json`, `reportUrl.after-order.html` | The accepted order, the refused partial order, and the page after it (with `--order`). |
| `reportUrl.after-answers.html` | The page re-fetched after the answers (with `--answer`). |
| `server-stderr.txt` | Server diagnostics. |
| `checks.json` | Every PASS/FAIL line. |

Proof standards:

- **Use the real user path.** Call the built server over stdio, as a host would. Do not import `src/` functions, and do not count vitest output as proof of behavior.
- **Capture the action and the result.** Keep the request and the tool result, and for pages keep the state before and after (for example `reportUrl.html` and `reportUrl.after-answers.html`).
- **Check side effects beside the visible output.**
  - diffninja must not write report files: run `git status --short` in the reviewed repo before and after the drive, and expect no change.
  - A git range must not modify the repo.
  - A connected review must not submit anything to GitHub.
- **Check what a safe mode actually skips.** `setup --dry-run` writes no config files, but it still runs `npm root -g` and npm writes a debug log under `$HOME/.npm/_logs`. Run it with a temporary `HOME` and `CODEX_HOME` (see `features/setup.md`).
- **Do not mock.** Inline diffs are fully offline, so nothing needs a mock. Connected review really calls GitHub through `gh`.

For a visual proof of a page, drive with `--hold 120`, open the printed URL with the claude-in-chrome tools, and save the screenshots in the same evidence directory.

## Cleanup

- `drive.mjs` closes its client in a `finally` block, and the server exits on stdin EOF. After a normal run no process remains, and the "page closes with the connection" check proves the listener is gone.
- If a drive is interrupted, kill only the pid it printed on its first line (`server pid N`): `kill N`. Never kill by process name. The user's own agent CLI runs the same `mcp-cli.js`.
- Evidence directories are never deleted by cleanup. Remove one only when the user asks.
- Setup drives use a `mktemp -d` HOME. Delete that directory after copying its file list into the evidence directory.

## Gotchas

- A git-range review can install missing tree-sitter grammars into calldiff's cache through npm on first use for a language, so the first run can be slow and touch the network. Inline diffs never do.
- Node's `fetch()` silently sends the URL's own host even when you set a `Host` header. The helper uses `node:http` for that reason. Do not "simplify" it back to `fetch`, or the foreign-Host check passes for the wrong reason.
- Pages and `reviewId`s belong to one connection. A `reviewId` from another drive is refused.
- `review_diff` in mode `auto` (the default) treats any github.com pull request link anywhere in `diff` as a connected review request. Pass `"mode":"static"` for inline diffs that might contain one.
- rbp-api (SecondNature-com) pull requests are read-only for this project. Connected drives against them may load and read only: never POST `/api/submit` and never click Submit.
