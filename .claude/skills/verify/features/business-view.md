# Business view: how the change works for the product

The reviewing agent explains the change in business terms inside `finish_review` (`explanation`, required for a pull request review) or later with `record_explanation`: a plain purpose for every function in the review's `functions` list, one to four business processes as steps and decisions with the steps the change adds, changes, or removes marked, and the business rules it adds, changes, or removes. The report page opens on **How it works**: each process drawn as a flowchart, a numbered step list with rules, former behavior, and the functions behind each step (purpose first, code name second), and the rules as before and after. The call flows show each purpose above its function's name and fold library-only calls. The pull request page frames the flowcharts under the goal and tags each hunk with the steps and rules that name it.

## Sub-features

- `functions-list`: every `review_diff` result carries `functions` (`<file>#<name>`, at most 40, product code first, no library calls).
- `explain-accept`: a complete explanation is kept, attributed to the MCP client, and `finish_review` returns `explained` counts.
- `explain-refuse`: a missing or unknown function, a code-like or Markdown text, an unresolved step exit, function, or hunk, a decision with fewer than two exits, or a changed rule without `before` refuses the whole call and keeps the previous explanation.
- `explain-report`: the report page's default view is "How it works"; flowcharts mark new, changed, and removed steps; the step list links hunks.
- `explain-callflow`: call-flow Tree, Sequence, and Diagram lead with the purpose; the "Show N library or framework calls" checkbox reveals folded plumbing.
- `explain-connected`: `/api/analysis` has `explanation` and `hunks[].business`; `/flow?snapshot=&view=business` serves the charts framed under the goal; the drawer opens on them.

## How to get to it (user POV)

- Ask the agent to review a pull request (or a branch) with diffninja. After `finish_review`, open the link: "How it works" sits under the goal on the pull request page and is the first tab of the report page.

## Driving it with drive.mjs

- **Write the explanation.** Drive once without `--explain`, read `structuredContent.functions` (or `report.functions`) from `review_diff.json`, read the code, and write the JSON by hand: purposes in the product's words, not the code's names.
- **Static.** `drive.mjs review --args '<git range JSON>' --explain explain.json --hold 600`. `report page opens on the business view` and `report page draws every process` read `PASS`.
- **Connected.** Add `--summary` and `--explain`; `finish_review refuses a connected reading without an explanation`, `pull request page has the attributed explanation`, and `pull request page serves the business view` read `PASS`.
- **See it.** During `--hold`, open the report page (How it works, then Call flow and its Diagram) and the pull request page (the How it works frame, the "In the business" tags on hunks, "Open beside the diff"). Check dark mode and a 390px-wide window: the chart scrolls inside its box, the page does not.

## Gotchas

- Hunk ids are positional per review: an explanation written for a static range may name different hunks in a connected review of the same pull request. Write it for the review you are finishing.
- A patch-only review lists no functions (it resolves no definitions), so `functions` is `[]`; the processes and rules still draw.
- The first git-range drive of a language installs its grammar through npm with the server's minimal environment; behind a TLS-intercepting proxy, pre-install it into `~/.cache/calldiff/grammars` with your shell's npm.
