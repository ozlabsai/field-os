# Testing strategy

The suite has one job above all others: **make cherry-picking upstream changes safe.** Upstream
tests against Cloudflare's platform; we ship standalone workerd. That gap is the top platform risk
in [`plans/fieldos.md`](../plans/fieldos.md), and a test suite that runs on the wrong runtime does
not close it.

## Four tiers

| Tier | What | Runtime | Cost | Runs |
|---|---|---|---|---|
| 0 | Unit and in-isolate | vitest, some under miniflare | already in `pnpm test` | pre-commit, PR |
| 1 | **workerd-contract** — hand-written capnp fixtures | **real pinned workerd** | ~0.7s today | PR + **cherry-pick gate** |
| 2 | **workerd-stack** — 2–3 workers via `wrangler --dry-run` | **real pinned workerd** | ~6–10s | merge + **cherry-pick gate** |
| 3 | **workerd-full** — all 9 workers via `run-workerd.mjs` | **real pinned workerd** | ~24s | nightly, pre-release |

Only tiers 1 and 2 are new. Tier 1 already exists in miniature as
`packages/fieldos-runtime/__tests__/workerd.test.js` — spawn the pinned binary against a fixture
capnp, drive real bindings, `SIGKILL` and re-read. That pattern generalizes.

**Tier 0 is not a parity signal.** `workshop-backend` runs under `@cloudflare/vitest-pool-workers`,
which is miniflare — *Cloudflare's* runtime. It is good coverage of logic and proves nothing about
the runtime we ship. Do not let a green Tier 0 stand in for parity.

### Measured costs, not estimates

Bundling is **linear in worker count**, which is what makes Tier 2 affordable: `workshop-backend`
2.7s, `router` 0.9s, one gatekeeper ~1.5s — against 24s for all nine. There is **no incremental
caching** (a warm rerun measured the same 24s), so Tier 3 cannot be cheapened and belongs nightly.
"Full stack or nothing" was a false dichotomy.

Per-worker bundle costs don't add up to the whole-command cost, though: a 3-worker subset via
`run-workerd.mjs --only ... --build-only` measured **11.8s** end to end, not ~5s — `workshop-backend`
has a custom build step (capnweb-validate) that a per-worker bundle measurement doesn't capture. A
2-worker subset (backend + router) is also a valid stack on its own — verified booting, `GET /` ->
200.

## The cherry-pick gate

The highest-value output. A human runs:

```sh
git cherry-pick -x <upstream-sha>
pnpm gate
```

`pnpm gate` is `pnpm lint && pnpm test`, and that pair must cover all of:

1. `pnpm lint` — exit 0, zero errors (warnings are tolerated; check the exit code, a piped `tail`
   hides it)
2. tier 0 — the unit and in-isolate suites
3. **tier 1** — the parity gate proper
4. **tier 2** — the end-to-end leg on a subset stack
5. **`run-workerd.mjs --build-only`** — the capnp translatability check

Items 2–5 are all reached by the single `pnpm test`: the root script is
`node --test scripts/*.test.js && pnpm run --recursive --if-present test`, so it picks up the
`scripts/` suites (item 5, below) and every package's own `test` script, `packages/workerd-tests`
(tiers 1 and 2) among them. They are listed separately because they fail for different reasons,
not because they are separate commands.

Item 5 is the cheapest high-yield item, and it is already gated: `scripts/workerd-outbound.test.js`
shells out to `run-workerd.mjs --build-only` (its lines 24-31 and 101-107), and that test runs
inside `pnpm test` via the root `test` script (`node --test scripts/*.test.js`). It matters because
an upstream commit that adds a binding type the translator does not know breaks the airgapped
deployment **while every other test stays green** — `run-workerd.mjs` throws on unknown module
types and silently drops `browser`. It costs ~24s, and it is a build rather than a boot, so it is
the one Tier-3-priced item worth paying per cherry-pick.

**Item 6 is not automatable.** Does the diff touch `LOADER`, `ctx.restore`, `ctx.facets`,
`ctx.exports`, `compatibility_flags`, `kv_namespaces`/`r2_buckets`, or
`global_fetch_strictly_public`? If so it needs a new Tier-1 case *before* it merges, not after.

Record the gate output in the commit message, per [`git-workflow.md`](./git-workflow.md).

## What belongs in Tier 1

In priority order. The first is the largest untested surface in the fork and turns out to cost
about 2.5 seconds.

1. **The gadget sandbox.** `workerLoader` binding; `globalOutbound: null` blocks egress; `modules`
   is an object map; `--experimental` is required. Verified reproducible in a 20-line fixture.
2. **Loader identity and caching** — same key returns the same isolate, a changed key a fresh one.
   That is the semantic `overseer.ts`'s `codeVersion` keying depends on.
3. **`ctx.restore()` self-token semantics** — the self-labelled "Wacky hack", still unproven.
4. **Facet lifecycle** — `get`/`abort` and persistence across abort.
5. **DO durability under `SIGKILL`** — exists in `fieldos-runtime`; generalize it.
6. **KV/R2 binding protocol** — exists; it is also the workerd-version canary.
7. **Compatibility flags** — assert the pinned binary accepts each one. `run-workerd.mjs` already
   strips `enable_ctx_exports` because it is fatal, so this class of breakage is real.
8. **The `network` allow-list** — `["public"]` blocks private, `[]` blocks loopback,
   `deny = ["public"]` is fatal. Encodes verified findings so a bump cannot silently change them.

## The airgap assertion

**Built.** `run-workerd.mjs --interceptor` points every worker's `globalOutbound` at
`fieldos-runtime/src/interceptor.js`, which records each request and answers 403; a second socket
serves the record back at `/__fieldos_intercepted`, reached from a test via
`startStack({interceptor: true})` and `readIntercepted()`. Covered by
`packages/workerd-tests/__tests__/airgap-interceptor.test.js`.

This replaces `integration-tests`' `globalThis.fetch` patch and is **strictly stronger**: it lives
below the isolate, so gadget code cannot monkey-patch out of it. `globalOutbound` is a
`ServiceDesignator`, so it can name a *worker* service and not only a `network` one — that is the
whole mechanism.

Two things worth knowing, both verified by execution:

* **A dynamically-loaded worker inherits its parent's `globalOutbound`** unless it sets its own. So
  gadget code routes to the interceptor too. Production sets `globalOutbound: null` on gadget
  workers (`overseer.ts:2356`), which still wins — the two are complementary. The value of the
  interceptor underneath is that if that `null` were ever dropped, gadget traffic would land in the
  record instead of on the wire.
* **Every worker must be covered, including the generated ones.** The assets worker hardcoded its
  own `globalOutbound` and escaped the first version of this; `scripts/workerd-only.test.js` now
  asserts the set of emitted values is exactly `["test-interceptor"]`.

It was not the one-line change this document once claimed.
`packages/integration-tests/src/network-interceptor.ts` only works because miniflare routes a
Worker's outbound `fetch()` back through the Node process (see that file's own header comment,
lines 1-6), so patching `globalThis.fetch` is enough there. Real standalone workerd has no such
mechanism — there is no Node process in the loop to patch. It took both a new capnp interceptor
service and a `run-workerd.mjs` flag to point `globalOutbound` at it.

Tier 2 needs it, or a CI runner's real egress lets an escape pass silently.

## `packages/integration-tests` — convert, don't retire

- **Retire `harness.ts`.** It boots wrangler → miniflare, so it tests a runtime we do not ship, with
  miniflare's own KV/R2 rather than ours. It also deletes `worker_loaders` outright, which is why
  the gadget path has never been covered.
- **Keep `rpc-client.ts` verbatim.** `connect(baseUrl: URL)` has zero wrangler coupling; it becomes
  Tier 2's client for free.
- **Keep `network-interceptor.ts`** as a Tier-0 unit spec — its concept moves to capnp, but the file
  is exported for consumer repos and runs in milliseconds.
- **Leave `observer-reverification.test.ts` on miniflare.** It tests overseer *logic*, which is
  runtime-independent. 382 lines of migration would buy no parity signal.

Note [`integration-testing.md`](./integration-testing.md) is stale where it describes a wrangler
`~4.104.0` pin and a root workerd override — neither matches this fork.

## What not to build

A small suite that actually gates beats an aspirational pyramid.

- **No coverage chase on deleted SaaS connectors.** The ten connectors removed under OZL-218
  (including `gatekeeper-confluence`, which had 7 test files) are gone; don't backfill coverage for
  packages that no longer exist.
- **No Tier-2 case per gatekeeper.** One proves the binding-scan mechanism; the rest is the same
  code path.
- **No automated re-derivation of the workerd wire protocol.** `plans/workerd-probe/echo.js` takes
  two minutes by hand and produces output a human must read. Automating it builds a tool nobody
  runs. Pin the version instead, keep the canary, and make a workerd bump a deliberate PR.
- **No CI test of the watchdog.** It was verified three ways by hand; in CI it would be a
  timing-dependent flake generator, and its thresholds are explicitly calibration knobs.
- **No test of resource limits.** There are none — it is a documented ceiling, and a test would
  assert a known-absent feature.

## CI

One new job, `workerd parity`, running tiers 1 and 2 plus the translatability check. No extra setup
step: `@cloudflare/workerd-linux-64` is already in the lockfile as an optional dependency, so
`ubuntu-latest` works as-is.

Tier 3 goes in a separate nightly workflow. It needs Ollama and MCP fixtures that would make it
flaky on PRs.

## Open risks

- **The `ctx.restore()` case may not be reproducible in isolation** — the hack depends on
  `#codeIdMap` state inside `OverseerDurableObject`. If a minimal fixture cannot reproduce the
  self-token redirect, it moves to Tier 2 at ~5s more. Determine this first.
- **A Tier-2 restart test must delete the DO disk but keep `.workerd/keys.json`.** Regenerating a
  `uniqueKey` orphans the data, and the restart assertion then passes vacuously — proving nothing
  while looking green.
