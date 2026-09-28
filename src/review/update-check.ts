/**
 * Tells the user when a newer diffninja is on npm. It is OFF unless the person
 * who starts the server turns it on with `DIFFNINJA_UPDATE_CHECK=1`: a review
 * tool that reads company code should make no request of its own by default.
 * When on, the lookup is one GET of the package's latest version, sent the
 * first time a review is requested (never at process start), and any failure
 * means "no notice", never an error. The server library never looks anything up
 * unless it is handed a lookup; only `mcp-cli.ts` builds one, from the
 * environment.
 */

import { z } from "zod";
import { compareVersions, packageVersion } from "./version.js";

/** How to update: re-running setup installs the newest package and re-points every agent. */
export const UPDATE_COMMAND = "npx diffninja@latest setup";

const REGISTRY_URL = "https://registry.npmjs.org/diffninja/latest";
const LOOKUP_TIMEOUT_MS = 3000;
/** The longest a review waits for the lookup; a slower answer shows up on the next review. */
const WAIT_MS = 1500;
/** The registry answers with the whole manifest of one release (tens of KB); anything near this is not it. */
const MAX_RESPONSE_CHARS = 512 * 1024;
/** Only a plain release counts: nothing else may reach the agent's instructions or a page. */
const RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export interface UpdateNotice {
  current: string;
  latest: string;
  command: string;
}

export type LatestVersion = () => Promise<string | undefined>;

const latestSchema = z.object({ version: z.string().regex(RELEASE) });

/** The newest published release, or undefined when the registry cannot be reached or answers oddly. */
export async function registryLatest(): Promise<string | undefined> {
  try {
    // A redirect would send the request somewhere the fixed URL above does not name.
    const response = await fetch(REGISTRY_URL, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return undefined;
    return latestSchema.parse(JSON.parse(text)).version;
  } catch {
    return undefined;
  }
}

/**
 * The lookup the executable uses: none unless `DIFFNINJA_UPDATE_CHECK=1`, and
 * never in CI or when npm's own `NO_UPDATE_NOTIFIER` is set.
 */
export function updateLookupFromEnv(env: NodeJS.ProcessEnv = process.env): LatestVersion | undefined {
  if (env["DIFFNINJA_UPDATE_CHECK"] !== "1") return undefined;
  if (env["NO_UPDATE_NOTIFIER"] !== undefined || env["CI"] !== undefined) return undefined;
  return registryLatest;
}

/** One lookup per connection, started by the first review that asks and never awaited longer than WAIT_MS. */
export class UpdateNotifier {
  private pending: Promise<string | undefined> | undefined;

  constructor(private readonly lookup: LatestVersion | undefined, private readonly current: string = packageVersion()) {}

  async notice(): Promise<UpdateNotice | undefined> {
    if (this.lookup === undefined) return undefined;
    this.pending ??= this.lookup().catch(() => undefined);
    // AbortSignal.timeout's timer never keeps the process alive, so nothing needs clearing.
    const timer = new Promise<undefined>(resolve => AbortSignal.timeout(WAIT_MS).addEventListener("abort", () => resolve(undefined), { once: true }));
    const latest = await Promise.race([this.pending, timer]);
    if (latest === undefined || !RELEASE.test(latest)) return undefined;
    const newer = compareVersions(latest, this.current);
    return newer !== undefined && newer > 0 ? { current: this.current, latest, command: UPDATE_COMMAND } : undefined;
  }
}

/** The sentence for the agent: say it first, in its own words, and carry on with the review. */
export function updateStep(notice: UpdateNotice): string {
  return `Before anything else, tell the user in one sentence that diffninja ${notice.latest} is available (this is ${notice.current}) and that they update by running \`${notice.command}\` in a terminal and restarting their agent; then continue this review.`;
}
