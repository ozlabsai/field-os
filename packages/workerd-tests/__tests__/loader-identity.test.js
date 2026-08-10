// Tier-1: worker-loader isolate identity/caching. overseer.ts#loadGadgetWorker
// (packages/workshop-backend/src/overseer.ts around 2317-2320) calls
// `env.LOADER.get(\`${this.ctx.id}.${codeVersion}.${gadgetId}\`, factory)`. That key is built so a
// gadget's code change (a bumped codeVersion) yields a fresh isolate while unrelated requests for
// the same version keep reusing one -- this is the whole point of keying by semantic codeVersion
// instead of, say, a random id per call. If LOADER.get ever stopped being stable per key (or
// started being stable across different keys), a gadget's module-scope state would either leak
// across incompatible code versions or get needlessly re-initialized on every request. This suite
// boots the same worker-loader shape (`--experimental`, factory returning `mainModule`/`modules`)
// and observes isolate identity through module-scope state, not through any workerd internals.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-loader-identity");

/** @type {{base: string, stop: () => void}} */
let workerd;

beforeAll(async () => {
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, extraArgs: ["--experimental"] });
}, 30_000);

afterAll(() => {
  workerd?.stop();
});

/** @param {string} key */
async function load(key) {
  return (await fetch(`${workerd.base}/?key=${encodeURIComponent(key)}`)).json();
}

test("the same key returns the same isolate across requests", async () => {
  const first = await load("gadget-a.v1");
  const second = await load("gadget-a.v1");
  const third = await load("gadget-a.v1");

  // requestCount only advances across calls if the module-scope counter survived between them,
  // which only happens if LOADER.get returned the same isolate both times.
  expect(second.requestCount).toBe(first.requestCount + 1);
  expect(third.requestCount).toBe(first.requestCount + 2);
});

test("a different key returns a fresh isolate", async () => {
  await load("gadget-a.v1");
  const first = await load("gadget-a.v1"); // establish a nonzero baseline count for this key
  const changed = await load("gadget-a.v2"); // simulates a bumped codeVersion

  expect(first.requestCount).toBeGreaterThan(1);
  // A fresh isolate starts its own counter from 1, not continuing the other key's count -- if it
  // had reused the isolate this would be first.requestCount + 1 instead.
  expect(changed.requestCount).toBe(1);
});
