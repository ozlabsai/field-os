// Tier-1: Durable Object durability across a hard kill. Generalizes the restart check in
// packages/fieldos-runtime/__tests__/workerd.test.js (there covering KV/R2/assets together) into a
// focused DO case. The airgapped deployment (scripts/run-workerd.mjs) runs DOs on local-disk SQLite
// storage rather than Cloudflare's own durable backing store; if that storage stopped surviving a
// process kill (a crash, an OOM kill, an operator's `kill -9`), every gadget/agent/gatekeeper DO --
// chat history, connected accounts, schedules -- would silently reset on next boot.
//
// CRITICAL (see this repo's own trap list): the restart must reuse the SAME uniqueKey, or it reads
// back from a different, empty DO and the test passes without proving anything. run-workerd.mjs
// guards this by persisting its generated uniqueKey to .workerd/keys.json across restarts; here the
// fixture's capnp hardcodes the uniqueKey as a string literal ("workerd-tests-do-durability" in
// fixture-do-durability/fixture.capnp), and this test reuses that same fixture file and the same
// on-disk storage directory for both boots, so the key is stable by construction. Storage is only
// reset once, before the first boot -- never between the two boots, since that would be exactly the
// mistake this test exists to catch.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { resetDoStorage, startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-do-durability");
const STORAGE_DIR = join(FIXTURE_DIR, "dodata");

/** @type {{base: string, stop: () => void} | undefined} */
let workerd;

afterEach(() => {
  workerd?.stop();
  workerd = undefined;
});

test("a value written before SIGKILL is readable after reboot against the same storage dir", async () => {
  resetDoStorage(STORAGE_DIR);

  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR });
  const write = await (await fetch(workerd.base + "/write?value=durable-42")).json();
  expect(write.wrote).toBe("durable-42");

  // SIGKILL, not stop()+graceful exit -- this is what proves the write reached disk (the SQLite
  // WAL) rather than merely an in-memory cache that a clean shutdown would have flushed anyway.
  workerd.stop();

  // Reboot against the identical fixture dir (same uniqueKey, same "dodata") -- do NOT call
  // resetDoStorage again here, that would erase the very thing under test.
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR });
  const read = await (await fetch(workerd.base + "/read")).json();
  expect(read.value).toBe("durable-42");
}, 30_000);
