import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

/** The text of each call to `name` in `source`, from its opening parenthesis to the matching one. */
function callsTo(source: string, name: string): string[] {
  const calls: string[] = [];
  for (let at = source.indexOf(`${name}(`); at !== -1; at = source.indexOf(`${name}(`, at + 1)) {
    const open = at + name.length;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(open, end + 1));
  }
  return calls;
}

describe("child processes that diffninja starts and waits for", () => {
  test("every execFileSync and execFile call in src states a timeout, so a stalled child cannot hang the server", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".ts")).sort();
    expect(files.length).toBeGreaterThan(10);
    const withoutTimeout: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      for (const name of ["execFileSync", "execFile"]) {
        for (const call of callsTo(source, name)) {
          if (!/\btimeout\b/.test(call)) withoutTimeout.push(`${file}: ${name}${call.slice(0, 70).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(withoutTimeout).toEqual([]);
  });
});
