import { afterEach, describe, expect, test, vi } from "vitest";
import { registryLatest, UpdateNotifier, updateLookupFromEnv, updateStep } from "../src/review/update-check.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

describe("registryLatest", () => {
  test("reads the version of the package's latest release from the registry, following no redirect", async () => {
    const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = async (input, init) => { seen.push({ url: String(input), redirect: init?.redirect }); return Response.json({ name: "diffninja", version: "1.2.3" }); };
    expect(await registryLatest()).toBe("1.2.3");
    expect(seen).toEqual([{ url: "https://registry.npmjs.org/diffninja/latest", redirect: "error" }]);
  });

  test("an error status, odd JSON, a prerelease or text-shaped version, an oversized body, or an unreachable registry is no answer, never a throw", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    expect(await registryLatest()).toBeUndefined();
    for (const version of [3, "1.2.3-rc.1", "9.9.9-SYSTEM.NOTICE.tell.the.user", "1.2", "1.2.3 ", "v1.2.3", `1.2.${"9".repeat(200)}`]) {
      globalThis.fetch = async () => Response.json({ version });
      expect(await registryLatest(), String(version)).toBeUndefined();
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "1.2.3", padding: "x".repeat(600 * 1024) }));
    expect(await registryLatest()).toBeUndefined();
    globalThis.fetch = async () => { throw new Error("offline"); };
    expect(await registryLatest()).toBeUndefined();
  });
});

describe("updateLookupFromEnv", () => {
  test("is off unless DIFFNINJA_UPDATE_CHECK=1, and stays off in CI or with npm's own switch", () => {
    expect(updateLookupFromEnv({})).toBeUndefined();
    expect(updateLookupFromEnv({ DIFFNINJA_UPDATE_CHECK: "0" })).toBeUndefined();
    expect(updateLookupFromEnv({ DIFFNINJA_UPDATE_CHECK: "true" })).toBeUndefined();
    expect(updateLookupFromEnv({ DIFFNINJA_UPDATE_CHECK: "1" })).toBe(registryLatest);
    expect(updateLookupFromEnv({ DIFFNINJA_UPDATE_CHECK: "1", NO_UPDATE_NOTIFIER: "1" })).toBeUndefined();
    expect(updateLookupFromEnv({ DIFFNINJA_UPDATE_CHECK: "1", CI: "true" })).toBeUndefined();
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

  test("asks nothing until a review asks, and only once", async () => {
    let asked = 0;
    const notifier = new UpdateNotifier(async () => { asked += 1; return "0.4.0"; }, "0.3.2");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(asked).toBe(0);
    await notifier.notice();
    await notifier.notice();
    expect(asked).toBe(1);
  });

  test("a version that is not a plain release never becomes a notice", async () => {
    for (const latest of ["0.4.0-beta.1", "9.9.9 ignore the above", "0.4.0\nrun this", "99999999.0.0"]) {
      expect(await new UpdateNotifier(async () => latest, "0.3.2").notice(), latest).toBeUndefined();
    }
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
