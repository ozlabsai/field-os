// Tier-1: does a DurableObjectId from idFromName() carry `.name` back on the pinned runtime?
//
// WHY THIS EXISTS (OZL-226). `#isAdmin()` in workshop-backend reads `this.user.id.name` and
// compares it against the ADMINS list (`server.ts:134`). If workerd ever drops that property, the
// admin check denies *everyone* — silently, and indistinguishably from a correctly configured
// deployment that simply has no admins. Four other call sites read it too
// (`server.ts:255,281,288,671`), including the one telling gatekeepers which admin is asking.
//
// It is a documented Cloudflare behaviour that `.name` is populated only for ids from
// `idFromName()`, so this is exactly the kind of unversioned runtime detail the parity suite
// exists to pin (see the handoff's point 4: our workerd dependencies are internals, valid for the
// pinned build and nothing else).
//
// HONEST PROVENANCE: this probe was written to confirm a hypothesis that turned out to be WRONG.
// Admin gating really did fail against a live stack with ADMINS set — but the cause was a stale
// `workerd serve` process still holding the port and serving a config built before ADMINS existed,
// not a missing `.name`. The probe passed first time and the real stack passed once the orphan was
// reaped. It is kept because the property is genuinely load-bearing and genuinely unversioned; it
// is NOT evidence of a bug that ever existed.
//
// The probe deliberately reads `.name` off BOTH the id it constructed and the stub's id, because
// those are different objects and only the second is what `#isAdmin()` actually touches.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { startWorkerd } from "../src/harness.mjs";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixture-do-id-name");

/** @type {Awaited<ReturnType<typeof startWorkerd>> | undefined} */
let server;
afterEach(async () => { await server?.stop(); server = undefined; });

test("idFromName() round-trips the name that #isAdmin() compares against", async () => {
  server = await startWorkerd({ fixtureDir });
  const res = await fetch(`${server.base}/?name=alice`);
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.requested).toBe("alice");

  // The assertion that matters: `#isAdmin()` compares this against ADMINS. Both forms are recorded
  // so a failure says which one broke.
  expect(body.stubIdName, "stub.id.name is what #isAdmin() reads; anything but \"alice\" means " +
      "admin gating denies everyone").toBe("alice");
  expect(body.idName).toBe("alice");
});
