# Tier 2 — `ctx.restore()` self-token semantics

Final case of OZL-255. Written 2026-08-11, against `guy/ozl-255-stub-inference` (PR #27).

Depends on the stub inference server from that PR: `ctx.restore()` lives on the agent
`executeCode` path, which is reachable only through the model's tool loop.

**Everything below was verified by execution with a throwaway test before this was written.** The
headline finding changes what the case can assert, and would have cost the implementer real time
to discover.

---

## 1. The hack, precisely

`overseer.ts:5474-5489`, the self-labelled "Wacky hack":

```
codeId = randomUUID()
#codeIdMap.set(codeId, workerDef)
entrypoint = await ctx.restore({ type: "gadget", gadgetId, codeId })
finally: #codeIdMap.delete(codeId)
```

The trick is that **the same params resolve two different ways depending on time**
(`restore()`, `:6303-6319`):

| when | `#codeIdMap` has `codeId` | resolves to |
|---|---|---|
| during the load | yes | `LOADER.load(code).getEntrypoint()` — the code-mode worker |
| ever after | no (the `finally` deleted it) | `getGadgetFacetFetcher(...)` — the gadget |

So the code-mode worker is imbued with a self-token whose params, replayed later, point at the
*gadget* instead. `ctx.restore()` inside agent code therefore yields stubs that restore through the
gadget's `[restore]()` method.

This is why the case cannot be tier 1: `#codeIdMap` is private state inside
`OverseerDurableObject`. `docs/testing.md` listed "may not be reproducible in isolation" as an open
risk — **it is not reproducible in isolation**, confirmed.

---

## 2. The finding that shapes the test

**`ctx.restore()` inside `executeCode` is write-only by design. The returned stub cannot be
called.**

Verified: agent code that does `await ctx.restore({type:"greeter", greeting:"Howdy"})` gets a stub
back fine, but *invoking* it throws:

> Tried to invoke a placeholder stub for a persistent hook callback. This stub is only intended to
> be stored; once loaded back from storage it will work properly.

That is `CODE_MODE_HARNESS`'s own `[restore]()` returning a `PlaceholderRpcTarget`
(`overseer.ts:73-105`), with a TODO explaining it: the runtime cannot yet invoke the gadget's real
`[restore]()` inline, so a placeholder stands in until the stub has been passed to `bindHook`,
stored, and read back.

**Consequence:** the obvious assertion — "call the restored stub and check it reached the gadget"
— is **untestable as designed**, not a bug. Do not write it, and do not "fix" the placeholder.

What remains testable is one layer down, and is still a real regression signal: **that
`ctx.restore()` resolves at all inside the code-mode worker**, which only works because of the
self-token redirect. If `#codeIdMap` handling broke, or the worker were loaded directly when it
should not be, this fails.

---

## 3. The two cases, both verified

The product supplies its own red-check here, which is unusually convenient — the two paths are
cleanly distinguishable by observable error text.

**Case A — a gadget exists → `ctx.restore()` succeeds.**
`executeCodeRestoreTarget()` (`:1719`) returns a gadget id, so the hack path runs. Agent code sees
`typeof ctx.restore === "function"` and the call resolves to a stub. Verified output:

```
{"step":"start","hasRestore":"function"}
{"step":"got-stub","kind":"function"}
```

**Case B — no gadget → `ctx.restore()` throws immediately.**
`executeCodeRestoreTarget()` returns `undefined`, so `:5472` loads the worker directly and the
self-token never exists. Verified error:

> ctx.restore() cannot be used in this context because the system does not know how to restore
> this context itself...

Case B is what makes Case A meaningful: it proves the success in A comes from the gadget-backed
redirect and not from `ctx.restore()` being trivially available everywhere.

---

## 4. What to build

One test file, `packages/workerd-tests/__tests__/ctx-restore.test.js`, following
`agent-execute-code.test.js` exactly — same stub wiring, same `startStack({inferenceHost})`, same
"start the stub before building the stack" ordering.

* **Case A** needs a gadget created *and* given source with a `[restore]()` method, per the
  SYSTEM_PROMPT's own example (`agent.ts:505-517`) — create it with `createGadget(title, undefined,
  BINDING_NAME)` and `updateCode` a V2 Yjs update, as `gadget-sandbox.test.js` does.
* **Case B** creates **no** gadget at all. Note `newGadget()` makes a *workspace*, not a gadget —
  the distinction matters here and the naming invites the mistake.
* Assert on the **tool result text**, which is the tail worker's captured console output, *not* the
  module's return value (`CODE_MODE_HARNESS.run()` at `:59` discards it). Same as
  `agent-execute-code.test.js`.
* Agent code should log its progress in steps (`start` / `got-stub` / `threw`) so a failure says
  how far it got rather than just "timed out".

**Red-check:** Case B already is one, but confirm the pair actually discriminates — make Case A run
without creating a gadget and watch it turn into Case B's error. If both cases pass with the same
setup, the test proves nothing.

---

## 5. Traps

* **A gadget with no `[restore]()` method still lets `ctx.restore()` succeed** — the placeholder is
  returned regardless, because the harness never calls through. So Case A's assertion must not
  imply the gadget's own restorer ran; it did not.
* **"Timed out waiting for logs from code execution"** is what a hung or never-logging agent
  function looks like in the tool result. It is not a restore-specific error — that message cost a
  debugging cycle during this research. Log early.
* Everything from `plans/tier2-stub-inference.md` §2 still applies: `arguments` as a JSON string,
  unique tool-call `id`, sticky terminator.

---

## 6. Out of scope

The `PlaceholderRpcTarget` TODO (`overseer.ts:74`). Making the stub invokable inline needs runtime
features that do not exist; it is upstream work, not test work. Pin current behaviour.
