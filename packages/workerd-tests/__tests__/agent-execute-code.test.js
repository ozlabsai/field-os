// Tier-2: the agent's executeCode sandbox, exercised through the real workshop-backend with a
// scripted stub inference server standing in for the model.
//
// gadget-sandbox.test.js already pins the *gadget* loader path (overseer.ts's getEnvForLoader,
// loadGadgetWorker). This is the OTHER path into the same WorkerLoader binding:
// executeCodeMode (overseer.ts:5423), reachable only from inside the model's tool-dispatch loop
// (agent.ts:2715) -- there is no direct RPC to it. A stub inference server is what makes that
// path reachable and deterministic in a suite CI can run; see stub-inference.mjs's header and
// plans/tier2-stub-inference.md for why this is NOT inference coverage.
//
// What differs from the gadget path, per the plan: `env` comes from getEnvForAgent (:2101), not
// getEnvForLoader; `mainModule` is the fixed harness.js (CODE_MODE_HARNESS, :53), not something
// sourced from a gadget's Yjs document; and the worker definition sets
// `disallow_importable_env` (:5451), which the gadget path does not set (:2349) -- an asymmetry
// worth pinning in its own right.
//
// RED-CHECKED (see the task report for the actual run): flipping the tool call's `arguments` from
// a JSON string to a plain object still produces two requests -- pi accepts it and reports the
// resulting tool-validation failure back as the tool result text -- so a request-count-only
// assertion would stay green while executeCode never ran. That is exactly why the assertion below
// is on the tool result TEXT (which only running code can produce), not just on `requests.length`.

import { afterAll, beforeAll, expect, test } from "vitest";
import { connect, nextUsernames, signUp } from "@gadgets/integration-tests/rpc-client";
import { startStack } from "../src/stack.mjs";
import { startStubInference } from "../src/stub-inference.mjs";

/** @type {Awaited<ReturnType<typeof startStubInference>>} */
let stub;
/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack;

beforeAll(async () => {
  // Must start before startStack(): FIELDOS_INTERNAL_HOSTS is read by the generator at build
  // time (stack.mjs's inferenceHost doc comment), so the port has to be known first.
  stub = await startStubInference();
  stack = await startStack({ inferenceHost: `127.0.0.1:${stub.port}` });
}, 180_000);

afterAll(() => {
  stack?.stop();
  stub?.stop();
});

/** The backend's own bindings -- must not appear in the agent's executeCode env either. */
const PARENT_BINDINGS = ["LOADER", "BLUEPRINTS", "AVATARS", "BLUEPRINT_CONTENT"];

test("executeCode really runs code inside the sandbox, with the agent's own env", async () => {
  const [username] = nextUsernames("execcode");
  const api = connect(stack.url);
  const authed = await signUp(api, username);

  // AiChatAuthorInfo.type is "user" | "agent" | "gadget" -- NOT "ai" (api.ts:1793); the RPC
  // validator rejects an invalid literal here, which is how the original prototype caught it.
  const profile = /** @type {const} */ ({ type: "agent", id: "stub-model", name: "Stub Model" });
  // provider "ollama" is the generic OpenAI-compatible provider (ai-models.ts). apiUrl is the
  // server base -- ai-models.ts appends /v1 and strips a trailing /api or /v1 first.
  await authed.addModel(profile, {
    provider: "ollama", model: "stub-model", apiToken: "", apiUrl: stub.url,
  });

  // newChat lives on Overseer (a workspace), not AuthenticatedApi -- newGadget() opens one.
  const overseer = await authed.newGadget();

  // Code that only running it could produce this value from: a computed value plus a marker
  // string, both invisible to anything that only inspects the request without executing it.
  //
  // The tool result text comes from the tail worker's captured console output (CodeModeTailLoopback,
  // overseer.ts:5933/7140), NOT the module's return value -- CODE_MODE_HARNESS's run() (:59) never
  // reads what `agent()` returns. So the marker must be logged, not merely returned.
  const marker = `ran-${Date.now()}`;
  const code = `export default async function(self, env, ctx) {
    console.log(JSON.stringify(
        { marker: ${JSON.stringify(marker)}, sum: 20 + 22, envKeys: Object.keys(env).sort() }));
  }`;
  stub.queueToolCall("executeCode", { code });
  stub.queueMessage("done");

  await overseer.newChat("run the code", "stub-model");

  // Wait for the agent loop to finish (second request lands once executeCode's tool result comes
  // back and the model is asked to continue). waitFor-style poll: no push notification exists on
  // this path, and the loop is at most a few fast local round trips.
  const deadline = Date.now() + 30_000;
  while (stub.requests.length < 2 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }

  expect(stub.requests.length).toBe(2);

  // The tool call really dispatched and its result fed back: the SECOND request must carry a
  // role:"tool" message (agent.ts converts the executed tool's output into exactly this).
  const secondRequest = /** @type {{messages: {role: string, content: string}[]}} */ (
      stub.requests[1]);
  const toolMessage = secondRequest.messages.find(m => m.role === "tool");
  expect(toolMessage).toBeDefined();
  const content = toolMessage?.content ?? "";

  // The headline assertion: the tool result text embeds the executed code's own returned value.
  // Only RUNNING code produces `sum: 42` and the marker together -- a stub that "looks" green
  // without executing (per the red-check below) cannot produce this text.
  expect(content).toContain(marker);
  expect(content).toContain("42");

  // getEnvForAgent (overseer.ts:2101), not getEnvForLoader: for a chat with no bindings wired in,
  // env is empty -- none of the parent worker's own bindings leak in either.
  expect(content).toContain('"envKeys":[]');
  for (const binding of PARENT_BINDINGS) {
    expect(content).not.toContain(binding);
  }
}, 120_000);
