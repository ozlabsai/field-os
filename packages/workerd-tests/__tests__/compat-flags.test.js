// Tier-1: compatibility flags the pinned workerd binary accepts. scripts/run-workerd.mjs:277-280
// (compatibilityFlags()) strips `enable_ctx_exports` from every worker's flag list because it is a
// FATAL config error at compatibilityDate = "2026-02-02" for the pinned binary -- an upstream
// commit adding a flag the pinned binary rejects would otherwise break the airgapped deployment at
// boot. This suite has two halves: the positive control boots a fixture carrying the exact union
// of compatibility flags the real deployment's wrangler.jsonc files declare (proving today's real
// flag set is fine), and the negative control boots the same set plus `enable_ctx_exports` and
// asserts that specific addition is what breaks the boot -- pinning the reason for the strip, not
// just its existence.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-compat-flags");

test("the real deployment's compatibility flags boot on the pinned workerd binary", async () => {
  const workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, configFile: "fixture-accepted.capnp" });
  try {
    const res = await fetch(workerd.base + "/");
    expect(res.status).toBe(200);
  } finally {
    workerd.stop();
  }
}, 30_000);

test("adding enable_ctx_exports at compatibilityDate 2026-02-02 fails to boot", async () => {
  // The harness's readiness promise rejects when workerd exits before reporting a listen event
  // (see harness.mjs's `proc.on("exit", ...)` reject path) -- a fatal config error never gets to
  // "listen", so this surfaces here as a rejected promise, not as a resolved server the request
  // then fails against.
  await expect(
      startWorkerd({ fixtureDir: FIXTURE_DIR, configFile: "fixture-rejected.capnp" }),
  ).rejects.toThrow(/workerd exited early/);
}, 30_000);
