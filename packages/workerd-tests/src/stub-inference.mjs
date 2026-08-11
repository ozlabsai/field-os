// A scripted stand-in for an OpenAI-completions-compatible inference server, so tier-2 tests can
// drive the agent's tool-dispatch loop (agent.ts) deterministically instead of depending on a real
// model. See plans/tier2-stub-inference.md for the full contract; the summary that matters here:
//
// NOT INFERENCE COVERAGE. This stub accepts whatever the backend sends and answers from a fixed
// script -- it cannot catch a protocol bug (wrong field name, wrong shape) the way a real strict
// server would. This project already paid for that gap once: an internal endpoint fell through to
// OpenAI's strict defaults and 400'd on real vLLM, invisible against Ollama because Ollama
// tolerates fields a stricter server rejects (plans/handoff.md). A green run here proves
// `executeCode` is reachable and its dispatch plumbing works, not that inference itself works.
//
// The wire shape below is not invented -- it's copied from a verified run against the real
// backend (plans/tier2-stub-inference.md §2). In particular:
//   * `pi` hardcodes `stream: true` and throws "Stream ended without finish_reason" if a response
//     omits it, so every reply is SSE and every terminal chunk carries a `finish_reason`.
//   * a tool call's `function.arguments` must be a JSON *string*, not an object. An object still
//     produces two requests and LOOKS green (pi accepts it and reports a validation failure back
//     as the tool result), so request-count assertions alone are not proof `executeCode` ran --
//     assert on the tool result text.
//   * `finish_reason: "length"` fails every tool call in the message unexecuted; never send it here.

import { createServer } from "node:http";

/**
 * One assistant turn to answer with. Exactly one of `toolCall` or `text` should be set.
 * @typedef {object} StubTurn
 * @property {{name: string, args: unknown, id?: string}} [toolCall] - Emit a tool-call turn. Args
 *   are JSON-stringified for the wire, so pass a plain value here. `id` defaults to an
 *   auto-incrementing `call_<n>`, unique per turn -- the Workshop keys `toolCallId` on it across
 *   several maps (agent.ts:2870-2900), so two calls sharing an id would collide.
 * @property {string} [text] - Emit a final `stop` turn with this content.
 */

/**
 * Start the stub inference server.
 *
 * Start this BEFORE building the stack: `FIELDOS_INTERNAL_HOSTS` is read by the config generator
 * at build time (scripts/run-workerd.mjs), so the port must be known before `startStack()` runs
 * (see stack.mjs's `inferenceHost` option).
 *
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   requests: unknown[],
 *   queueToolCall: (name: string, args: unknown, id?: string) => void,
 *   queueMessage: (text: string) => void,
 *   stop: () => void,
 * }>}
 *   `url`/`port` address the server. `requests` accumulates every parsed
 *   `/v1/chat/completions` request body, in order, so a test can assert what the backend SENT
 *   (which tools it offered, what the tool result text was) and not only what came back.
 *   `queueToolCall`/`queueMessage` append one scripted turn each. The LAST queued entry is
 *   served forever once reached (sticky): pi's agent loop is `while (hasMoreToolCalls)` up to 30
 *   turns (agent-loop.js, agent.ts:3045), so a queue that ran dry mid-turn would otherwise spin
 *   for up to 30 slow round trips before failing instead of failing on the very next request.
 *   `stop()` closes the server.
 */
export async function startStubInference() {
  /** @type {StubTurn[]} */
  const queue = [];
  /** @type {unknown[]} */
  const requests = [];
  let autoId = 0;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));

      // Fail loudly rather than silently answering: an unscripted extra call is exactly the kind
      // of regression this stub exists to catch (a queue that ran dry mid-test is a test bug, not
      // something to paper over). Mirrors ObserverConfigRecorder.configure()'s empty-queue throw
      // (integration-tests/src/rpc-client.ts:137) -- the established precedent for this shape.
      if (queue.length === 0) {
        res.writeHead(500).end();
        throw new Error(
            `stub inference queue exhausted after ${requests.length} request(s); ` +
            "queue a response with queueToolCall()/queueMessage() for every expected turn");
      }
      // Sticky: once only one scripted turn remains, keep serving it instead of draining the
      // queue, so a final `stop` answers every subsequent request in the same test.
      const turn = queue.length > 1 ? /** @type {StubTurn} */ (queue.shift()) : queue[0];

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of chunksFor(turn, autoId)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (turn.toolCall && !turn.toolCall.id) autoId++;
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    queueToolCall(name, args, id) {
      queue.push({ toolCall: { name, args, id } });
    },
    queueMessage(text) {
      queue.push({ text });
    },
    stop() {
      server.close();
    },
  };
}

/**
 * Build the SSE data chunks (without the `data: ` prefix/framing) for one scripted turn.
 * @param {StubTurn} turn
 * @param {number} autoId
 * @returns {object[]}
 */
function chunksFor(turn, autoId) {
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };

  if (turn.toolCall) {
    const id = turn.toolCall.id ?? `call_${autoId}`;
    return [
      { ...base, choices: [{ index: 0, delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function",
                       function: { name: turn.toolCall.name, arguments: "" } }],
      }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: JSON.stringify(turn.toolCall.args) } }],
      }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
  }

  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text ?? "" },
                            finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}
