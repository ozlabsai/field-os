// Tier-2: `abortSession` really closes the RPC WebSocket.
//
// WHY THIS EXISTS. Before upstream `8b08672`, the abort path did this:
//
//     resp = await newWorkersRpcResponse(req, ...);
//     resp?.webSocket?.close();          // <-- wrong end
//
// `newWorkersRpcResponse` builds a `WebSocketPair`, accepts `pair[0]` as the *server* end running
// the RPC session, and returns `pair[1]` to the client on the 101 response (verified in
// capnweb@0.8.0 `dist/index.js:2596`). So `resp.webSocket` is the end handed *to the client*, and
// closing it did nothing to the session. The mechanism was a silent no-op in three places:
// session expiry, `revokeAllSessions()`, and workspace-DO death (server.ts:307) -- the last of
// which has no other failure path, so the client kept a session whose backing DO was gone.
//
// The port replaces it with an AbortSignal that disposes the session stub. This test pins the
// observable consequence rather than the mechanism, so a future switch to `ctx.abort()` (which the
// upstream commit says is coming) keeps it meaningful.
//
// RED-CHECKED: reverting server.ts to the pre-port `resp?.webSocket?.close()` leaves the socket
// open and this test times out and fails. A test asserting only that `revokeAllSessions()`
// resolves would pass in both worlds, since the RPC itself always succeeded -- it was only the
// socket that never closed.

import { afterAll, beforeAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";
import { nextUsernames } from "@gadgets/integration-tests/rpc-client";
import { startStack } from "../src/stack.mjs";

// Same stand-in rpc-client's signUp() uses: the server stores and compares these bytes verbatim
// and never re-derives them, so tests skip the frontend's argon2id (64 MiB per call). Inlined
// rather than exported from rpc-client, which keeps it private deliberately.
/** @param {string} username */
const passwordHashFor = (username) =>
    new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest());

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack;

beforeAll(async () => {
  stack = await startStack();
}, 180_000);

afterAll(() => stack?.stop());

test("revokeAllSessions closes the RPC websocket, not just the call", async () => {
  const [username] = nextUsernames("revoke");

  // A raw socket rather than rpc-client's connect(), because the property under test is the
  // socket's own lifecycle -- connect() returns a stub and keeps the transport to itself.
  const wsUrl = new URL("/api", stack.url);
  wsUrl.protocol = "ws:";
  // Node 22's global WebSocket -- no `ws` dependency needed.
  const socket = new WebSocket(wsUrl.toString());
  const closed = new Promise((resolve) =>
      socket.addEventListener("close", () => resolve("closed"), { once: true }));

  // Typed like rpc-client's connect(): newWebSocketRpcSession is generic, and without the
  // parameter every method access is an error under types:check (which covers .js here).
  const api = /** @type {import("capnweb").RpcStub<
      import("@gadgets/workshop-shared/api").PublicApi>} */ (
      newWebSocketRpcSession(socket));
  try {
    // createAccount returns null when the username is taken; nextUsernames() makes that
    // impossible, but the null still has to be narrowed for types:check.
    const token = await api.createAccount(username, username, passwordHashFor(username));
    if (!token) throw new Error(`signup failed for "${username}"`);
    const authed = await api.authenticate(token);

    // Fails the in-flight call by design, so the rejection is expected and is not the assertion.
    await authed.revokeAllSessions().catch(() => {});

    // The assertion. Before the port this never resolved: the server end stayed open because the
    // code closed the client end.
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve("still open"), 10_000)),
    ]);
    expect(outcome).toBe("closed");
  } finally {
    socket.close();
  }
}, 60_000);
