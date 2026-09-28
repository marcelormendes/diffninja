import { afterEach, describe, expect, test, vi } from "vitest";
import { registryLatest, UpdateNotifier, updateStep } from "../src/review/update-check.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

describe("registryLatest", () => {
  test("reads the version of the package's latest release from the registry", async () => {
    const seen: string[] = [];
    globalThis.fetch = async input => { seen.push(String(input)); return Response.json({ name: "diffninja", version: "1.2.3" }); };
    expect(await registryLatest()).toBe("1.2.3");
    expect(seen).toEqual(["https://registry.npmjs.org/diffninja/latest"]);
  });

  test("an error status, odd JSON, or an unreachable registry is no answer, never a throw", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    expect(await registryLatest()).toBeUndefined();
    globalThis.fetch = async () => Response.json({ version: 3 });
    expect(await registryLatest()).toBeUndefined();
    globalThis.fetch = async () => { throw new Error("offline"); };
    expect(await registryLatest()).toBeUndefined();
  });
});

describe("UpdateNotifier", () => {
  test("notices only a strictly newer release", async () => {
    expect(await new UpdateNotifier(async () => "0.4.0", "0.3.2").notice()).toEqual({ current: "0.3.2", latest: "0.4.0", command: "npx diffninja@latest setup" });
    expect(await new UpdateNotifier(async () => "0.3.2", "0.3.2").notice()).toBeUndefined();
    expect(await new UpdateNotifier(async () => "0.3.1", "0.3.2").notice()).toBeUndefined();
    expect(await new UpdateNotifier(async () => "not a version", "0.3.2").notice()).toBeUndefined();
    expect(await new UpdateNotifier(undefined, "0.3.2").notice()).toBeUndefined();
  });

  test("a slow lookup does not hold up the review, and its answer counts on the next one", async () => {
    let answer: (version: string) => void = () => {};
    const notifier = new UpdateNotifier(() => new Promise(resolve => { answer = resolve; }), "0.3.2");
    const started = Date.now();
    expect(await notifier.notice()).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    answer("0.4.0");
    expect(await notifier.notice()).toMatchObject({ latest: "0.4.0" });
  });

  test("tells the agent to say it once and carry on", () => {
    const step = updateStep({ current: "0.3.2", latest: "0.4.0", command: "npx diffninja@latest setup" });
    expect(step).toContain("0.4.0");
    expect(step).toContain("npx diffninja@latest setup");
    expect(step).toContain("then continue this review");
  });
});
