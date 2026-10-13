/**
 * Where the review pages listen, and how a person on another computer reaches them.
 *
 * Every page server binds 127.0.0.1 only; nothing here changes that. When the
 * agent runs on a remote machine (over SSH, in GitHub Codespaces, in a VS Code
 * remote window), the person reaches the port through a forward of their own,
 * and the tool result carries a note saying how. `DIFFNINJA_PORT` pins the
 * ports, so a forward set up once keeps working.
 */

import type { Server } from "node:http";
import { hostname } from "node:os";
import { z } from "zod";

/** Ports one server tries from `DIFFNINJA_PORT` up: the report page and every pull request page of a connection fit, with room for a second agent. */
export const PORT_SPAN = 32;

/** How the person reaches this machine, when it is not the one in front of them. */
export type RemoteSession =
  | { readonly kind: "ssh"; readonly host: string; port?: string }
  | { readonly kind: "codespaces"; readonly name: string; readonly domain: string }
  | { readonly kind: "vscode" };

export interface LoopbackOptions {
  /** First port to try; undefined lets the system pick any free one. */
  port?: number;
  remote?: RemoteSession;
}

/** The first port `DIFFNINJA_PORT` names, or undefined when it is not set. */
export function portFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env["DIFFNINJA_PORT"]?.trim() ?? "";
  if (raw === "") return undefined;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error("DIFFNINJA_PORT must be a port number from 1 to 65535, such as 8765.");
  return port;
}

/**
 * The remote session this process runs in, read from the variables SSH,
 * Codespaces and VS Code set. Values end up in a command or an address the
 * person copies, so anything that does not look like a name or address is
 * left out rather than passed on.
 */
export function remoteFromEnv(env: NodeJS.ProcessEnv, machine: string = hostname()): RemoteSession | undefined {
  const name = env["CODESPACE_NAME"] ?? "";
  const domain = env["GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"] ?? "";
  if (env["CODESPACES"] === "true" && /^[a-z0-9-]+$/i.test(name) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    return { kind: "codespaces", name, domain };
  }
  const ssh = env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined;
  // VS Code sets TERM_PROGRAM in its terminals, local ones too; only a remote window forwards ports.
  if (env["TERM_PROGRAM"] === "vscode" && (ssh || env["REMOTE_CONTAINERS"] === "true")) return { kind: "vscode" };
  if (!ssh) return undefined;
  // SSH_CONNECTION is "client-ip client-port server-ip server-port": the server side is the address the person dialed.
  const [, , address, port] = (env["SSH_CONNECTION"] ?? "").trim().split(/\s+/);
  const host = address !== undefined && /^[0-9a-f.:]+$/i.test(address) ? address : /^[a-z0-9.-]+$/i.test(machine) ? machine : "<this-host>";
  const user = env["USER"] ?? env["LOGNAME"] ?? "";
  const session: RemoteSession = { kind: "ssh", host: /^[a-z0-9._-]+$/i.test(user) ? `${user}@${host}` : host };
  if (port !== undefined && /^\d{1,5}$/.test(port) && port !== "22") session.port = port;
  return session;
}

export function loopbackFromEnv(env: NodeJS.ProcessEnv = process.env): LoopbackOptions {
  const options: LoopbackOptions = {};
  const port = portFromEnv(env);
  if (port !== undefined) options.port = port;
  const remote = remoteFromEnv(env);
  if (remote !== undefined) options.remote = remote;
  return options;
}

/**
 * Listen on 127.0.0.1 and return the port: any free one by default, or the
 * first free one from `first` up. Only a port in use moves on to the next.
 */
export async function listenLoopback(server: Server, first?: number): Promise<number> {
  const last = first === undefined ? 0 : Math.min(first + PORT_SPAN - 1, 65535);
  for (let port = first ?? 0; ; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return z.object({ port: z.number().int().positive() }).parse(server.address()).port;
    } catch (error) {
      if (first === undefined || z.object({ code: z.literal("EADDRINUSE") }).safeParse(error).success === false) throw error;
      if (port >= last) throw new Error(`Ports ${first} to ${last} on 127.0.0.1 are all in use. Set DIFFNINJA_PORT to another port, or unset it to let the system pick one.`);
    }
  }
}

/**
 * The origins a page on `port` answers to: its own loopback address under both
 * names (an `ssh -L` or VS Code forward keeps the port), and in Codespaces the
 * address GitHub forwards that port to. A page on any other origin, such as a
 * site that points its own name at 127.0.0.1, is still refused.
 */
export function trustedOrigins(port: number, remote?: RemoteSession): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (remote?.kind === "codespaces") origins.push(forwardedOrigin(remote, port));
  return origins;
}

/** The Host headers those origins send. */
export function trustedHosts(port: number, remote?: RemoteSession): Set<string> {
  return new Set(trustedOrigins(port, remote).map((origin) => new URL(origin).host));
}

function forwardedOrigin(remote: { readonly name: string; readonly domain: string }, port: number): string {
  return `https://${remote.name}-${port}.${remote.domain}`;
}

/**
 * What to tell the person, beside the page links, when they sit at another
 * computer: undefined on a local machine. The agent relays it with the links.
 */
export function remoteHint(urls: readonly string[], options: LoopbackOptions): string | undefined {
  const { remote } = options;
  if (remote === undefined || urls.length === 0) return undefined;
  const ports = [...new Set(urls.map((url) => Number(new URL(url).port)))];
  const named = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(" and ")}`;
  switch (remote.kind) {
    case "codespaces": {
      const forwarded = urls.map((url) => {
        const parsed = new URL(url);
        return forwardedOrigin(remote, Number(parsed.port)) + parsed.pathname;
      });
      return `This agent runs in GitHub Codespaces, so open ${forwarded.join(" and ")} instead: Codespaces forwards ${named} there. If it does not open, add ${named} in the Ports panel.`;
    }
    case "vscode":
      return `This agent runs in a VS Code remote window, which forwards ${named} to your computer, so the link opens there as it is. If the Ports view shows a different local port, change it to the same number: the page answers only on its own port.`;
    case "ssh": {
      const forwards = ports.map((port) => `-L ${port}:127.0.0.1:${port}`).join(" ");
      const command = `ssh -N ${forwards}${remote.port === undefined ? "" : ` -p ${remote.port}`} ${remote.host}`;
      const pin = options.port === undefined ? " Set DIFFNINJA_PORT for diffninja-mcp to keep the same ports next time." : "";
      return `This agent runs on another machine over SSH, so the link opens only there. On your own computer run \`${command}\` (use the name you normally connect to if that address differs), leave it running, and open the link as it is.${pin}`;
    }
  }
}
