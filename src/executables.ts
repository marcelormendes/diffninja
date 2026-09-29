import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Where a command the review runs (`git`, `gh`) really is.
 *
 * On Windows the runtime looks for a bare command name in the child's working
 * directory before it looks at PATH. Every git call runs with the repository under
 * review as its working directory, so a `git.exe` committed in that repository, or
 * a `gh.exe` in the directory the agent was started in, would run instead of the
 * real tool as soon as its branch is checked out. Here the name is resolved once
 * against PATH's absolute entries only, to a full path, and that path is what runs.
 * Elsewhere the name is returned as it is: PATH lookup does not search the
 * working directory.
 */
export interface ExecutableLookup {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

/** Only real executables: a `.cmd` or `.bat` cannot be started without a shell. */
const EXTENSIONS = [".exe", ".com"];

const resolved = new Map<string, string>();

export function resolveExecutable(name: string, lookup: ExecutableLookup = {}): string {
  const platform = lookup.platform ?? process.platform;
  if (platform !== "win32") return name;
  const env = lookup.env ?? process.env;
  const cacheable = lookup.env === undefined && lookup.exists === undefined;
  const known = cacheable ? resolved.get(name) : undefined;
  if (known !== undefined) return known;
  const exists = lookup.exists ?? existsSync;
  const path = env["PATH"] ?? env["Path"] ?? "";
  for (const raw of path.split(";")) {
    const directory = raw.trim().replace(/^"|"$/g, "");
    // A relative or empty entry means "here": never a place to find a tool.
    if (directory === "" || !win32.isAbsolute(directory)) continue;
    for (const extension of EXTENSIONS) {
      const candidate = win32.join(directory, name + extension);
      if (!exists(candidate)) continue;
      if (cacheable) resolved.set(name, candidate);
      return candidate;
    }
  }
  throw new Error(`${name} was not found on PATH. Only absolute PATH entries are searched, never the repository or the current directory.`);
}
