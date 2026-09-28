/**
 * The version of the running diffninja package, read from its own
 * `package.json`. Both layouts put it two levels up: `src/review/` in a
 * checkout and `dist/review/` in the published package, which always ships
 * `package.json`.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const manifestSchema = z.object({ version: z.string() });

let cached: string | undefined;

export function packageVersion(): string {
  cached ??= manifestSchema.parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))).version;
  return cached;
}

/**
 * Compare two `major.minor.patch` versions: negative when `left` is older,
 * zero when equal, positive when newer. A prerelease sorts before its release;
 * two prereleases of one release compare by their tags as text. Undefined when
 * either is not a version.
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function parseVersion(text: string): { core: [number, number, number]; prerelease: string | undefined } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (match === null) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
}
