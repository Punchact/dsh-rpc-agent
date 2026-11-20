import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { isFetchBlockedPort } from "../../dist/lib/transport.mjs";

export interface ListenSafeOptions {
  onConnection?: (socket: Socket) => void;
  host?: string;
  path?: string;
  createServerImpl?: typeof createServer;
  maxAttempts?: number;
}

export interface ListenSafeResult {
  server: Server;
  port: number;
  url: string;
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Bind an ephemeral loopback HTTP server while skipping WHATWG fetch's
 * blocked-port list (`FETCH_BLOCKED_PORTS`), so tests measuring transport/RPC
 * behavior never hit `EBADPORT` by OS port-0 chance.
 */
export async function listenSafe(
  handler: RequestListener,
  { onConnection, host = "127.0.0.1", path = "/dsh-rpc", createServerImpl = createServer, maxAttempts = 8 }: ListenSafeOptions = {},
): Promise<ListenSafeResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const server = createServerImpl(handler);
    if (onConnection) server.on("connection", onConnection);
    await new Promise<void>((resolve) => {
      server.listen(0, host, resolve);
    });
    const { port } = server.address() as AddressInfo;
    if (!isFetchBlockedPort(port)) {
      return { server, port, url: `http://${host}:${port}${path}` };
    }
    await closeServer(server);
  }
  throw new Error("could not get a port outside the fetch blocked-port list");
}

/** A safe ephemeral port nobody is listening on: bind, read the number, release it. */
export async function deadSafePort(host = "127.0.0.1"): Promise<number> {
  const { server, port } = await listenSafe(() => {}, { host });
  await closeServer(server);
  return port;
}
