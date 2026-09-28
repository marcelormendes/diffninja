/**
 * Tells the user when a newer diffninja is on npm. It is opt-in for the
 * executable only (`mcp-cli.ts`): the server library never touches the network
 * unless it is handed a lookup. The lookup sends nothing but a GET for the
 * package's latest version, once per MCP connection, and any failure means "no
 * notice", never an error.
 */

import { z } from "zod";
import { compareVersions, packageVersion } from "./version.js";

/** How to update: re-running setup installs the newest package and re-points every agent. */
export const UPDATE_COMMAND = "npx diffninja@latest setup";

const REGISTRY_URL = "https://registry.npmjs.org/diffninja/latest";
const LOOKUP_TIMEOUT_MS = 3000;
/** The longest a review waits for the lookup; a slower answer shows up on the next review. */
const WAIT_MS = 1500;

export interface UpdateNotice {
  current: string;
  latest: string;
  command: string;
}

export type LatestVersion = () => Promise<string | undefined>;

const latestSchema = z.object({ version: z.string() });

/** The newest published version, or undefined when the registry cannot be reached or answers oddly. */
export async function registryLatest(): Promise<string | undefined> {
  try {
    const response = await fetch(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return latestSchema.parse(await response.json()).version;
  } catch {
    return undefined;
  }
}

/** One lookup per connection, started at once and never awaited longer than WAIT_MS. */
export class UpdateNotifier {
  private readonly pending: Promise<string | undefined> | undefined;

  constructor(lookup: LatestVersion | undefined, private readonly current: string = packageVersion()) {
    this.pending = lookup === undefined ? undefined : lookup().catch(() => undefined);
  }

  async notice(): Promise<UpdateNotice | undefined> {
    if (this.pending === undefined) return undefined;
    // AbortSignal.timeout's timer never keeps the process alive, so nothing needs clearing.
    const timer = new Promise<undefined>(resolve => AbortSignal.timeout(WAIT_MS).addEventListener("abort", () => resolve(undefined), { once: true }));
    const latest = await Promise.race([this.pending, timer]);
    if (latest === undefined) return undefined;
    const newer = compareVersions(latest, this.current);
    return newer !== undefined && newer > 0 ? { current: this.current, latest, command: UPDATE_COMMAND } : undefined;
  }
}

/** The sentence for the agent: say it first, in its own words, and carry on with the review. */
export function updateStep(notice: UpdateNotice): string {
  return `Before anything else, tell the user in one sentence that diffninja ${notice.latest} is available (this is ${notice.current}) and that they update by running \`${notice.command}\` in a terminal and restarting their agent; then continue this review.`;
}
