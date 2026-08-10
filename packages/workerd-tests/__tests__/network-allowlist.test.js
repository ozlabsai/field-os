// Tier-1: network allow-list. Gadget/agent egress is restricted by a workerd `Network` service's
// `allow`/`deny` CIDR lists (see harness.mjs and the two fixture .capnp files here). Verified by
// execution: `allow = ["public", "127.0.0.0/8"]` reaches 127.0.0.1 while a non-matching private
// address stays blocked, and a blocked connect() logs `connect() blocked by restrictPeers()`
// server-side but surfaces to calling JS only as a bare `internal error; reference = <token>`
// Error — it does not name the blocked address, so these tests assert ok/not-ok, never message
// text.
//
// Hermetic: the allowed address is loopback with a listener this suite starts itself, so nothing
// here depends on LAN/internet reachability. The blocked address needs no listener — a blocked
// connection never reaches one, and macOS doesn't auto-alias secondary loopback addresses
// (127.0.0.2 etc.) the way Linux does, so binding one here would itself be non-hermetic.

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-network-allowlist");

const ALLOWED_ADDR = "127.0.0.1";
const BLOCKED_ADDR = "127.0.0.2"; // still loopback, but outside the permitted fixture's /32; unbound

/**
 * Starts a bare HTTP listener on the given loopback address:port and returns a stopper.
 * @param {string} address @param {number} port @returns {Promise<() => void>}
 */
function listenOn(address, port) {
  const server = createServer((_req, res) => res.end("ok"));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, address, () => resolve(() => server.close()));
  });
}

const PORT = 18813;
/** @type {() => void} */
let stopAllowedListener;

beforeAll(async () => {
  stopAllowedListener = await listenOn(ALLOWED_ADDR, PORT);
});

afterAll(() => {
  stopAllowedListener?.();
});

test('allow = ["public"] blocks a loopback address', async () => {
  const workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, configFile: "fixture-restrictive.capnp" });
  try {
    const result = await (
      await fetch(`${workerd.base}/?url=${encodeURIComponent(`http://${ALLOWED_ADDR}:${PORT}/`)}`)
    ).json();
    expect(result.ok).toBe(false);
  } finally {
    workerd.stop();
  }
}, 30_000);

test('allow = ["public", "127.0.0.1/32"] permits that address and still blocks a different loopback address', async () => {
  const workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, configFile: "fixture-permitted.capnp" });
  try {
    const allowed = await (
      await fetch(`${workerd.base}/?url=${encodeURIComponent(`http://${ALLOWED_ADDR}:${PORT}/`)}`)
    ).json();
    expect(allowed.ok).toBe(true);

    const blocked = await (
      await fetch(`${workerd.base}/?url=${encodeURIComponent(`http://${BLOCKED_ADDR}:${PORT}/`)}`)
    ).json();
    expect(blocked.ok).toBe(false);
  } finally {
    workerd.stop();
  }
}, 30_000);
