// Tier-2: the airgap assertion. Every worker's `fetch()` is routed to a recording interceptor
// service instead of the network, so a test can assert exactly what a running stack attempted.
//
// WHY THIS AND NOT THE EXISTING INTERCEPTOR. packages/integration-tests' network-interceptor.ts
// patches `globalThis.fetch` in the Node process, which works only because miniflare routes a
// Worker's outbound fetch back through Node -- standalone workerd does not, so it is inert here.
// Naming a *worker* service as `globalOutbound` (workerd.capnp: it is a ServiceDesignator, so any
// service will do) puts the interception BELOW the isolate: no JS reachable from inside a worker
// can bypass it. docs/testing.md called this "strictly stronger"; that is why.
//
// WHY IT MATTERS ON CI. Without it, "nothing escaped" is unfalsifiable on a runner that has real
// egress -- a successful escape and a correct block look identical from the outside. This suite is
// the thing that can tell them apart.
//
// The two cases below are deliberately opposite, because either alone would be misleading:
// one proves the interceptor SEES traffic (so an empty result means something), the other proves
// the gadget sandbox produces none.

import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { connect, nextUsernames, signUp } from "@gadgets/integration-tests/rpc-client";
import { startStack } from "../src/stack.mjs";

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack;

beforeAll(async () => {
  stack = await startStack({ interceptor: true });
  // The interceptor's readback socket reports its port on a second `listen` event, which arrives
  // just after the one startWorkerd resolves on.
  await new Promise(r => setTimeout(r, 1000));
}, 180_000);

afterAll(() => {
  stack?.stop();
});

test("the interceptor records a real outbound request instead of letting it out", async () => {
  const [username] = nextUsernames("airgap");
  const api = connect(stack.url);
  const authed = await signUp(api, username);

  // Point a model at a host that does not exist, then use it: the backend's own inference call is
  // the simplest genuine outbound request the stack makes. The hostname is deliberately
  // unroutable, so if the interceptor were NOT in the path this would fail with a DNS error
  // rather than quietly succeeding -- the test cannot pass by reaching the real internet.
  await authed.addModel(
      { type: "agent", id: "escapee", name: "Escapee" },
      { provider: "ollama", model: "escapee", apiToken: "",
        apiUrl: "http://airgap-probe.invalid" });

  const overseer = await authed.newGadget();
  // The chat will fail (the interceptor answers 403); that is expected and not what is asserted.
  await overseer.newChat("go", "escapee").catch(() => {});

  const deadline = Date.now() + 20_000;
  /** @type {string[]} */
  let intercepted = [];
  while (Date.now() < deadline) {
    intercepted = await stack.readIntercepted();
    if (intercepted.length > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // The URL, not just a count: this is what makes the record useful for diagnosing an escape, and
  // it proves the request that was caught is the one we provoked rather than incidental traffic.
  expect(intercepted.join("\n")).toContain("airgap-probe.invalid");
}, 120_000);

test("a gadget attempting egress produces no outbound request at all", async () => {
  const before = (await stack.readIntercepted()).length;

  const [username] = nextUsernames("airgapgadget");
  const api = connect(stack.url);
  const authed = await signUp(api, username);
  const overseer = await authed.newGadget();
  const gadget = await overseer.createGadget("Escaper", undefined, "ESCAPER");
  const gadgetId = await gadget.getId();

  const doc = new Y.Doc();
  doc.transact(() => {
    const text = new Y.Text();
    text.insert(0, `
      import { DurableObject } from "cloudflare:workers";
      export class Gadget extends DurableObject {
        async probe() {
          try {
            const res = await fetch("http://gadget-escape.invalid/steal");
            return { reached: true, status: res.status };
          } catch (err) {
            return { reached: false, err: String(err).slice(0, 120) };
          }
        }
      }
    `);
    doc.getMap(String(gadgetId)).set("server.js", text);
  });
  await overseer.updateCode(Y.encodeStateAsUpdateV2(doc));

  /** @type {any} */
  const connected = await gadget.connectToGadget();
  const result = await connected.probe();

  // Liveness first: a gadget that never ran also reports no egress, which is exactly how an
  // earlier DoS repro passed while reproducing nothing (plans/handoff.md's traps).
  expect(result.reached).toBe(false);
  expect(result.err).toMatch(/not permitted to access the internet/);

  // And nothing reached even the interceptor: `globalOutbound: null` on the gadget worker
  // (overseer.ts:2356) stops the request inside the isolate, before any outbound service is
  // consulted. The two mechanisms are complementary -- if that null were ever dropped, the
  // request would show up in this record instead of on the wire, which is the whole point of
  // having the interceptor underneath.
  expect(await stack.readIntercepted()).toHaveLength(before);
}, 120_000);
