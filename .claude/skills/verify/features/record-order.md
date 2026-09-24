# Record the agent's reading order

The agent sends its first order inside `finish_review` (see [finish-review.md](./finish-review.md)); `record_order` updates it afterwards, naming every `items[].id` exactly once, most important first. The report is reordered to it: the report page lists every hunk in the agent's order under "Hunks are in the reading order recommended by <client name version>", every rank (#) is the agent's, and diffninja's own order sits in a collapsed "diffninja's own order" list. The connected pull request page's Reading order panel follows the same order. Statuses and priorities never change.

## Sub-features

- `order-accept` records a full permutation and returns `{ reviewId, ordered, next }`, never a page link.
- `order-refuse` refuses an unknown id, a repeated id, a missing id, or an extra key, and keeps the previous order.
- `order-replace` lets a later order replace an earlier one; the page shows one list.
- `order-attribution` shows the MCP client's name and version on the page.
- `order-connected` makes the pull request page's Reading order panel follow the agent (`/api/analysis` `order.source` is `agent`).
- `order-scope` accepts only a `reviewId` from the same connection.

## How to get to it (user POV)

- The agent calls `record_order` with `{ reviewId, order }` after reading a `review_diff` result, static or connected.
- A human opens the `reportUrl` and reads the recommended list above the Outcome, Call flow, and Diff views.

## Driving it with drive.mjs

Preconditions:

- Doctor passes, including `tools are review_diff, record_answers, record_order`.

- **Record and check.** Run the static sample drive from `../SKILL.md` with `--order reverse`. `record_order accepted the full order`, `record_order refuses an order that leaves a hunk out`, `page lists the hunks in the agent's order, attributed to this client`, and `page still offers diffninja's own order` (ranks `5,4,3,2,1` for the sample) all read `PASS`.
- **Connected.** Drive a public pull request with `--args '{"mode":"connected","pr":"<link>"}' --order reverse`; `pull request page's reading order is the agent's` reads `PASS`.
- **See it.** Add `--hold 180` and open the printed `reportUrl` in Chrome. The line "Hunks are in the reading order recommended by diffninja-verify 1" sits above the view tabs, the cards run in the reversed order, and "diffninja's own order" expands to the original list.
- **Proof.** Keep `record_order.json`, `record_order.refused.json`, `reportUrl.html`, and `reportUrl.after-order.html`.

## Gotchas

- A partial order is refused on purpose. An agent that only wants to flag a few hunks must still send them all.
- Until the agent sends an order, both pages show diffninja's order; the connected page polls `/api/analysis` every 10 seconds and switches when the order arrives. The static report page is server-rendered, so reload it.
