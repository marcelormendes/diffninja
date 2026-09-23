# Report page

Every static review, and the local analysis inside a connected review, is published as a read-only loopback page at `reportUrl` (`http://127.0.0.1:<port>/report/<64-hex token>`). A human reviewer reads there the expected outcome, the reading agenda, call-flow graphs, and every hunk. The page lives only as long as the MCP connection.

## Sub-features

- `page-views` switches between `Outcome` (`#view-brief`), `Call flow` (`#view-call-flow`), and `Diff` (`#view-diff`).
- `page-filter` filters hunks with status pills (`button[data-filter=attention|uncertain|low|passed]`, `aria-pressed`). A filter that matches nothing shows `#filter-empty`.
- `page-fold` opens and closes hunks with `Expand all` and `Collapse all` (`data-action=expand|collapse`), and through native folding without JavaScript.
- `page-security` serves `GET /report/<token>` only, checks Host, pins the CSP by hash, sends `no-store`, keeps at most 20 pages per connection, and closes with the connection.

## How to get to it (user POV)

- The agent hands the user the `reportUrl` from a `review_diff` result, and the user opens it in a browser while the agent session is still running.

## Driving it with drive.mjs

Preconditions:

- Doctor passes.
- For visual proof, the claude-in-chrome tools are available.

- **Headers and Host.** Any static drive checks 200 `text/html`, `no-store`, a CSP, and 403 for a foreign `Host`. Read `<evidence>/reportUrl.headers.json` for the exact header values.
- **Open it in a browser.** Run the static sample drive with `--hold 180`. When `HOLD` prints the URL, open it in a new Chrome tab and take screenshots of the `Outcome`, `Call flow`, and `Diff` views. Save them in the evidence directory.
- **Filter.** Choose the `passed` pill (the button whose `data-filter` is `passed`) so that it is pressed off. `aria-pressed` becomes `false`, and the passed hunks disappear from the list.
- **Closes with the session.** After the hold ends, reload the tab. The connection is refused, and the harness prints `PASS page closes with the connection`.
- **Proof.** Keep the screenshots, `reportUrl.html`, and `reportUrl.headers.json`.

## Gotchas

- Node's `fetch()` ignores a custom `Host` header, so a foreign-Host check through `fetch` falsely passes as 200. The harness uses `node:http`.
- Opening the page after the drive ends always fails. Use `--hold`.
- The page has no network access by design (CSP `default-src 'none'`). A blank graph usually means a rendering bug, not a blocked asset.
