# Record the agent's reading order

After `review_diff`, the agent that requested the review reads the hunks and sends the order it recommends with `record_order`, naming every `items[].id` exactly once, most important first. The report page then shows "Reading order recommended by <client name version>" at the top, in every view, with links to each hunk under diffninja's own rank. diffninja's own order, statuses, and priorities never change.

## Sub-features

- `order-accept` records a full permutation and returns `{ reviewId, ordered, reportUrl }`.
- `order-refuse` refuses an unknown id, a repeated id, a missing id, or an extra key, and keeps the previous order.
- `order-replace` lets a later order replace an earlier one; the page shows one list.
- `order-attribution` shows the MCP client's name and version on the page.
- `order-scope` accepts only a `reviewId` from the same connection.

## How to get to it (user POV)

- The agent calls `record_order` with `{ reviewId, order }` after reading a `review_diff` result, static or connected.
- A human opens the `reportUrl` and reads the recommended list above the Outcome, Call flow, and Diff views.

## Driving it with drive.mjs

Preconditions:

- Doctor passes, including `tools are review_diff, record_answers, record_order`.

- **Record and check.** Run the static sample drive from `../SKILL.md` with `--order reverse`. `record_order accepted the full order`, `record_order refuses an order that leaves a hunk out`, `page lists the agent's order, attributed to this client` (ranks `5,4,3,2,1` for the sample), and `diffninja's own card order is unchanged` all read `PASS`.
- **See it.** Add `--hold 180` and open the printed `reportUrl` in Chrome. The "Reading order recommended by diffninja-verify 1" panel sits above the view tabs; choosing an entry opens that hunk in the Diff view.
- **Proof.** Keep `record_order.json`, `record_order.refused.json`, `reportUrl.html`, and `reportUrl.after-order.html`.

## Gotchas

- A partial order is refused on purpose. An agent that only wants to flag a few hunks must still send them all.
- The connected pull request page does not show the agent's order yet, and `GET /api/analysis` does not carry it. For a connected review the order appears on the `reportUrl` page that the connected result also returns.
