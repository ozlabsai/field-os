# Tier 2 — the stub inference server (OZL-255)

Scope for OZL-255, written 2026-08-11 against `main` at e2f13ea (tier-2 gadget sandbox merged).

Companion to [`tier2-gadget-sandbox.md`](./tier2-gadget-sandbox.md), which covers the *gadget*
loader path. This covers the *agent* one.

**The whole contract below was proven by execution before this was written** — a throwaway stub
drove a real chat turn end to end against the real backend on standalone workerd, and
`executeCode` really ran code inside the sandbox. What remains is productionizing it, not
discovering it.

---

## 1. Why this is needed at all

`executeCodeMode` (`overseer.ts:5423`) is reachable **only** from `agent.ts:2715`, inside the
model's tool-dispatch loop. There is no RPC path to it. So the second loader path — and
`ctx.restore()`, which lives on it — cannot be tested without a model in the loop.

A real model makes the suite slow, non-deterministic, and dependent on a server CI has no reason to
run. A stub makes it a scripted fixture.

---

## 2. The contract, verified

### It streams. This is the design fork.

`pi` hardcodes `stream: true` (`@earendil-works/pi-ai/dist/api/openai-completions.js:518`), and
`ai-models.ts:9` imports `stream as openaiCompletionsStream`. The stub **must emit SSE**, not a
single JSON body.

`"Stream ended without finish_reason"` **throws** (same file, `:437`). A stub omitting that field
fails in a way that reads like a product bug.

### Tool-call deltas accumulate `arguments` as a JSON *string*

`openai-completions.js:378-397`: each `delta.tool_calls[]` entry contributes
`function.arguments` which is **concatenated** (`block.partialArgs + ...`) and incrementally
parsed. So the stub may split arguments across chunks, or send them in one — both work.

### The wire shape that worked

Three chunks for the tool-call turn, then `[DONE]`:

```
data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"stub",
       "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[
         {"index":0,"id":"call_1","type":"function",
          "function":{"name":"executeCode","arguments":""}}]},"finish_reason":null}]}

data: {... "choices":[{"index":0,"delta":{"tool_calls":[
         {"index":0,"function":{"arguments":"{\"code\":\"...\"}"}}]},"finish_reason":null}]}

data: {... "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

And for the terminating turn: a `delta.content` chunk, then `finish_reason: "stop"`, then
`[DONE]`.

### Two round trips per turn

Observed: the backend calls `/v1/chat/completions` **twice**. First with `system, user`; then,
after dispatching the tool, with `system, user, assistant, tool`. The `tool` message carries the
sandbox's real output:

```json
{"role":"tool","content":"Failed to start Worker:\nUncaught SyntaxError: Illegal return
 statement\n  at agent.js:1","tool_call_id":"call_1"}
```

That error is itself the proof the sandbox executed — `return 42;` is illegal at module top level,
so workerd rejected it *inside the loaded worker*. Real gadget code for a test should be a proper
module (the code becomes `agent.js` under the fixed `harness.js` main module, `overseer.ts:5456`).

`/v1/models` was never requested. Usage/token fields were never required. Nor is `data: [DONE]`,
nor a correct `Content-Type` — but send both anyway; they cost nothing and match what a real server
does.

### Traps, each verified against pi's own code

These fail in ways that look like product bugs rather than stub bugs, which is what makes them
worth listing.

* **`arguments` must be a JSON *string*, not an object.** An object yields `arguments: []` and
  `Validation failed for tool "executeCode"` — and the turn still makes **two requests and looks
  green**. Any assertion based only on request count passes while `executeCode` never ran. Assert
  on the tool *result text*, not the call count.
* **`finish_reason` is mandatory**; omitting it throws `Stream ended without finish_reason`.
* **`finish_reason: "length"` is poison** — it fails every tool call in the message *unexecuted*.
* **Always send a unique tool-call `id`.** pi tolerates its absence (replaying `tool_call_id: ""`),
  but the Workshop keys `toolCallId` on it across `toolCallNotes`, `codePreviewManager` and
  `executeCodeStreamManager` (`agent.ts:2870-2900`), so two calls would collide.
* **The loop runs `while (hasMoreToolCalls)`** (`agent-loop.js:88`) up to `turnCount >= 30`
  (`agent.ts:3045`). A script that keeps returning tool calls spins. Make the terminating
  `finish_reason: "stop"` entry *sticky*.
* **Two env preconditions**, both easy to miss: `CF_AI_GATEWAY` must be **unset** (otherwise
  `getModel` takes the gateway branch and *ignores `apiUrl`*, `ai-models.ts:379-382`), and the user
  must have no connected Cloudflare account (`options.userGateway` short-circuits first, `:371`).
  Neither holds in the tier-2 stack today, but a future fixture could break both silently.
* **Leave `setQuickModel` unset**, so chat-title generation never fires and the stub sees only
  agent turns.

---

## 3. Wiring, verified

**Network: no `--allow local` needed.** `FIELDOS_INTERNAL_HOSTS=inference=127.0.0.1:<port>` makes
the generator emit `net-workshop-backend allow = ["public", "127.0.0.1/32"]` — the loopback
address is added explicitly by role, so the default `--allow public` suffices.

**Declaring an internal host does NOT open the gadget sandbox.** Verified in the same run: a gadget
fetching that exact URL still failed with *"not permitted to access the internet via global
functions like fetch()"*, and the stub recorded **0 hits** from it (1 from the host, so the stub
was live). `globalOutbound: null` is independent of `--allow`. Worth a regression case in its own
right.

**Test-side, all over RPC** — no env or admin seeding:

1. `AuthenticatedApi.addModel(profile, config)` (`api.ts:331`).
   `profile` is `AiChatAuthorInfo` (`api.ts:1787`): `{type: "agent", id, name}` — `type` is
   `"user" | "agent" | "gadget"`, **not** `"ai"` (the RPC validator rejects that, which is how the
   prototype caught it).
   `config` is `AiModelConfig` (`api.ts:968`): `{provider: "ollama", model, apiToken: "", apiUrl}`.
   `apiUrl` is the server **base**; `ai-models.ts:586` appends `/v1` and strips a trailing
   `/api` or `/v1` first.
2. `Overseer.newChat(message, modelId)` (`api.ts:1543`) or `sendChatMessage` (`:1556`) — `modelId`
   is the id from `addModel`. `null` inhibits the AI response entirely.

---

## 4. What to build

**A scripted stub in `packages/workerd-tests/src/`.** A Node HTTP server, started per test file,
holding a queue of canned responses. It must:

* answer `POST /v1/chat/completions` with SSE, per §2
* **record every request body**, so tests assert on what the backend *sent* (which tools were
  offered, what the tool result was) and not only on what came back
* fail loudly when the queue empties — an unexpected extra call must not be silently answered.
  `ObserverConfigRecorder` (`rpc-client.ts:137`) is the established precedent for this shape and
  the one to copy.

**Wire it into `startStack()`** via `FIELDOS_INTERNAL_HOSTS`. Note that env var is read by the
generator at build time, so the stub's port must be known before `startStack()` — start the server
first, then build.

**Two cases, each red-checked:**

1. **The agent `executeCode` sandbox.** The second loader path. Assert what differs from the gadget
   path: `env` comes from `getEnvForAgent` (`:2101`) not `getEnvForLoader`, `mainModule` is the
   fixed `harness.js` not Yjs-sourced, and it sets **`disallow_importable_env`** which the gadget
   path does not (`:5451` vs `:2349`). PR #25 pinned the gadget side; this pins the other.
2. **`ctx.restore()` self-token semantics.** The self-labelled "Wacky hack"
   (`overseer.ts:5474-5489`): the code-mode worker is loaded *through* `ctx.restore()` so it is
   imbued with a self-token whose params redirect to the gadget once `codeId` leaves `#codeIdMap`.
   Needs a gadget to exist (`executeCodeRestoreTarget()`, `:5468`) or the worker loads directly and
   `ctx.restore()` fails immediately — so the test must create one first.

Every case asserts a value only *running* code could produce, per the standing rule.

---

## 5. Explicitly NOT inference coverage

A stub accepts whatever the backend sends, so it **cannot** catch protocol bugs. This project has
already paid for that once: an internal endpoint fell through to OpenAI's strict defaults and
400'd on real vLLM, invisible against Ollama because Ollama tolerates every field a stricter
server rejects (`plans/handoff.md`).

The stub's job is to make `executeCode` **reachable and deterministic**. A green tier-2 run is not
evidence that inference works. That stays OZL-225 work against real vLLM/TGI.

Say this in the stub's header comment, not just here.

---

## 6. Out of scope

The **capnp interceptor service** (the third remaining OZL-242 item). Separable, no model involved,
and lower value until tier 2 carries more than its current four cases.

---

## 7. Housekeeping

`packages/workshop-backend/pitest-*.mjs` — scratch probes left untracked during this research.
Delete them; they are not part of the deliverable.
