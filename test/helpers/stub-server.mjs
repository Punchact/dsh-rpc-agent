import { createServer } from "node:http";

import { isFetchBlockedPort } from "../../lib/transport.mjs";

export async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

/**
 * Bind an ephemeral loopback HTTP server while skipping WHATWG fetch's
 * blocked-port list (`FETCH_BLOCKED_PORTS`), so tests measuring transport/RPC
 * behavior never hit `EBADPORT` by OS port-0 chance.
 */
export async function listenSafe(
  handler,
  { onConnection, host = "127.0.0.1", path = "/dsh-rpc", createServerImpl = createServer, maxAttempts = 8 } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const server = createServerImpl(handler);
    if (onConnection) server.on("connection", onConnection);
    await new Promise((resolve) => server.listen(0, host, resolve));
    const { port } = server.address();
    if (!isFetchBlockedPort(port)) {
      return { server, port, url: `http://${host}:${port}${path}` };
    }
    await closeServer(server);
  }
  throw new Error("could not get a port outside the fetch blocked-port list");
}

/** A safe ephemeral port nobody is listening on: bind, read the number, release it. */
export async function deadSafePort(host = "127.0.0.1") {
  const { server, port } = await listenSafe(() => {}, { host });
  await closeServer(server);
  return port;
}
