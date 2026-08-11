// Tier-2: the gadget sandbox, exercised through the real workshop-backend.
//
// Tier 1 already proves the *shape* of the sandbox in a hand-written fixture: a worker loaded with
// `globalOutbound: null` cannot reach the network (sandbox-egress.test.js), same loader key
// returns the same isolate (loader-identity.test.js). This suite exists for the properties that a
// fixture structurally cannot express, because a fixture supplies its own `env`:
//
//   * `env` is CONSTRUCTED by the overseer (getEnvForLoader, overseer.ts:2087), never inherited.
//     The backend's own bindings -- LOADER, BLUEPRINTS, AVATARS, BLUEPRINT_CONTENT, every
//     GATEKEEPER_* service -- must not appear inside gadget code. A fixture has no parent env
//     worth leaking, so only the real backend can catch a regression here. This is the headline.
//   * The module map really is built from the workspace's Yjs document (overseer.ts:2334), and
//     `server.js` really is the main module (:2353).
//   * The runtime compatibility flags the gadget worker is given (:2349) take effect. These are
//     passed inside the WorkerLoaderWorkerCode object, which is a *different* mechanism from the
//     wrangler.jsonc flags compat-flags.test.js covers.
//
// EVERY case asserts a value only *running* gadget code could produce. A gadget that never started
// reports no egress exactly like a sandboxed one does -- that is how an earlier DoS repro passed
// while reproducing nothing (plans/handoff.md's traps), and it is the failure mode this file is
// most exposed to.
//
// RED-CHECKED. Each assertion was confirmed able to fail, by breaking the real backend and
// watching only the matching case go red:
//
//   env      `(env as any).BLUEPRINTS = "leaked"` in getEnvForLoader
//              -> only this case fails, reporting `+ "BLUEPRINTS"` against the expected list.
//   egress   `globalOutbound: null` deleted from loadGadgetWorker's worker definition
//              -> only this case fails, and the gadget's fetch genuinely returns SUCCEEDED, so
//                 the block is real rather than an artifact of the gadget failing early.
//   modules  the loader pointed at a fixed module map instead of the Yjs-derived one
//              -> the marker case fails with NOT-FROM-YJS.
//
// Worth knowing from that exercise: leaking the LOADER binding itself is not even expressible --
// workerd refuses with `Could not serialize object of type "WorkerLoader"`, a defence below the
// application code. The serializable-binding leak above is the reachable version of the bug.
//
// Cost: the stack is built and booted once for the whole file (see src/stack.mjs).

import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { connect, nextUsernames, signUp } from "@gadgets/integration-tests/rpc-client";
import { startStack } from "../src/stack.mjs";

/** The backend's own bindings (workshop-backend/wrangler.jsonc). None may reach gadget code. */
const PARENT_BINDINGS = ["LOADER", "BLUEPRINTS", "AVATARS", "BLUEPRINT_CONTENT"];

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack;

beforeAll(async () => {
  stack = await startStack();
}, 180_000);

afterAll(() => {
  stack?.stop();
});

/**
 * Gadget source that reports on its own sandbox.
 *
 * `probe()` returns data only reachable from inside the loaded worker, which is what makes it a
 * liveness check as well as an assertion surface: if the gadget never started, there is no object
 * to inspect and the test fails rather than silently passing.
 */
function gadgetSource() {
  return `
    import { DurableObject } from "cloudflare:workers";

    export class Gadget extends DurableObject {
      async probe() {
        const report = {
          // Proof this code ran at all. Every assertion below is meaningless without it.
          alive: "gadget-ran",
          // The whole point: what does the overseer actually hand us?
          envKeys: Object.keys(this.env ?? {}).sort(),
          // allow_irrevocable_stub_storage is passed in the loader's worker definition
          // (overseer.ts:2349-2352); ctx.restore existing is how that becomes observable.
          hasCtxRestore: typeof this.ctx?.restore === "function",
        };

        // globalOutbound: null (overseer.ts:2356) means there is no route to the network at all.
        // Reported rather than thrown so the test can tell "blocked" from "never got here".
        try {
          await fetch("http://example.com/");
          report.egress = "SUCCEEDED";
        } catch (err) {
          report.egress = "blocked: " + err;
        }

        return report;
      }
    }
  `;
}

/**
 * Create a workspace + gadget, write `source` into it, and run `probe()` inside the sandbox.
 *
 * This is the model-free path -- no inference server is involved. `bindingName` is passed
 * explicitly on purpose: omitting it makes the server derive one with the quick model
 * (overseer.ts:7349), which would make this suite depend on an LLM.
 *
 * @param {string} source - the gadget's `server.js`, which must export a class named `Gadget`.
 * @returns {Promise<any>} whatever the gadget's own `probe()` returned.
 */
async function runGadgetProbe(source) {
  const [username] = nextUsernames("sandbox");
  const api = connect(stack.url);
  const authed = await signUp(api, username);

  const overseer = await authed.newGadget();
  const gadget = await overseer.createGadget("Sandbox Probe", undefined, "PROBE");

  // The Yjs root map is named by the workpiece id -- `gadgetRootName` (overseer.ts:1521) returns
  // "" only for a legacy default gadget, which a client-created workspace does not have.
  const gadgetId = await gadget.getId();

  // V2 encoding is mandatory. A V1 update is not rejected at parse time; it misparses and
  // surfaces much later (overseer.ts:2022-2028). updateCode() validates before the append-only
  // put, so a mistake here fails loudly rather than bricking the workspace.
  const doc = new Y.Doc();
  doc.transact(() => {
    const text = new Y.Text();
    text.insert(0, source);
    doc.getMap(String(gadgetId)).set("server.js", text);
  });
  await overseer.updateCode(Y.encodeStateAsUpdateV2(doc));

  // connectToGadget returns a Proxy (overseer.ts:2429) and the loader only fires on the first
  // method call, so the call below -- not the connect -- is what loads the sandbox.
  //
  // Typed `any`: the gadget's methods are whatever its source declares, so the stub cannot be
  // statically typed here (the API itself returns RpcStub<any> for the same reason).
  /** @type {any} */
  const connected = await gadget.connectToGadget();
  return await connected.probe();
}

test("gadget code runs, and sees only the bindings the overseer built for it", async () => {
  const report = await runGadgetProbe(gadgetSource());

  // Liveness first: everything else is vacuous without it.
  expect(report.alive).toBe("gadget-ran");

  // The headline assertion. `getEnvForLoader` gives an unbound gadget exactly one entry, GADGET
  // (its own self-loopback); no binding edges exist because this gadget binds nothing.
  expect(report.envKeys).toEqual(["GADGET"]);

  // Stated separately from the equality above so a failure names the leaked capability rather
  // than dumping two arrays -- and so this keeps holding if a future gadget legitimately gains
  // binding edges.
  for (const binding of PARENT_BINDINGS) {
    expect(report.envKeys).not.toContain(binding);
  }
  expect(report.envKeys.filter(
      (/** @type {string} */ k) => k.startsWith("GATEKEEPER_"))).toEqual([]);
}, 120_000);

test("the loaded gadget has no route to the network", async () => {
  const report = await runGadgetProbe(gadgetSource());

  expect(report.alive).toBe("gadget-ran");
  // Matched on the prefix, not just "not SUCCEEDED": a gadget that failed before reaching the
  // fetch would also not report SUCCEEDED, and that must not read as a pass.
  expect(report.egress).toMatch(/^blocked: /);
}, 120_000);

test("the module map comes from the workspace's own Yjs document", async () => {
  // A value that exists nowhere but this test's source string. If the loader ran anything other
  // than the code written over RPC, this cannot come back.
  const marker = `yjs-sourced-${Date.now()}`;
  const report = await runGadgetProbe(`
    import { DurableObject } from "cloudflare:workers";
    export class Gadget extends DurableObject {
      probe() {
        return { alive: "gadget-ran", marker: ${JSON.stringify(marker)},
                 envKeys: Object.keys(this.env ?? {}).sort() };
      }
    }
  `);

  expect(report.alive).toBe("gadget-ran");
  expect(report.marker).toBe(marker);
}, 120_000);

test("the gadget worker gets the runtime compatibility flags the overseer passes", async () => {
  const report = await runGadgetProbe(gadgetSource());

  expect(report.alive).toBe("gadget-ran");
  // allow_irrevocable_stub_storage. Pins the flag set the gadget path passes, which is NOT the
  // same set as the agent's executeCode path (that one also sets disallow_importable_env,
  // overseer.ts:5451) -- an asymmetry worth noticing if either side changes.
  expect(report.hasCtxRestore).toBe(true);
}, 120_000);
