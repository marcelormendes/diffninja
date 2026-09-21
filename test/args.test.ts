import { outdent } from "outdent";
import { describe, expect, test } from "vitest";
import { workspace } from "./workspace.js";

const src = outdent({ trimTrailingNewline: false });

describe("token flags in default ASCII mode", () => {
  test("--token-count reports a real count", () => {
    const host = workspace({
      "/app.ts": src`
        export function boot() {
          load();
          run();
        }
        function load() {}
        function run() {}
      `,
    });
    const result = host.run("calldiff tree -e boot --token-count");
    expect(result.code).toBe(0);
    const count = Number(result.stdout.trim());
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThan(0);
  });

  test("--token-limit actually truncates", () => {
    const host = workspace({
      "/app.ts": src`
        export function boot() {
          load();
          run();
        }
        function load() {}
        function run() {}
      `,
    });
    const limited = host.run("calldiff tree -e boot --token-limit 5");
    expect(limited.code).toBe(0);
    expect(limited.stdout).toMatch(/truncated: showing tokens/);
    expect(limited.stdout).not.toContain("run()");
  });

  test("output is unchanged without the flags", () => {
    const host = workspace({
      "/app.ts": src`
        export function boot() {
          load();
        }
        function load() {}
      `,
    });
    const result = host.run("calldiff tree -e boot");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("boot()");
    expect(result.stdout).not.toMatch(/truncated: showing tokens/);
  });

  test("--token-offset skips the start of the output", () => {
    const host = workspace({
      "/app.ts": src`
        export function boot() {
          load();
          run();
        }
        function load() {}
        function run() {}
      `,
    });
    const result = host.run("calldiff tree -e boot --token-offset 5");
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("calldiff tree working tree");
  });
});

describe("calldiff CLI", () => {
  test("--help exits successfully and mentions subcommands", () => {
    const host = workspace();
    const result = host.run("calldiff --help");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/calldiff/);
    expect(result.stdout).toMatch(/diff/);
    expect(result.stdout).toMatch(/tree/);
    expect(result.stdout).toMatch(/reach/);
  });

  test("--llms prints agent manifest", () => {
    const host = workspace();
    const result = host.run("calldiff --llms");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/calldiff/);
    expect(result.stdout).toMatch(/tree/);
    expect(result.stdout).toMatch(/reach/);
  });

  test("tree without --entry fails", () => {
    const host = workspace();
    const result = host.run("calldiff tree");
    expect(result.code).toBeGreaterThan(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/--entry/);
  });

  test("reach without --to fails", () => {
    const host = workspace({
      "/app.ts": src`
        export function boot() {}
      `,
    });
    const result = host.run("calldiff reach -e boot");
    expect(result.code).toBeGreaterThan(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/\bto\b/);
  });

  test("unknown command and unknown flag fail", () => {
    const host = workspace();

    const command = host.run("calldiff --not-a-real-flag");
    expect(command.code).toBeGreaterThan(0);
    expect(`${command.stdout}\n${command.stderr}`).toMatch(/is not a command/);

    const flag = host.run("calldiff tree --not-a-real-flag");
    expect(flag.code).toBeGreaterThan(0);
    expect(`${flag.stdout}\n${flag.stderr}`).toMatch(
      /Unknown flag: --not-a-real-flag/,
    );
  });

  test("strips lone -- separators so path filters still work", () => {
    const host = workspace({
      "/src/app.ts": src`
        export function boot() {
          run();
        }
        function run() {}
      `,
      // The decoy exports the same entry name, so the filter is what decides
      // which definition is walked: without it the other file would be found.
      "/other/decoy.ts": src`
        export function boot() {
          boom();
        }
        function boom() {}
      `,
    });
    const result = host.run("calldiff tree -e boot -- src");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("run()");
    expect(result.stdout).not.toContain("boom()");
  });
});
