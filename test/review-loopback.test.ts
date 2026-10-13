import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { serveConnected, type ConnectedSession } from "../src/review/connected.js";
import { listenLoopback, loopbackFromEnv, portFromEnv, PORT_SPAN, remoteFromEnv, remoteHint, trustedHosts } from "../src/review/loopback.js";
import { ReportPages } from "../src/review/report-pages.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});

function idle(): Server {
  const server = createServer((_req, res) => res.end());
  servers.push(server);
  return server;
}

/** A free port, found by listening on any and letting go of it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listenLoopback(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A GET with the Host and Origin headers given, so a forward's headers can be imitated. */
function getWith(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    request({ host: target.hostname, port: target.port, path: target.pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject).end();
  });
}

const CODESPACE = { kind: "codespaces", name: "fluffy-space-x7", domain: "app.github.dev" } as const;

describe("DIFFNINJA_PORT", () => {
  test("is optional, and must be a port number when set", () => {
    expect(portFromEnv({})).toBeUndefined();
    expect(portFromEnv({ DIFFNINJA_PORT: "" })).toBeUndefined();
    expect(portFromEnv({ DIFFNINJA_PORT: " 8765 " })).toBe(8765);
    for (const bad of ["0", "65536", "87a", "-1", "8765.5", "123456"]) {
      expect(() => portFromEnv({ DIFFNINJA_PORT: bad }), bad).toThrow(/DIFFNINJA_PORT must be a port number/);
    }
  });

  test("without it the system picks any free port on 127.0.0.1", async () => {
    const server = idle();
    const port = await listenLoopback(server);
    expect(port).toBeGreaterThan(0);
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
  });

  test("with it the first free port from there is used, skipping ports in use", async () => {
    const first = await freePort();
    const taken = idle();
    expect(await listenLoopback(taken, first)).toBe(first);
    const next = idle();
    const port = await listenLoopback(next, first);
    expect(port).toBeGreaterThan(first);
    expect(port).toBeLessThan(first + PORT_SPAN);
    expect(next.address()).toMatchObject({ address: "127.0.0.1" });
  });

  test("says which ports are busy when none in the span is free", async () => {
    const first = 65535;
    const blocker = idle();
    // The span is cut at 65535, so one busy port fills it.
    if ((await listenLoopback(blocker, first).catch(() => undefined)) !== first) return;
    await expect(listenLoopback(idle(), first)).rejects.toThrow("Ports 65535 to 65535 on 127.0.0.1 are all in use");
  });

  test("the report page and a pull request page listen from the chosen port", async () => {
    const first = await freePort();
    const pages = new ReportPages(undefined, { port: first });
    try {
      const url = await pages.add("<p>report</p>");
      const port = Number(new URL(url).port);
      expect(port).toBeGreaterThanOrEqual(first);
      expect(port).toBeLessThan(first + PORT_SPAN);
      const session: ConnectedSession = await serveConnected(undefined, { loopback: { port: first } });
      servers.push(session.server);
      expect(Number(new URL(session.url).port)).toBeGreaterThan(first - 1);
      expect(Number(new URL(session.url).port)).not.toBe(port);
      expect(session.server.address()).toMatchObject({ address: "127.0.0.1" });
    } finally {
      await pages.close();
    }
  });
});

describe("remote session detection", () => {
  test("a local session has none", () => {
    expect(remoteFromEnv({ TERM_PROGRAM: "vscode" }, "laptop")).toBeUndefined();
    expect(loopbackFromEnv({})).toEqual({});
  });

  test("SSH names the address the person dialed, its user and a port other than 22", () => {
    expect(remoteFromEnv({ SSH_CONNECTION: "203.0.113.9 51234 10.0.0.5 22", USER: "dev" }, "box")).toEqual({ kind: "ssh", host: "dev@10.0.0.5" });
    expect(remoteFromEnv({ SSH_CONNECTION: "203.0.113.9 51234 10.0.0.5 2222", USER: "dev" }, "box")).toEqual({ kind: "ssh", host: "dev@10.0.0.5", port: "2222" });
    // SSH_TTY alone carries no address: the machine's own name stands in.
    expect(remoteFromEnv({ SSH_TTY: "/dev/pts/1", LOGNAME: "dev" }, "box.lan")).toEqual({ kind: "ssh", host: "dev@box.lan" });
  });

  test("SSH values that are not a name or address stay out of the command", () => {
    expect(remoteFromEnv({ SSH_CONNECTION: "1.2.3.4 1 $(rm -rf ~) 22;x", USER: "a b" }, "box")).toEqual({ kind: "ssh", host: "box" });
    expect(remoteFromEnv({ SSH_TTY: "/dev/pts/1" }, "bad;name")).toEqual({ kind: "ssh", host: "<this-host>" });
  });

  test("Codespaces needs its name and forwarding domain, and wins over SSH and VS Code", () => {
    const env = { CODESPACES: "true", CODESPACE_NAME: "fluffy-space-x7", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev", SSH_CONNECTION: "1.1.1.1 1 2.2.2.2 22", TERM_PROGRAM: "vscode" };
    expect(remoteFromEnv(env, "box")).toEqual(CODESPACE);
    expect(remoteFromEnv({ ...env, CODESPACE_NAME: "evil.example/x" }, "box")).toEqual({ kind: "vscode" });
    expect(remoteFromEnv({ CODESPACES: "true", CODESPACE_NAME: "a" }, "box")).toBeUndefined();
  });

  test("VS Code counts only in a remote window: over SSH or in a dev container", () => {
    expect(remoteFromEnv({ TERM_PROGRAM: "vscode", SSH_CONNECTION: "1.1.1.1 1 2.2.2.2 22" }, "box")).toEqual({ kind: "vscode" });
    expect(remoteFromEnv({ TERM_PROGRAM: "vscode", REMOTE_CONTAINERS: "true" }, "box")).toEqual({ kind: "vscode" });
  });
});

describe("remote hint", () => {
  const report = "http://127.0.0.1:8765/report/" + "a".repeat(64);
  const page = "http://127.0.0.1:8766/" + "b".repeat(64) + "/";

  test("nothing to say on a local machine", () => {
    expect(remoteHint([report], {})).toBeUndefined();
    expect(remoteHint([report], { port: 8765 })).toBeUndefined();
  });

  test("SSH gives the exact forward for every port the links use", () => {
    const hint = remoteHint([page, report], { port: 8765, remote: { kind: "ssh", host: "dev@10.0.0.5" } });
    expect(hint).toContain("`ssh -N -L 8766:127.0.0.1:8766 -L 8765:127.0.0.1:8765 dev@10.0.0.5`");
    expect(hint).not.toContain("DIFFNINJA_PORT");
    const other = remoteHint([report], { remote: { kind: "ssh", host: "dev@10.0.0.5", port: "2222" } });
    expect(other).toContain("`ssh -N -L 8765:127.0.0.1:8765 -p 2222 dev@10.0.0.5`");
    expect(other).toContain("Set DIFFNINJA_PORT");
  });

  test("Codespaces gives each link's forwarded https address", () => {
    const hint = remoteHint([page, report], { remote: CODESPACE });
    expect(hint).toContain(`https://fluffy-space-x7-8766.app.github.dev/${"b".repeat(64)}/`);
    expect(hint).toContain(`https://fluffy-space-x7-8765.app.github.dev/report/${"a".repeat(64)}`);
    expect(hint).toContain("ports 8766 and 8765");
  });

  test("VS Code says the editor forwards the port", () => {
    expect(remoteHint([report], { remote: { kind: "vscode" } })).toMatch(/VS Code remote window, which forwards port 8765/);
  });
});

describe("hosts a page answers to", () => {
  test("its loopback address under both names, and in Codespaces its forwarded address", () => {
    expect([...trustedHosts(8765)]).toEqual(["127.0.0.1:8765", "localhost:8765"]);
    expect([...trustedHosts(8765, CODESPACE)]).toEqual(["127.0.0.1:8765", "localhost:8765", "fluffy-space-x7-8765.app.github.dev"]);
  });

  test("the report page accepts those hosts and refuses any other", async () => {
    const pages = new ReportPages(undefined, { remote: CODESPACE });
    try {
      const url = await pages.add("<p>report</p>");
      const port = new URL(url).port;
      expect(await getWith(url, { host: `localhost:${port}` })).toBe(200);
      expect(await getWith(url, { host: `fluffy-space-x7-${port}.app.github.dev` })).toBe(200);
      expect(await getWith(url, { host: `other-space-${port}.app.github.dev` })).toBe(403);
      expect(await getWith(url, { host: `localhost:${Number(port) + 1}` })).toBe(403);
    } finally {
      await pages.close();
    }
  });

  test("the pull request page accepts the forwarded origin and still refuses a foreign one", async () => {
    const session = await serveConnected(undefined, { loopback: { remote: CODESPACE } });
    servers.push(session.server);
    const port = new URL(session.url).port;
    const forwarded = `https://fluffy-space-x7-${port}.app.github.dev`;
    expect(await getWith(session.url + "api/state", { host: `localhost:${port}`, origin: forwarded })).toBe(200);
    expect(await getWith(session.url + "api/state", { host: `fluffy-space-x7-${port}.app.github.dev`, origin: forwarded })).toBe(200);
    expect(await getWith(session.url + "api/state", { host: `localhost:${port}`, origin: "https://attacker.example" })).toBe(403);
    const local = await serveConnected();
    servers.push(local.server);
    const localPort = new URL(local.url).port;
    expect(await getWith(local.url + "api/state", { host: `localhost:${localPort}`, origin: forwarded.replace(port, localPort) })).toBe(403);
  });
});
