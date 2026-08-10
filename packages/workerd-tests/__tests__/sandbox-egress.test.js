// Tier-1: gadget sandbox egress. overseer.ts#loadGadgetWorker loads gadget code as a dynamic
// worker with `globalOutbound: null` (packages/workshop-backend/src/overseer.ts around line
// 2356) specifically so gadget code cannot reach the network directly. This is the largest
// untested surface in the fork — a regression here (e.g. a stray `globalOutbound` default, or a
// loader config that drops the field) would silently let gadget/agent code make outbound
// requests. This suite boots the same worker-loader shape workerd needs (`--experimental`,
// object-map `modules`, required `mainModule`) and proves the sandboxed worker's own fetch fails.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-sandbox-egress");

/** @type {{base: string, stop: () => void}} */
let workerd;

beforeAll(async () => {
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, extraArgs: ["--experimental"] });
}, 30_000);

afterAll(() => {
  workerd?.stop();
});

test("a gadget worker loaded with globalOutbound: null cannot fetch the network", async () => {
  const result = await (await fetch(workerd.base + "/")).json();
  expect(result.egressSucceeded).toBe(false);

  // Assert the sandbox actually ran and was refused, not merely that no egress was observed. A
  // gadget that never started also reports no egress -- that is exactly how an earlier DoS repro
  // passed while reproducing nothing (plans/handoff.md traps). `detail` carries the sandboxed
  // worker's own report, so it distinguishes "blocked" from "never got there".
  expect(result.detail).toMatch(/^egress-blocked: /);
});
