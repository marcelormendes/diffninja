# How diffninja analyzes a change

This is the detailed version of what the [README](../README.md) summarizes:
what diffninja checks, how it ranks hunks, and where its evidence stops.

## What a report contains

Ask your agent to review a patch, the working tree, or a range such as
`main..HEAD` in a repository. It calls `review_diff` with `diff` text or with
`repo`, `from`, and `to`, and receives the report as the tool result: the exact
expected outcome when supplied (`expectedOutcome`), a short reading agenda,
bounded automatic findings, explicit check coverage, and every hunk, ranked as
**attention**, **uncertain**, **low**, or **passed**; git ranges add call flows
and snapshot-bound source. Claims in a description are not proof that the code
fulfills them. Once the agent has sent its reading (below), it gets `reportUrl`:
a read-only page on `127.0.0.1` with the same report for you to read (the
agenda, call-flow graphs, and every hunk), served from memory for as long as
the agent's session lasts.
The tool writes no report files. Arguments and examples:
[mcp-setup.md](mcp-setup.md). Trying it on real reviews:
[pilot.md](pilot.md).

## The steps

1. **Evidence first.** No-op hunks and blank-only document changes pass.
   Repository snapshots support bounded checks for duplicate function bodies and
   unread `errors` response fields, plus caller and contract source cards.
   Optional TypeScript reference checking compares before/after diagnostics,
   including unchanged consumers, using an explicitly trusted installed compiler.
   Unsupported or incomplete checks say so.
2. **Change facts per hunk.** The added and removed lines are read lexically —
   strings and comments set aside, moved lines cancelling out. Code gets six facts:
   comparison changed, limit changed (a numeric bound, or `<` turned into `<=`),
   input check changed (type/shape checks, or a changed guard in front of a
   raise), failure handed to the caller, failure deferred or retried, failure
   discarded (an empty or defaulting `catch`, `except: pass`, …). Documentation
   (`.md`, `.rst`, `.txt`, …) is asked whether an instruction to readers changed
   (must, never, only, at most, …), a link target changed, or a numeric limit
   changed. Configuration (`.yml`, `.json`, `.toml`, Dockerfiles, `.env`, …) is
   asked whether a CI gate was weakened (`continue-on-error`, `|| true`, a
   failure turned into a warning, a check step removed), permissions or secret
   access changed, a version pin changed, or a limit changed. Each `yes` cites
   its changed line. `no` speaks only about the lines the hunk shows. A change
   that only touches formatting, comments, or line breaks is recognized as such.
   JS/TS, Java, C#, Go, Rust, C/C++, Kotlin, Swift, PHP, Python, Ruby,
   documentation and configuration are read; any other file type says that no
   facts were established instead of claiming none.
3. **Status and order.** A code or configuration change outside a test file
   reads **attention**; documentation reads **attention** when it changes an
   instruction, a link, or a limit, **low** otherwise; a test-file change reads
   **attention** only when it changes a limit, discards a failure, or weakens a
   gate, **low** otherwise; a formatting-only change **passed**;
   an unread file type, or a hunk with a changed line over 4,000 characters,
   **uncertain**, for a person to read. Priority orders hunks:
   a fixed base, plus 10 for a real change, plus the heaviest fact of the
   boundary group (what the change says or bounds) and of the failure group
   (failures, CI gates, permissions) — each group counts once, never summed. The report lists
   manual work first (binary and other metadata-only units), then the read hunks
   by priority, then passes; among equal priorities the hunk that changes more
   lines comes first. Hunks in test files (by path convention: `test/`,
   `*.test.ts`, `test_*.py`, `*_test.go`, …, including snapshots diffninja does
   not read) come after the other hunks, still ordered by their own priority: a
   regression test changes as much as its fix.
   Documentation is not demoted, because prose can be normative. Status is a
   label for filtering and never reorders the report.
4. **Questions for your agent.** Where a judgment needs meaning rather than
   syntax, the report asks the agent that requested it — does this hunk change
   what callers observe, does a test exercise it, does a test change weaken it,
   do the docs match the code, does the hunk serve the stated goal. Questions
   are fixed templates with closed options (always including `cannot-tell`).
   diffninja itself still calls no model.
   The agent sends its whole reading in one `finish_review` call: an answer to
   every question, the reading order of every hunk (most important first),
   and the comments that block the merge (usually none). Connected PR reviews also
   require `summary`: one plain-English paragraph, at most 80 words and 600
   characters, with no Markdown or control characters. The agent explains the
   stated goal, why it matters when known, and important limits, without jargon,
   templates, or a file-by-file changelog. If the title and description do not
   establish a goal, it must say so instead of inventing one. diffninja enforces
   the format and size; wording and meaning remain the host agent's responsibility.
   No extra model call is made by diffninja.
   Everything is checked before anything is kept or a link is returned.
   The connected page leads with this attributed goal and keeps the original
   description collapsed, rendered as Markdown. Raw HTML remains text and
   images become links, so opening the description loads nothing remotely.
   A later `finish_review` can replace the summary; a new snapshot must get
   its own. Static reviews may omit `summary`.
   The pages list every hunk in the agent's
   order, attributed to it; diffninja's own order stays available one click
   away, and statuses stay diffninja's. On the pull request page you tick a
   change in that list to mark it viewed. Scrolling ticks nothing, and a tick
   changes no status, priority or order and hides no diff. A file is marked
   Viewed on GitHub, as you, once all of its changes are ticked (the page reads
   GitHub's marks when it loads, and a file already marked starts ticked; see
   [reference.md](reference.md#viewed-marks)). `record_answers`, `record_order`,
   and `suggest_comments` update a review afterwards. The author's own evaluation on
   159 held-out open-source pull requests, weighted by the severity of
   maintainers' actual review comments, found that a host model that read
   diffninja's report put the serious comments earlier than diffninja's
   deterministic order did. The evaluation data is not in this repository, and
   this page has not verified that result.
   On a pull request, a suggested comment exists only for what blocks the
   merge. Each is short, in the reviewer's own voice, with no "Finding 1:"
   scaffolding, and carries its proof: a concrete scenario, whether the agent
   ran it or traced the code, and what would have to be true for it not to be a
   problem. There are at most five, and only on lines the pull request adds or
   removes. Everything that does not block is discarded by design, and the
   agent says it in its own reply instead. The page shows each blocker under its
   line with that proof; you add one or all of them to your draft with a click
   (only the comment text joins the draft), edit or dismiss them, and submit
   the review yourself. No diffninja tool posts anything, and the agent is told
   never to submit through the page.
5. **The business explanation.** Function names and call graphs tell a reader
   little about what a change does to the product. Every report lists
   `functions`: each function a reader meets around the hunks and in the call
   flows (the project's own definitions, not library calls), once, as
   `<file>#<name>`, with a hidden character shown as a marker, which is the
   form the agent sends back. The reviewing agent, which read the code, sends
   `explanation` with its reading: one plain sentence per listed function on
   what it does for the business, one to four business processes as steps and
   decisions with the steps this change adds, changes, or removes marked (like
   a diff laid over the process), and the business rules the change adds,
   changes, or removes, each changed one with what it was before. It is
   required for a pull request review. diffninja checks the shape only: every
   listed function is explained once, every step exit and every function or
   hunk reference resolves, and every text is one plain line within its bound
   with nothing that reads like code (calls, snake_case names, source paths,
   backticks, Markdown). The report opens on **How it works**, which draws each
   process as a flowchart laid out deterministically (branches side by side,
   skips and retries in lanes beside the chart, so no arrow crosses a box), a
   numbered step list with the purpose of the functions behind each step, and
   the rules as before and after. The call flows put each function's purpose
   above its code name and fold away calls with no project code below them.
   The pull request page shows the flowcharts under the goal and tags each hunk
   with the steps and rules that name it. It is all the agent's reading,
   attributed to it, never a verdict, and it never changes status or order.
6. **Project context (git ranges only).** What a diff does not show is often
   the project around it. From the local clone alone (diffninja runs no fetch;
   in a partial clone git may itself fetch missing objects from that clone's
   remote, as `git log -p` would) the report names the commits that last changed each hunk's removed lines
   (`git blame` at the base), earlier revert commits that touched a changed
   file or share a rare word with the goal or the changed file names,
   contributor guidelines that apply (`CONTRIBUTING`, `AGENTS.md`, `.github/`,
   docs policy pages such as versioning or preview rules), and, for a new
   file, identifiers most of its same-named siblings use and it does not
   (`components/*/select.py`). They add questions for your agent: does a hunk
   undo a fix it removes, does the change reintroduce something reverted, does
   it follow the guidelines and the sibling pattern. These are pointers, not
   verdicts, and never change status or order. A shallow clone says so: lines
   whose origin lies past its boundary count as unknown.

Intent cross-checks keep author claims and generated summaries separate.
Source matches are navigation evidence, not proof of fulfillment. Broad goals,
missing metadata, and behavior not established by the available code remain
explicitly unestablished. Findings likewise state their scope: duplicated syntax
is not necessarily duplicated responsibility, and an unread field alone does not
prove that a real failure was mishandled.

Git-range analysis supplies selected call-site blocks from both snapshots,
including written arguments, declared parameters, locations, and explicit target
and binding uncertainty. Unambiguous same-file JS/TS and Python calls support
positional binding; Python also supports named arguments. Imports, member
dispatch, dynamic targets, and other grammars do not get guessed mappings.
These are static source expressions, not runtime values or data-flow analysis.
TypeScript/TSX extraction includes methods of decorated exported classes,
including stacked and custom decorators; method source spans retain their
decorators so decorator-only changes still select the method body. Simple explicit class-field and
constructor-property types identify candidate dependency methods; unsupported
receiver types stay unresolved rather than borrowing the containing class's
method. These are not type-checked or proven runtime bindings.

Review context also follows candidate event and queue relations: static
`emit`/`emitAsync` keys match `@On*Event` handlers; injected queue `.add` keys
match `@Processor` consumers' `job.name` cases or `@Process` methods only on a
matching queue channel. String enum values can connect member keys to literal
cases. These are source-derived relations, not runtime calls or proof of
delivery; dynamic keys, aliases, and unrecognized framework syntax can be absent.
Constant resolution is snapshot-local, including when extraction is cached.

Module-level TypeScript/TSX interfaces, type aliases, and enums are addressable
non-callable context nodes. Signature, body, and generic type references connect
them to reviewed methods and other contracts. Relative import bindings take
precedence; unique module-path suffixes and unimported names are candidate
matches, not type checking. Unresolved imports do not borrow same-named types.
Barrel re-exports, nested declarations, and class-field contracts may be absent.

Context prioritizes calls adjacent to the hunk, with depth limited to four,
at most eight arguments per call, and 120 characters per argument excerpt.
Snapshot-bound changed definitions, callers, callees, dispatch endpoints, and
type contracts carry complete source plus selected relation evidence. Bodies not
already shown in the hunk take precedence over duplicate source. Unseen type
declarations and dispatch endpoints precede ordinary caller chains, nearest
first, with resulting-snapshot evidence ahead of prior-snapshot duplicates.
Unresolved own-call expressions remain verbatim in a whole source body rather
than repeating unknown-binding boilerplate. At most eight distinct definition
nodes are kept per hunk, each carried whole, never shortened.

Automatic response/caller evidence is narrower than the candidate call graph:
it requires a supported lexical or typed-constructor binding. Relative modules
and simple single-target `paths` aliases from snapshot-local, standalone JSON
`tsconfig.json` files are supported. JSONC, inherited configurations, package or
barrel resolution, and complex receivers remain unproven rather than borrowing
an unrelated same-named function. `referenceProject: "path/to/tsconfig.json"`
opts into the separate TypeScript diagnostic comparison; absent dependencies,
unsupported project layouts, and exceeded bounds are reported as not checked.
