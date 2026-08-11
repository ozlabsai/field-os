# Tier 2 — the gadget sandbox

OZL-242 tier 2, first case. Written 2026-08-11, against `main` at c394236 (tier 1 shipped in #24).

Read [`../docs/testing.md`](../docs/testing.md) for the tier definitions and the cherry-pick gate.
This file answers a question that document leaves implicit: **what is the sandbox, exactly?** Then
it plans the test that covers it.

Everything below marked *verified* was executed or read in source. Everything marked *unverified*
is a hypothesis — per this repo's verification posture, plan claims are hypotheses until executed.

---

## 1. What "the sandbox" actually is

There is no single sandbox. Gadget code runs inside **four independent containment layers**, and
they fail independently. Naming them separately is the point of this section — "the sandbox works"
is not a testable claim, and tier 1 only covers one of the four.

The subject is a **dynamic worker** (a workerd Worker Loader isolate), created at
`overseer.ts:2314` `loadGadgetWorker()` via `this.env.LOADER.get(...)`. Not a container, not a VM,
not a `vm` context — a full workerd isolate with its own module registry, loaded at runtime from
source held in a Yjs document.

### Layer A — network isolation

`globalOutbound: null` (`overseer.ts:2356`). The isolate has **no route to the network at all**:
not a blocked route, an absent one. Gadget code calling `fetch()` fails at the runtime level,
below anything JS can monkey-patch.

*Verified:* tier 1 `sandbox-egress.test.js` proves this in a hand-written fixture, with a red-check
(`?permissive=1` omits the field to prove the assertion can fail).

### Layer B — capability isolation (the interesting one)

The isolate's `env` is **constructed, not inherited**. `getEnvForLoader()` (`overseer.ts:2087`)
builds a fresh object containing only:

- `env.GADGET` — a loopback stub to the gadget itself
- one entry per *visible* binding edge, from `visibleBindings(gadget, forChatId)`

The parent worker's real `env` — `LOADER`, `BLUEPRINTS`, `AVATARS`, `BLUEPRINT_CONTENT`, and every
`GATEKEEPER_*` service binding — is **never passed down**. A gadget cannot reach a gatekeeper
service directly; it can only reach a loopback the overseer minted for it.

This is the layer that matters most and the layer **tier 1 structurally cannot test**: the tier-1
fixture supplies its own `env`, so it has no parent env worth leaking. Only booting the real
backend can catch a regression here.

### Layer C — the loopback mediation boundary

Every call a gadget makes to the outside world goes through `GatekeeperLoopback`
(`overseer.ts:6918`), a `WorkerEntrypoint` whose constructor immediately calls
`stub.startGatekeeperSession(this.ctx.props.target, this.ctx.props.caller)` and returns a Proxy
over the resulting session.

The security property: **`target` and `caller` come from `ctx.props`**, baked in when the overseer
minted the binding (`makeBindingLoopback`, `overseer.ts:2072`). Gadget code passes no arguments and
cannot forge either. `startGatekeeperSession` (`overseer.ts:2628`) then dispatches on
`target.type`, and `caller` is what drives attribution — `{from: "gadget", chatId, gadgetId}` for
the gadget path, which decides whether an action is recorded against a chat (`#associateAction`,
`overseer.ts:2669`).

So the capability *is* the authority. This mirrors the project-wide rule from `CLAUDE.md`: a
resource is ambient only by configuration, and a component never asserts its own identity.

### Layer D — observability (tails)

`tails: [this.ctx.exports.GadgetTailLoopback({props: tailProps})]` (`overseer.ts:2359`).
`GadgetTailLoopback` (`:7061`) receives the isolate's console output and exceptions and forwards
them to `deliverGadgetLogs`. Also props-scoped, so a gadget's logs are attributed to its own
workspace and chat and cannot be aimed elsewhere.

### A real asymmetry between the two loader paths

| | gadget path (`:2346`) | agent `executeCode` path (`:5446`) |
|---|---|---|
| `globalOutbound: null` | yes | yes |
| `allow_irrevocable_stub_storage` | yes | yes |
| `disallow_importable_env` | **no** | **yes** |
| mainModule | `server.js` (from Yjs) | `harness.js` (const) + `agent.js` |
| env source | `getEnvForLoader` | `getEnvForAgent` |
| reachable without a model | **yes** | no |

The agent path's comment (`:5449`) says `disallow_importable_env` "also disallows importable
ctx.exports, to prevent the code from calling itself in a loop." The gadget path omits it.

*Unverified:* whether that omission is deliberate (a gadget legitimately needs importable `env`,
and its facet identity makes self-calls meaningful) or an oversight. **Do not "fix" this as part of
tier 2.** The test should assert the flags each path actually passes, so the asymmetry is pinned
and a future change to either is visible. If it turns out to be a real gap it is its own ticket.

### What is NOT a containment layer

**Availability.** Per `handoff.md`, a runaway gadget wedges the whole process; the watchdog
restarts it. That is recovery, not containment, and OZL-239 says so. Nothing in tier 2 should be
written in a way that implies otherwise.

---

## 1b. Does the sandbox need an open-source replacement? No.

Worth stating explicitly, because "Cloudflare sandbox" sounds like a managed service and it is not.
Cloudflare's platform is two separable things, and only one of them needs substituting:

- **workerd** — the runtime. Apache-2.0, `github.com/cloudflare/workerd`, pinned here at
  `1.20260801.1` and vendored through pnpm. *Verified from its own package metadata.* The isolate,
  the Worker Loader, `globalOutbound`, DO SQLite storage and the tail mechanism are all **in the
  binary we already run**. No account, no network, no substitute needed. Every containment layer in
  §1 is workerd's, so **the sandbox is already fully open-source and airgap-clean.**
- **The managed services behind bindings** — KV, R2, Browser Rendering. These are *not* in workerd;
  it ships the client half of each binding and no server. Each one needs a local implementation.

That second list is small. Across all nine deployable workers there are only four
managed-binding types (*verified* via the repo's own `readWranglerConfig`, not a regex):

| Binding | Declared by | Airgap status |
|---|---|---|
| `worker_loaders` | workshop-backend | **native workerd** — needs only `--experimental`. This is the sandbox. |
| `kv_namespaces` | workshop-backend, gatekeeper-context | replaced by `fieldos-runtime/src/kv.js` |
| `r2_buckets` | workshop-backend | replaced by `fieldos-runtime/src/r2.js` |
| `browser` | workshop-backend | replaceable, **deliberately deferred** — OZL-236 |

Everything else — the other six gatekeepers and the router — uses only Durable Objects and service
bindings, both native to workerd.

`fieldos-runtime` (OZL-234) is that substitution layer, plus `assets.js` for static serving. Its
KV/R2 servers speak **undocumented workerd-internal protocols** recovered by execution
(`plans/workerd-probe/README.md`), which is why `handoff.md` pins them to workerd
**1.20260801.1 exactly** and calls the `fieldos-runtime` suite the version canary.

`browser` is the one capability gap today: PDF export. Both call sites guard
(`overseer.ts:9146`, `:9394` — "Gadget export is not configured for this deployment") and throw a
clear message rather than crashing. *Verified by reading both.*

It is **not** unreplaceable, and this plan should not imply it is. Per **OZL-236**, `BROWSER` is a
`wrapped @14 :WrappedBinding` over `cloudflare-internal:br-api`, a module compiled *into the
workerd binary* whose sole inner binding is a fetcher — so the binding is a **client**, and a
replacement means supplying the server (`GET /v1/devtools/browser` plus a WebSocket upgrade,
protocol living client-side in `@cloudflare/puppeteer`). Cost at the call sites: **zero changes**.
OZL-236 defers it deliberately — Chrome is a heavyweight non-JS runtime that must not share
workerd's process, so it is a separate container image plus a small proxy, to be built "when a
customer requirement names PDF export." That deferral is a recorded decision, not an omission;
do not re-litigate it here.

**Consequence for this plan:** tier 2 introduces no new substitution work. It tests the sandbox
workerd already gives us. The only thing tier 2 might *add* is the capnp interceptor service (§8),
and that is a test fixture, not a platform replacement.

---

## 2. What tier 1 already covers (do not re-buy)

| Property | Covered | Where |
|---|---|---|
| Loader shape (`--experimental`, object-map `modules`, `mainModule`) | yes | `sandbox-egress.test.js` |
| `globalOutbound: null` blocks egress, with red-check | yes | same |
| Loader identity/caching (same key → same isolate) | yes | `loader-identity.test.js` |
| DO durability across `SIGKILL` | yes | `do-durability.test.js` |
| `wrangler.jsonc` compat flags boot | yes | `compat-flags.test.js` |
| Network allow-list semantics | yes | `network-allowlist.test.js` |

**Gap in the compat-flags coverage:** it covers *config-level* flags from `wrangler.jsonc`. The
gadget worker's flags (`allow_irrevocable_stub_storage`, and the agent path's
`disallow_importable_env`) are passed at **runtime** inside the `WorkerLoaderWorkerCode` object —
a different mechanism, currently unasserted anywhere.

---

## 3. What tier 2 must cover

Only what needs the real backend. Layers B and C, plus the dynamic construction that feeds A.

1. **Layer B — env is constructed, not inherited.** The loaded gadget's `env` contains no
   `LOADER`, no `BLUEPRINTS`, no `AVATARS`, no `BLUEPRINT_CONTENT`, no `GATEKEEPER_*`. This is the
   headline assertion and the one tier 1 cannot express.
2. **Layer A through the real path.** Egress refused from a gadget loaded by the actual
   `loadGadgetWorker`, not a fixture.
3. **The module map is really built from the Yjs doc.** Code written over RPC is the code that
   runs — proving `overseer.ts:2334`'s `.js` filter and `mainModule: "server.js"` end to end.
4. **Runtime compat flags.** Assert `allow_irrevocable_stub_storage` is present on the gadget
   worker (observable from inside: `ctx.restore` exists), pinning the asymmetry in §1.
5. **Layer C attribution** — *stretch, only if cheap.* A gadget-initiated gatekeeper call arrives
   with `caller.from === "gadget"`. Needs a bound gatekeeper, so it may belong in a follow-up.

---

## 4. The path to make gadget code execute

Five RPC calls, **no AI model involved**. *Verified by reading source.*

1. `AuthenticatedApi.newGadget()` → Overseer stub
2. `Overseer.createGadget(title, chatId?, bindingName?)` — `overseer.ts:7327`
3. `GadgetClient.getId()` → the workpiece id
4. `Overseer.updateCode(update)` — `overseer.ts:7469`
5. `GadgetClient.connectToGadget()` — `overseer.ts:9135`, then **call a method on the result**

### Three details that decide whether this works

- **`bindingName` must be passed.** Omitting it calls the quick model (`overseer.ts:7349`).
  Passing it takes the `else if` at `:7353` and never reaches a model. *Verified* by reading
  `:7340-7356`. Without this the "model-free" claim collapses.
- **The Yjs root name is the decimal workpiece id**, not `""`. `gadgetRootName` (`:1521`) returns
  `""` only for `defaultGadgetId`, which a client-created workspace does not have — hence step 3.
- **`connectToGadget` returns a Proxy** (`:2429`); the loader fires on the first *method call*, not
  on connect. A test that only connects proves nothing.

### Yjs update construction

`updateCode` requires **V2 encoding**. A V1 update is not rejected at parse time — it misparses and
surfaces later as "Invalid typed array length" (`overseer.ts:2022-2028`).

Build: fresh `Y.Doc` → `doc.getMap(String(gadgetId)).set("server.js", new Y.Text(...))` inside a
`transact` → `Y.encodeStateAsUpdateV2(doc)`.

**OZL-241 is already fixed** (commit `f9228c8`, guard at `overseer.ts:2031-2038`) — `handoff.md`
:88-90 still lists it as open and is **stale**. This matters here: a malformed update now fails
with a named error at the RPC boundary instead of bricking the workspace, so iterating on update
construction is safe.

### Minimal gadget

```js
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  probe() { /* returns what the assertions need */ }
}
```

Class name must be exactly `Gadget`, matching `getDurableObjectClass("Gadget")`
(`overseer.ts:2411`). No `client.js` needed — that is only read by `getUiBundle` (`:9127`), which
this path never touches.

**Cache ordering gotcha:** the loader caches on `${ctx.id}.${codeVersion}.${gadgetId}` (`:2322`)
and the facet caches by name. `updateCode` **before** the first `connectToGadget`; a later
`updateCode` bumps the version but the already-running facet is only reset on chat switches
(`:2394-2402`), not on mainline code changes.

---

## 5. Harness

**Step 1 — `--only <pkg,...>` in `run-workerd.mjs`.**
`INCLUDED_GATEKEEPERS` (`:29`) is the single source for both the bundle filter (`:139`) and the
backend/router service-binding loops (`:358`, `:364`), so narrowing it stays self-consistent — no
dangling service references. Backend + router always included.

*Verified by execution:* a 3-worker subset (backend + router + gatekeeper-context) generated a
clean config, and it **booted**: `GET / → 200` on the pinned workerd.

**Step 2 — tier-2 harness in `packages/workerd-tests`.**
Reuse `startWorkerd` from `src/harness.mjs`. Shell `--only --build-only`, then boot that config.
Client is `packages/integration-tests/src/rpc-client.ts` imported **verbatim** — `connect(baseUrl)`
has zero wrangler coupling (`docs/testing.md:95` says keep it; it is right).

*Measured:* the 3-worker `--build-only` is **11.8s**, not the ~5s `docs/testing.md:27` implies. The
gap is `workshop-backend`'s custom build (`capnweb-validate`); a per-worker measurement misses it.
Bundle once per test file, not per test.

---

## 6. Red-checks

Per this repo's traps, a test that does not exercise its subject is indistinguishable from a pass —
and a gadget that never started reports "no egress" exactly like a sandboxed one does.

Every assertion in §3 gets deliberately broken once and observed going red before the suite is
trusted:

- Assertion 1 (env) — inject a fake `LOADER` key into the loader env; must fail.
- Assertion 2 (egress) — omit `globalOutbound: null`; must fail.
- Assertion 3 (module map) — write different code than asserted; must fail.
- **Liveness, always on:** every case asserts a value only *running* gadget code could return, so
  "the gadget never started" can never read as green.

---

## 7. Scope

**In:** `--only`; the tier-2 harness; the sandbox case (§3 items 1-4); red-checks; fixing the
committed sqlite artifacts (`fixture-do-durability/dodata/*.sqlite*` is tracked in git and dirties
the tree on every run); doc corrections (§8).

**Out, deliberately:**

- **`ctx.restore()`** — lives on the agent path (`overseer.ts:5482`), needs a model.
- **The agent `executeCode` path** — reachable only via `agent.ts:2715`, needs a stub inference
  server.
- **The capnp interceptor service** (`docs/testing.md:80`) — see §8; real work, own change.
- **The `disallow_importable_env` asymmetry** — pin it, do not change it (§1).

The last three all need a stub inference server or new capnp plumbing, so they are one follow-up
rather than three.

---

## 8. Doc corrections this work should make

- **`docs/testing.md:48`** — item 5 (`--build-only` translatability) is described as "currently
  absent". It is **already gated**: `scripts/workerd-outbound.test.js:26,103` runs it, four times,
  inside `pnpm test`.
- **`docs/testing.md:86`** — "this is a one-line generator change" is **wrong**.
  `network-interceptor.ts` works only because miniflare routes outbound fetch back through Node
  (`network-interceptor.ts:3-6`). On real workerd that mechanism does not exist; the replacement
  needs a new capnp interceptor service *and* a generator flag pointing `globalOutbound` at it.
- **`plans/handoff.md:88-90`** — OZL-241 is fixed (commit `f9228c8`); remove it from the open list.
- **`docs/testing.md:27`** — the cost model implies ~5s for a 3-worker stack; measured 11.8s.
- Add `pnpm gate` (the doc describes it at `:36-41`; no such script exists in `package.json`).

---

## 9. Open questions

1. **Is `disallow_importable_env`'s absence on the gadget path deliberate?** Still not documented
   locally — but the security worry behind the question is **largely answered**: `ctx.exports`
   inside a loaded worker is `["default"]`, i.e. *its own* exports, **not** the parent's. So the
   omission does **not** expose the overseer's loopback classes. What it does allow is
   `import { env } from "cloudflare:workers"` resolving (to the same host-supplied keys). Pin the
   behaviour; no separate security ticket appears warranted on this evidence.
2. ~~**How is the loaded gadget's `env` observed from the test?**~~ **Answered:
   `Object.keys(env)` from inside the loaded worker.** *Verified by execution* with a throwaway
   probe against the pinned binary, mirroring `loadGadgetWorker`'s exact shape. With the host's own
   env deliberately carrying `PARENT_SECRET`, `GATEKEEPER_FAKE` (a service binding) and `LOADER`,
   the loaded worker saw **only** the host-supplied `{GADGET, MY_BINDING}` — none of the three
   leaked. So **Layer B holds in fact, not just by intent**, and the tier-2 assertion has a
   mechanism.

   Two mechanics worth not rediscovering: `ctx.restore` is present (confirming
   `allow_irrevocable_stub_storage` takes effect), and `stub.getDurableObjectClass("Gadget")`
   returns a **class**, not a namespace — it has no `.idFromName()`. Production feeds it to
   `ctx.facets.get` (`overseer.ts:2409-2415`), which a bare capnp fixture cannot drive; use
   `getEntrypoint()` for env questions and leave the facet route to tier 2, which has the real
   backend.
3. ~~**Does the 3-worker subset need `gatekeeper-context` at all?**~~ **Answered: no.**
   *Verified by execution* (commit c7a1760): `--only workshop-backend,router` generates a config
   with zero gatekeeper services and zero `GATEKEEPER_*` bindings, and it **boots** — `GET / → 200`
   and `/api → 400`, the latter being the WebSocket endpoint correctly refusing a non-upgrade
   request, which proves the route reaches the backend. The tier-2 sandbox stack is **two
   workers**, not three.
