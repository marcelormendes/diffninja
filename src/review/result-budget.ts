import { AGENT_RESULT_CHARS, agentReport, fitAgentView, type AgentView } from "./agent-view.js";
import type { ConnectedSnapshot } from "./github.js";
import { withVisibleControls } from "./hidden-characters.js";
import type { ReviewReport } from "./types.js";

/**
 * The most JSON one copy of a `review_diff` result may hold. The result travels
 * twice, as text content and as structured content, and MCP clients built on the
 * SDK drop the connection at 10 MiB per message: a 20,000-line pull request
 * produced 12 MB, which made the tool unusable for an ordinary large change.
 * The text copy is itself a JSON string inside the message, so it is measured
 * escaped once more: a change full of escaped quotes nearly doubles in it.
 *
 * The agent's view (agent-view.ts) is far smaller than this whenever it can be;
 * this limit is what a change of thousands of hunks, whose every id must still
 * be listed, is held to. The server keeps the whole report for the pages and
 * for validating what the agent sends back.
 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** Room left under {@link AGENT_RESULT_CHARS} for what a result adds around the report (ids, the analysis scope, next steps) when the caller does not measure it. */
const RESERVED_CHARS = 3_500;
/** What joining the report to the fields around it adds: their keys and the comma between. */
const JOIN_CHARS = 32;

/** Bytes of the value as the text copy carries it. */
const bytesOf = (value: AgentView): number => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");

/**
 * The report (and, for a connected review, its snapshot) as the agent is sent
 * it: hidden characters shown as markers, then the agent's view of it, fitted
 * under what an agent reads in one tool result. The markers come first because
 * they are what is sent: a 3-byte zero-width space becomes a 12-byte marker, so
 * a budget taken before them undercounts. `around` is the length of what the
 * result adds around the view, as sent. A view that lists so many hunks that
 * it is over `budget` bytes even with every hunk left out is refused.
 */
export function boundedForAgent(snapshot: ConnectedSnapshot | undefined, report: ReviewReport, budget: number = MAX_RESULT_BYTES, around: number = RESERVED_CHARS): AgentView {
  const shown = withVisibleControls({ snapshot, report });
  const lines = shown.snapshot === undefined ? undefined : (({ lines: _lines, ...rest }) => rest)(shown.snapshot);
  const view = fitAgentView({ snapshot: lines, report: agentReport(shown.report, shown.snapshot !== undefined) }, AGENT_RESULT_CHARS - around - JOIN_CHARS);
  const size = bytesOf(view);
  // Every hunk must stay listed for the agent to order it, so past this point a
  // result only shrinks by losing hunks; saying so beats a dropped connection.
  if (size > budget) {
    const hunks = report.items.length === 1 ? "1 hunk" : `${report.items.length} hunks`;
    throw new Error(`This result is too large to send: with every hunk listed by id only, the review of this change's ${hunks} is still ${(size / 1024 / 1024).toFixed(1)} MiB, over the ${budget / 1024 / 1024} MiB a client accepts in one message. Review the change in parts, with a narrower git range or a diff of fewer files.`);
  }
  return view;
}
