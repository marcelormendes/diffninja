import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const read = <Schema extends z.ZodType>(name: string, schema: Schema): z.infer<Schema> => schema.parse(JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")));

const manifest = read("package.json", z.object({ dependencies: z.record(z.string(), z.string()) }).passthrough());
const shrinkwrap = read("npm-shrinkwrap.json", z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.object({ version: z.string().optional(), resolved: z.string().optional(), integrity: z.string().optional(), link: z.boolean().optional(), dependencies: z.record(z.string(), z.string()).optional() }).passthrough()),
}));

describe("the published dependency tree is pinned", () => {
  test("npm-shrinkwrap.json is the repository's lockfile: there is no second one to drift from it", () => {
    expect(() => readFileSync(new URL("../package-lock.json", import.meta.url))).toThrow();
  });

  test("every package in it resolves from the public registry and carries a sha512 integrity hash", () => {
    const entries = Object.entries(shrinkwrap.packages).filter(([path]) => path !== "");
    expect(entries.length).toBeGreaterThan(100);
    for (const [path, entry] of entries) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });

  test("its root asks for exactly what package.json declares, so npm ci accepts it", () => {
    const root = shrinkwrap.packages[""];
    expect(root?.dependencies).toEqual(manifest.dependencies);
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(shrinkwrap.packages[`node_modules/${name}`]?.version, name).toBeTruthy();
      expect(range, name).toMatch(/^[\^~]?\d/);
    }
  });
});
