// Tier-2: `ctx.restore()` inside the agent's executeCode sandbox, per plans/tier2-ctx-restore.md.
//
// This pins the "wacky hack" self-token redirect (overseer.ts:5474-5489): the code-mode worker is
// loaded with a `ctx.restore()` self-token whose params, replayed later, resolve through the
// GADGET's `[restore]()` instead of re-loading the code-mode worker. That only happens when a
// gadget backs the chat (executeCodeRestoreTarget(), overseer.ts:1719); otherwise the worker is
// loaded directly and `ctx.restore()` throws immediately.
//
// IMPORTANT, per the plan: the stub `ctx.restore()` returns is a PlaceholderRpcTarget by design
// (overseer.ts:73-105) -- invoking it throws "Tried to invoke a placeholder stub for a persistent
// hook callback". This is intentional (there's a TODO explaining why), not a bug. Do NOT call the
// returned stub; only assert that `ctx.restore()` itself resolves (Case A) or throws (Case B).
//
// EACH CASE GETS ITS OWN STACK AND STUB, unlike agent-execute-code.test.js's single-chat file.
//
// The reason is the stub, not the product. startStubInference() is deliberately *sticky*: once its
// queue drains to one entry it serves that entry forever, so a terminating `stop` answers every
// later request in a test (see stub-inference.mjs -- it exists to avoid the agent loop's 30-turn
// spin when a queue runs dry mid-turn). That is correct for one chat per stub and wrong for two:
// the first chat leaves its `stop` stuck at queue[0], so the second chat's newly queued tool call
// sits *behind* it and never gets served. The second chat therefore stops immediately with no tool
// call and no follow-up request.
//
// Verified by execution, with trivial `console.log` code and no ctx.restore() involved: three
// sequential chats on one stack returned 2, 1, then 2 requests, and the third chat's tool result
// was the *second* chat's output -- an off-by-one lag through a shared sticky queue, not a hang.
//
// Worth stating plainly because the symptom mimics one: this is NOT the runaway-gadget wedge
// documented in plans/handoff.md. Nothing here refuses to stop. Giving each case its own stub (and
// so its own stack, since inferenceHost is baked in at build time) sidesteps it for the cost of a
// second build.

import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";
import { connect, nextUsernames, signUp } from "@gadgets/integration-tests/rpc-client";
import { startStack } from "../src/stack.mjs";
import { startStubInference } from "../src/stub-inference.mjs";

/** @type {Awaited<ReturnType<typeof startStubInference>>} */
let stub;
/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack;

beforeEach(async () => {
  // Must start before startStack(): FIELDOS_INTERNAL_HOSTS is read by the generator at build
  // time (stack.mjs's inferenceHost doc comment), so the port has to be known first.
  stub = await startStubInference();
  stack = await startStack({ inferenceHost: `127.0.0.1:${stub.port}` });
}, 180_000);

afterEach(() => {
  stack?.stop();
  stub?.stop();
});

afterAll(() => {
  // Belt-and-suspenders in case a beforeEach throws mid-setup and skips its matching afterEach.
  stack?.stop();
  stub?.stop();
});

/**
 * Agent code for `executeCode`: calls `ctx.restore()` and logs progress at each step so a failure
 * says how far it got, rather than reading as a generic timeout.
 */
const RESTORE_CODE = `export default async function(self, env, ctx) {
  console.log(JSON.stringify({ step: "start", hasRestore: typeof ctx.restore }));
  try {
    const greeter = await ctx.restore({ type: "greeter", greeting: "Howdy" });
    console.log(JSON.stringify({ step: "got-stub", kind: typeof greeter }));
  } catch (err) {
    console.log(JSON.stringify({ step: "threw", err: String(err) }));
  }
}`;

/**
 * Sign up a fresh user, register the stub model, and open a workspace (`newGadget()` -- despite
 * the name, this creates a WORKSPACE, not a gadget; see `createGadgetWithRestorer` below for that).
 * @returns {Promise<any>} the overseer stub.
 */
async function setupWorkspace() {
  const [username] = nextUsernames("ctxrestore");
  const api = connect(stack.url);
  const authed = await signUp(api, username);

  const profile = /** @type {const} */ ({ type: "agent", id: "stub-model", name: "Stub Model" });
  await authed.addModel(profile, {
    provider: "ollama", model: "stub-model", apiToken: "", apiUrl: stub.url,
  });

  return authed.newGadget();
}

/**
 * Create the actual GADGET inside a workspace and give it a `[restore]()` method, per the
 * SYSTEM_PROMPT example (agent.ts:505-517). Uses a V2 Yjs update, as gadget-sandbox.test.js does.
 * @param {any} overseer
 */
async function createGadgetWithRestorer(overseer) {
  const gadget = await overseer.createGadget("Greeter", undefined, "GREETER");
  const gadgetId = await gadget.getId();

  const doc = new Y.Doc();
  doc.transact(() => {
    const text = new Y.Text();
    text.insert(0, `
      import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

      class Greeter extends RpcTarget {
        constructor(greeting) {
          super();
          this.greeting = greeting;
        }
        greet(name) {
          return \`\${this.greeting}, \${name}!\`;
        }
      }

      export class Gadget extends DurableObject {
        async [restore](params) {
          if (params.type === "greeter") {
            return new Greeter(params.greeting);
          }
          throw new TypeError("Unknown type: " + params.type);
        }
      }
    `);
    doc.getMap(String(gadgetId)).set("server.js", text);
  });
  await overseer.updateCode(Y.encodeStateAsUpdateV2(doc));
}

/**
 * Queue the executeCode tool call plus a terminator, run the chat, and wait for the agent loop's
 * second round trip (the tool result being fed back).
 * @param {any} overseer
 * @returns {Promise<string>} the tool result text (tail worker console output).
 */
async function runRestoreChat(overseer) {
  stub.queueToolCall("executeCode", { code: RESTORE_CODE });
  stub.queueMessage("done");

  await overseer.newChat("run the code", "stub-model");

  // Wait for the agent loop to finish (second request lands once executeCode's tool result comes
  // back). Same waitFor-style poll as agent-execute-code.test.js.
  const deadline = Date.now() + 30_000;
  while (stub.requests.length < 2 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  expect(stub.requests.length).toBe(2);

  const secondRequest = /** @type {{messages: {role: string, content: string}[]}} */ (
      stub.requests[1]);
  const toolMessage = secondRequest.messages.find(m => m.role === "tool");
  expect(toolMessage).toBeDefined();
  return toolMessage?.content ?? "";
}

test("Case A: ctx.restore() resolves when a gadget backs the chat", async () => {
  const overseer = await setupWorkspace();
  await createGadgetWithRestorer(overseer);

  const content = await runRestoreChat(overseer);

  expect(content).toContain("got-stub");
  expect(content).not.toContain("threw");
}, 120_000);

test("Case B: ctx.restore() throws when no gadget backs the chat", async () => {
  // No createGadget/updateCode here -- newGadget() only creates a workspace, so
  // executeCodeRestoreTarget() returns undefined and the self-token is never set up.
  const overseer = await setupWorkspace();

  const content = await runRestoreChat(overseer);

  expect(content).toContain("threw");
  expect(content).toContain("cannot be used in this context");
}, 120_000);
