# Handoff — state of the airgap port

Written 2026-08-10. What is done, what is true, and what to pick up next.

The living design is [`fieldos.md`](./fieldos.md); the append-only record is
[`fieldos-log.md`](./fieldos-log.md). This file is the orientation layer: read it first, then those.

Two process docs matter as much as the design:
[`docs/testing.md`](../docs/testing.md) (the tiers, and the cherry-pick gate) and
[`docs/upstream-sync.md`](../docs/upstream-sync.md) (how we take upstream changes, and why "watch
for security advisories" is not implementable — upstream publishes none).

## Where things stand

**FieldOS runs end to end on standalone workerd with no Cloudflare account.** That was the gate
everything else was untestable behind, and it is met. Each leg was verified by execution, not
inference:

| | |
|---|---|
| SPA serves | `GET /` → 200, hashed assets immutable |
| API | `/api` → 101, a real Cap'n Web session |
| password login | account creation, login, wrong-hash rejection |
| chat | a local Ollama model answered |
| **tool calling** | `executeCode` ran and returned `42` |
| gadget → on-prem MCP | read as observation, write queued for approval |
| **restart** | `kill -9`, then everything was still there |

`node scripts/run-workerd.mjs` does the whole thing: bundles nine workers, writes the capnp config,
spawns and supervises workerd.

## The five things most worth knowing

**1. The MCP trust boundary holds off-platform.** The security-relevant unknown. A gadget's write
*provably* did not reach the MCP server before approval — the server's own request log showed one
call, and a second only after `approveAction()`. `readOnlyHint: true` ran as an observation.

**2. Isolation is intact; availability is not.** A runaway gadget cannot reach anything it should
not — `globalOutbound: null`, tails and facet persistence all hold. It can only refuse to stop, and
that wedges the whole process. There is a watchdog; there is not containment. Do not let anyone
describe the watchdog as isolation (OZL-239).

**3. Two plan claims were wrong, and both are corrected in `fieldos.md`.** "R2 → MinIO, R2's API is
S3-compatible" conflated R2's *S3 endpoint* with the R2 *binding*; MinIO cannot serve the binding.
"Local inference is zero code changes" conflated the *endpoint* with the *request body*; an
internal endpoint fell through to OpenAI's strict defaults and 400'd on real vLLM. Both were
plausible, and both cost real time — treat plan claims as hypotheses until executed.

**4. The protocols we depend on are unversioned workerd internals.** `fieldos-runtime`'s KV/R2
implementations are valid for workerd **1.20260801.1 exactly**. `plans/workerd-probe/echo.js`
re-derives the wire protocol in about two minutes. Re-run it after any workerd bump; the
`fieldos-runtime` suite is the canary.

**5. Testing against Ollama proves less than it looks.** Ollama tolerates every field a stricter
server rejects, so the inference bug was invisible against it. The servers customers actually run
(vLLM, TGI) are the discriminating cases.

## What is done

| | |
|---|---|
| OZL-210 | Rebrand, dead code, GitLab CI removed |
| OZL-211 | Usage quotas decoupled from billing |
| OZL-212 | Session expiry and revocation |
| OZL-213 | `gatekeeper-oidc` |
| OZL-214 | Org separation Phase 1 (observable, not enforcing) |
| OZL-215 | **Phase 1 — standalone workerd end to end** |
| OZL-234 | `fieldos-runtime` — KV, R2, asset services |
| OZL-235 | Password-auth frontend variant |
| OZL-239 | *(Alpha stage)* workerd watchdog |
| OZL-242 | **The workerd parity suite and `pnpm gate`** — tiers 1 and 2 on the pinned runtime |
| OZL-255 | Stub inference server; the agent `executeCode` and `ctx.restore()` cases |
| OZL-225 | Inference verified against a real strict OpenAI-compatible server (tool calls included) |
| OZL-243 | **Upstream sync established** — the weekly watcher, and `b2a51b5` ported through the gate |
| OZL-256 | **The gate made deterministic** — a per-package build lock; 6/6 green |
| OZL-254 | Answered: dynamic workers, DOs and facets are workerd-native; only `browser` needs a substitute |

## What to pick up next

**~~OZL-256~~ — done.** `pnpm test` was flaky under concurrency in two ways (a build failure
naming `.wrangler/validate/src/server.ts`, and workerd failing to boot). One cause, confirmed by
observation rather than inference: `capnweb-validate build --out .wrangler/validate` empties the
tree before repopulating it (sampled at 150ms: `files=0` for ~0.9s, then 26, then 36), while
wrangler's `main` points *into* that same fixed path. Concurrent builds of one package read it
torn. Fixed with a per-package lock (`scripts/build-lock.mjs`) held across build-and-read, rather
than by serializing the callers — the contended resource is one directory, so excluding on it fixes
every caller including ones not yet written, and keeps the concurrency. Verified: 6/6 clean-state
`pnpm gate` runs green, ~155s (no regression). The guard test fails 4/4 with the lock removed.

**Then the two triaged upstream commits.** `docs/upstream-ports.md` lists `2508099` (dev-server
ports, low risk) and `8b08672` (WebSocket abort on overseer DO death). The second is the direct
follow-up to the commit just ported and touches the DO lifecycle, so unlike `b2a51b5` it genuinely
needs the full gate — which OZL-256 has now made trustworthy.

**Cheapest first: OZL-224, 226, 227.** Three verification issues — doc/sheet/deck, admin dashboard,
sharing — each verification rather than construction. Note OZL-226 has one real gap inside it:
session bounds have no admin UI.

**Highest leverage: OZL-219 (SSRF inversion + `gatekeeper-shared`).** It unblocks OZL-240 (on-prem
MCP servers are unreachable as shipped) and OZL-230 (MCP to databases). Two findings feed straight
into it:
- `allow = ["public", "private"]` in the capnp `network` service re-opens all of RFC1918. workerd's
  own schema recommends `ExternalServer` bindings per host instead. The internal-CIDR allowlist the
  plan wants belongs *in capnp*, not only in connector code.
- `MCP_ALLOW_INSECURE` disables the HTTPS check **and** the private-host block together. Separating
  them is the actual work (OZL-240).

**The one needing a decision, not code: OZL-222** — what IdP do customers actually run? It has been
asked repeatedly and gates verification of the OIDC work.

## Traps that have already cost time

Each of these looked like success while being wrong. That is what makes them worth listing.

- **A test that fails to exercise its subject looks exactly like a pass.** A DoS repro silently did
  not reproduce because the loader definition omitted `mainModule` — the gadget never started and
  the process looked healthy. Read the log, not the exit code.
- **Grep is not a search.** A character class without `_` hid two services; a name-based dead-code
  scan produced a false positive on `ChatMessage`. Resolve imports, and check your pattern before
  trusting a negative.
- **`agent.ts` contains code that is not code.** Two `export class Gadget` declarations live inside
  the `SYSTEM_PROMPT` template literal as examples for the model. Only `server.ts`'s `export { ... }`
  list is authoritative.
- **Running the release build breaks the next `types:check`.** It regenerates each package's
  gitignored `.wrangler/validate/`; clear with `rm -rf packages/*/.wrangler`. `pnpm gate` trips
  this on itself, so a `types:check` failure in `gatekeeper-oidc` right after a gate run is almost
  always this and not your change.
- **Local and CI resolve types differently, and a fix for one can break the other.** During the
  `b2a51b5` port, two `@ts-expect-error` directives were *unused* locally (TS2578, a hard error) and
  *required* on CI (TS2307, cannot find module) — because `@types/node` was visible only through
  pnpm hoisting, which differs between a developer's incrementally-updated store and CI's
  `--frozen-lockfile` install. Deleting them passed locally and failed CI; keeping them did the
  reverse. The fix is to declare the dependency rather than rely on either accident. Assume the two
  environments disagree.
- **`gh run rerun --failed` leaves an aggregating job stale.** It re-runs only failed jobs, so a
  `needs:`-gated summary job (our `CI` check) is never re-run: its conclusion stays empty, the check
  reads `QUEUED` forever, and the run's overall conclusion still says `success`. Re-run the whole
  workflow instead.
- **`uniqueKey` values are permanent.** They become the on-disk directory name and there is no
  migration mechanism. `run-workerd.mjs` persists them in `.workerd/keys.json` — do not regenerate.
- **`SIGTERM` is ignored by a wedged workerd.** Go straight to `SIGKILL`.
- **Tier-1 fixtures leak `workerd serve` processes under parallel load**, and nothing reaps them.
  Found 23 orphans mid-session, the oldest **26 hours** old — so they survive across runs and
  accumulate. Neither a tier-1 nor a tier-2 file leaks when run alone, so it is a race under
  concurrency, not a missing `stop()` on one path. They cost real CPU: the same `pnpm gate` that
  takes ~150s idle took **4670s** on a machine carrying that backlog. Check with
  `pgrep -f "workerd serve" | wc -l` before trusting any timing measurement, and
  `pkill -9 -f "workerd serve"` between runs. Untriaged — it makes benchmarks lie, not the suite
  fail.
- **Three inherited GitHub workflows could never pass here, and were deleted.** `cla.yml` checked
  signatures against *Cloudflare's* CLA via a `cla-signatures` branch that does not exist on this
  fork; `bonk.yml` and `bonk-pr.yml` needed `CLOUDFLARE_ACCOUNT_ID`/`GATEWAY_ID`/`API_TOKEN`
  secrets that an airgapped fork has no reason to hold. Both failed on every PR by construction.
  If an upstream sync reintroduces them, delete them again — two permanently-red checks teach
  reviewers to skim past red, which is worse than no CI because it looks like coverage.
- **An R2 miss must return 404 *and* a `cf-r2-error` header**, or `.get()` throws instead of
  resolving `null` — and the failure surfaces far from its cause.
- **A refused outbound connection tells you almost nothing.** The calling code gets a bare `Error`
  reading `internal error; reference = <token>` — no `code`, no `cause`, and never the address —
  and the matching workerd log line (`connect() blocked by restrictPeers()`) does not record the
  address either. A network-policy refusal and a DNS failure are byte-identical, so nothing can
  claim which occurred. One asymmetry does separate them: **a DNS failure logs the hostname**
  (`DNS lookup failed.; params.host = …`) while a policy block logs no address, so a
  `restrictPeers()` line with no `params.host` beside it means the name resolved and policy refused
  it. Undocumented workerd behaviour — useful for diagnosis, not something to build a control on.
  A peer refusing the connection *is* distinguishable: it arrives as `Network connection lost.`
  with a `retryable` property, meaning the address was permitted and something at the far end is
  wrong.

## How to run it

```sh
node scripts/run-workerd.mjs                  # bundle, generate config, spawn, supervise
node scripts/run-workerd.mjs --build-only     # just write .workerd/config.capnp
node scripts/run-workerd.mjs --no-watchdog    # when attaching a debugger
```

Then `http://localhost:8080`. Local inference needs the default `--allow public,private`, since
standalone workerd blocks private IPs by default.

`--allow` is the deployment-wide grant, and `public,private` is a blunt one — it opens every RFC1918
address to every worker that has any internal dependency. `FIELDOS_INTERNAL_HOSTS` narrows that by
naming the services the deployment actually depends on, so each worker reaches only its own:

```sh
FIELDOS_INTERNAL_HOSTS="inference=vllm.corp.internal:8000,mcp=10.42.8.20,oidc=idp.corp.internal" \
  node scripts/run-workerd.mjs --allow public
```

Roles are `inference`, `mcp`, `oidc` and `homeassistant`; a role may repeat for several servers.
Values may be hostnames or addresses — hostnames are resolved **at config generation**, because
workerd filters on the resolved address and never sees the name. Two consequences: a host that
changes address is unreachable until the next restart re-resolves it, and a name that fails to
resolve is a warning rather than a fatal error, since a resolver hiccup during a restart must not
make the deployment unbootable.

Ranges wider than `/24` are refused from either source; `--allow public,private` remains the way to
say "the whole internal network" deliberately. Startup prints the reach each worker ended up with,
which is worth reading — a refused connection is close to undiagnosable at runtime (see the trap
below).

The gate before any push, per `docs/git-workflow.md`:

```sh
pnpm gate     # = pnpm lint && pnpm test; exits non-zero on failure
```

`pnpm test` now carries the workerd parity suite (`packages/workerd-tests`): tier 1's hand-written
capnp fixtures and tier 2's real subset stack, both on the **pinned** binary, ~26s cold. That is
the cherry-pick gate `docs/testing.md` describes — it is built, not aspirational. Run it after
`git cherry-pick -x <sha>`.

Two things it will not catch, so do not read a green run as more than it is:

- **`pnpm build`**, which CI runs and the gate does not. `build` and `types:check` are different
  commands, so a build-only failure shows up only in CI unless you run it yourself.
- **Real inference.** Tier 2 drives a *stub* OpenAI-compatible server, which accepts whatever the
  backend sends. It proves `executeCode` is reachable, not that a strict server (vLLM, TGI) would
  accept the request — the exact gap that cost time before (OZL-225).

`.github/workflows/ci.yml` runs `pnpm lint`, `pnpm build` and `pnpm test` on every pull request —
so the parity suite runs there too, on `ubuntu-latest`, with no extra setup step
(`@cloudflare/workerd-linux-64` is already in the lockfile). Actions had never executed on this
repository until 2026-08-10: GitHub disables it by default on forks, and this is one, so every PR
before that date was gated by a developer's local run alone (OZL-253).

## Deliberate limitations, stated so they are not rediscovered

- **The gate is not idempotent: a second `pnpm gate` without `rm -rf packages/*/.wrangler` fails.**
  Deterministic, pre-existing, and *not* the OZL-256 flake — it is the `.wrangler/validate` trap
  below, firing on `types:check` in `gatekeeper-oidc`. It is always that package because its
  tracked `worker-configuration.d.ts` is the **only** one whose `mainModule` points into the
  generated tree (`"./.wrangler/validate/src/oidc"`); the other seven say `"./src/…"` or the
  `"my-main-module"` placeholder. That path is gitignored, so it resolves to `any` on a clean tree
  and is *type-checked* once a build recreates it — machine-generated sources, with errors nobody
  wrote. `exclude` in tsconfig cannot fix it (the file is reached by import, not by the `include`
  glob — tried and reverted); regenerating that one file on a clean tree probably can. Clear
  `.wrangler` between gate runs until someone does.
- A runaway gadget interrupts the deployment until the watchdog restarts it (OZL-239).
- On-prem MCP servers cannot be connected without disabling an orthogonal control (OZL-240).
- Blueprints are fetchable unauthenticated by id, bypassing org separation (OZL-223).
- Admin revocation targets a *named* user; there is no user directory.
- Gadget PDF export is unavailable — no `BROWSER` binding off-platform. It degrades cleanly.
- `webFetch` document conversion is unavailable; it falls back to plain text and is near-moot on an
  isolated network anyway.
