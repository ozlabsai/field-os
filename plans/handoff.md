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

**~~OZL-291~~ — done (PR #72, `5d68cb0`).** Org separation Phase 3b. `ENABLE_ORG_SEPARATION` can
now be enabled without every public Context collection vanishing. The decision it was blocked on:
**the admin names the target org at creation** (option A).

Not a dropdown — there is nothing to enumerate. An org is whatever an IdP group claim yields after
prefix-stripping, and the design deliberately builds no user directory, so the field is free text
prefilled with the admin's own org, with orgs already in use offered as datalist suggestions. It is
*required* when separation is on, because an untagged public collection is visible to nobody.

Three things worth not re-deriving:

1. **The tag's durable home is `ContextCollectionMetadata`, not the summary.** `#propagate()`
   rebuilds the summary from metadata on every edit via `metadataToSummary`, so a summary-only tag
   would be erased by the next rename — failing closed silently, long after the edit that caused
   it. The test pins the copy: removing it fails the new cases while all five OZL-217 predicate
   tests still pass.
2. **Two discovery surfaces the ticket did not name were also leaking.** `getAgentCatalog` and
   `getSlashCommandProvider` are separate entrypoints from `startSession` and received no
   `SessionContext` at all, so the agent would have seen cross-org collection *titles* and skill
   command names every turn while being unable to read them. Both now take one.
3. **The org reaches the UI via `AppUiContext`**, filled in inside `startAccountAppUi` — which
   already runs in the user's own DO, so it is a storage read rather than a round-trip. Unlike the
   ambient session, that one is the *caller's* org, not the owner's.

**~~OZL-226~~ — verified on a real airgapped stack.** Session bounds (PR #73), the org read-out
(PR #74), and the verification itself, all done. The last of it ran on standalone workerd with
**`--allow none`** — egress fully blocked, not approximated:

| | |
|---|---|
| SPA + hashed assets | 200, served locally |
| API | `/api` → 101, a real Cap'n Web session |
| admin-only gating | a user in `ADMINS` gets the capability; another gets `null` |
| session bounds | tightening applies; **720h clamped to the 8h env ceiling**; the stored value is kept; clearing inherits |
| Gatekeepers three-state | disabled / enabled / optional all resolve with no internet route |
| Monaco (OZL-293) | the 3.6 MB chunk is served **by the deployment**, closing that ticket's open caveat |
| egress | **zero** `restrictPeers` / DNS-failure lines across the whole run |

**The blocker was tooling, not testing, which is why this sat unverified so long.**
`run-workerd.mjs` read exactly one env var (`FIELDOS_INTERNAL_HOSTS`), so `ADMINS` was always unset
locally — every user was a non-admin and the admin panel could not be exercised *at all*. It now
forwards a named list of backend instance vars from the process environment:

```sh
ADMINS='["alice"]' SESSION_MAX_LIFETIME_HOURS=8 node scripts/run-workerd.mjs --allow none
```

That also makes `ENABLE_ORG_SEPARATION` settable locally, so OZL-291's flag can finally be exercised
on a real stack rather than reasoned about.

**A correction to OZL-226's own text, verified — do not re-derive.** It says the UI must "reject or
clamp anything above" the session ceiling. **Rejecting server-side would have been wrong.**
`admin-config.ts:295-297` deliberately sanitizes-then-clamps-on-read precisely so lowering the env
ceiling tightens existing deployments immediately, rather than failing against a stale stored value.
Implementing the ticket literally would have broken a documented property. The resolution: the panel
blocks above-ceiling entry as UX, the server accepts and clamps, and neither rejects.

Consequence for any future admin panel over clamped config: **the stored value and the effective
value are different numbers.** `AdminSettingsView.sessionBounds` carries three per bound (ceiling,
stored, effective) because a panel echoing back what was saved would display a number that is not in
force.

**Two `AuthenticatedApi` methods still have no UI**, found while building the read-out and worth
knowing: `revokeSessionsForUser` and `restampUnknownOrgs` were as unreachable as `getOrgForUser`.
PR #74 surfaces all three. They live on `AuthenticatedApi` rather than `AdminApi` because
`AdminApiImpl` is documented as fully user-independent, so a panel for them calls a different
capability than every other panel on the page.

**Three corrections to OZL-217's own text, all verified — do not re-derive:**
- Its two named chokepoints (`#assertCanRead`, `hasCollectionAccess`) are both **secondary**. The
  agent path touches neither: `grep` for either in `library-read.ts` returns nothing, and
  `hasCollectionAccess` has exactly two callers, both in `context-observers.ts`. Implementing the
  ticket literally would scope the management UI while leaving the agent reading cross-org content
  every turn — a fix that passes casual testing and is wrong where it counts.
- **Do not bake the org into gatekeeper props.** An existing account is never re-provisioned
  (`#provisionMissingAccounts` only creates accounts for vendors lacking one, `user.ts:1424`) and
  `ensureAmbientCapsules` skips any record whose `accountId` matches (`overseer.ts:4392-4405`), so
  `getSingletonGatekeeperClass` is never re-called. Props go stale **permanently**, not until next
  sign-in. The org therefore rides `SessionContext` on `startSession`, fresh per session.
- The ambient session is the **owner's**, not the caller's (`ensureAmbientCapsules` resolves
  through `ownerDo`), so the org filtered on is the owner's. That is deliberate: the capability
  being exercised is theirs.

**Untagged fails closed**, departing from the ticket's "untagged means all-orgs" — that rule would
collapse the same distinction Phase 2 paid to keep (`orgUnknown`), permanently, for the resource
most likely to carry a sensitive name.

**Nothing reacts to a user changing org.** `loginOrCreateViaGatekeeper` (`user.ts:498`) overwrites
`orgId` unconditionally without comparing. Phase 2 is unaffected (it reads live) and Phase 3's
`SessionContext` is unaffected (fresh per session), but any future org-dependent capability that
caches would inherit this. Unticketed.


**~~OZL-256~~ — done.** `pnpm test` was flaky under concurrency in two ways (a build failure
naming `.wrangler/validate/src/server.ts`, and workerd failing to boot). One cause, confirmed by
observation rather than inference: `capnweb-validate build --out .wrangler/validate` empties the
tree before repopulating it (sampled at 150ms: `files=0` for ~0.9s, then 26, then 36), while
wrangler's `main` points *into* that same fixed path. Concurrent builds of one package read it
torn. Fixed with a per-package lock (`scripts/build-lock.mjs`) held across build-and-read, rather
than by serializing the callers — the contended resource is one directory, so excluding on it fixes
every caller including ones not yet written, and keeps the concurrency. Verified: 6/6 clean-state
`pnpm gate` runs green, ~155s (no regression). The guard test fails 4/4 with the lock removed.

**~~`8b08672`~~ — ported (PR #35).** The WebSocket abort on overseer DO death. Upstream's "closed
the wrong end" diagnosis was verified against our pinned capnweb 0.8.0 and holds here: our
`abortSession` was a no-op at all three call sites, and workspace-DO death (`server.ts:307`) has no
other failure path. Carries a RED-checked test. `docs/upstream-ports.md` has the detail.

**Still to port: `2508099`** (dev-server ports, low risk, dev-ergonomics only).

**Note the gate found a bug in its own fix.** Running `pnpm gate` on merged `main` — a combination
neither PR's CI covered — surfaced an `ENOTEMPTY` crash in the new build lock: `rmSync(recursive,
force)` walks a tree then `rmdir`s it, so an acquisition renaming staging onto that path mid-walk
makes the `rmdir` throw (`force` only swallows `ENOENT`; reproduced standalone at 107/400). Fixed
in PR #36 by making removal atomic the same way acquisition is. Worth repeating the lesson: the
mutual-exclusion test stayed green throughout, because "two builders never overlap" and "releasing
does not crash" are different properties. **Run the gate on the merge commit, not just on the
branch.**

**Cheapest first: OZL-224, 226, 227.** Three verification issues — doc/sheet/deck, admin dashboard,
sharing — each verification rather than construction. Note OZL-226 has one real gap inside it:
session bounds have no admin UI.

**OZL-219 is mostly already built — read the 2026-08-12 log entry before touching it.** Three of
its five required controls exist (the per-worker/per-role CIDR allowlist, the `MCP_ALLOW_INSECURE`
split, and redirect-hop revalidation *with* its test). Four things in the ticket should NOT be
done, each verified: do not create `gatekeeper-shared` (real duplication is ~95-115 lines, not
1,500-2,500, and `backend-utils` already is the shared package); do not disable
`global_fetch_strictly_public` (near-inert off-platform); do not migrate to `ExternalServer`
bindings; and do not describe `isBlockedHost` as a security control.

**Correction to the advice this file previously gave.** It said workerd's schema "recommends
`ExternalServer` bindings per host instead", implying a tightening. Verified by execution: an
`ExternalServer` binding is a separate, *unfiltered* egress path that bypasses the
`restrictPeers()` check governing bare `fetch()` — a capability, not a finer-grained filter. An
address derived from user input would fully defeat the allow-list. The probe is rerunnable; see
the log entry.

**What is actually left there is now OZL-292** (none of it widens network reach). Re-verified on
2026-08-16, with two corrections to what this file previously said: `constantTimeEqual` is forked
**four** ways, not three (github, homeassistant, oidc, mcp-shared) — and the two without a fallback
both run under workerd in production, so that item is a *testability* gap, not a runtime
vulnerability. `gatekeeper-oidc` genuinely has no host guard, but what it fetches is derived from
operator config and `requireUrl` already enforces https + same-origin, so it is absent defence in
depth rather than a live SSRF. The `webFetch` redirect path has **zero** tests, which is the part
worth fixing regardless of severity.

**OZL-222 — partly answered by building rather than asking.** Rather than wait for per-customer
answers, the connector was made correct against the three most common providers as they actually
ship (2026-08-16). Two real bugs, both of which failed *silently to "no org"* — indistinguishable
from a user who legitimately has none:

- **Keycloak's group mapper defaults `full.path` to true** (verified against the mapper source), so
  nested groups arrive as `/eng/fieldos-legal`. Stripping only the leading slash failed the prefix
  test, so every user in a nested group resolved to no org under Keycloak's *default* config.
  Now matched on the last path segment.
- **Entra's group overage** is now detected and logged (`oidc.org.claim.overage`) rather than
  passing silently. Deliberately not thrown: `resolveOrg` runs inside `verifyIdToken`, so throwing
  would refuse the login and turn a misconfiguration into an outage.

Two constraints are configuration, not code, and are documented: **Okta gates the groups claim on
the `groups` scope** (`OIDC_SCOPES=groups`), and **Entra emits group GUIDs by default** — no prefix
can match, and the name formats exist only on AD-synced groups, so a cloud-only tenant must use App
Roles.

What remains of OZL-222 is *verification against a live IdP*. Tier 2 drives a stub, so nothing here
proves a real Keycloak signs someone in — the same gap OZL-225 closed for inference.

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
- **A stale `workerd serve` serves the OLD config, and it looks exactly like a product bug.**
  Verifying admin gating, `getAdminApi()` returned null for a username definitely in `ADMINS`. The
  cause was a previous instance still holding port 8080, serving a config generated *before*
  `ADMINS` was passed — so the test exercised a binary that could not possibly pass. It cost a
  whole tier-1 probe chasing `DurableObjectId.name` before process identity was checked. This is
  the orphaned-workerd trap below wearing a different mask: **run `pgrep -f "workerd serve" | wc -l`
  BEFORE interpreting any local-stack result**, not after it fails. More than one means whatever
  you just measured is untrustworthy.
- **A guard is not covered by the run that made it pass.** Extending the airgap check to the
  gatekeeper *configurator* bundles, it reported all ten clean — and was structurally incapable of
  seeing anything in them. Those UIs are inlined into a `data:` URL, so `https://` is stored as
  `https%3A%2F%2F` and the regex matched nothing. The first fix silently failed too: decoding the
  whole file throws (stray `%`), and the fallback scanned raw text, so it still passed. Only a
  planted host proved it. **Whenever you add a check, plant the thing it is meant to catch and
  watch it go red — in every input format it will meet**, not just the one you developed against.
  A check that cannot fail reads as coverage, which is worse than no check.
- **An airgap check that greps `src/` is not an airgap check.** The gadget code editor loads Monaco
  from **jsDelivr** and cannot work on an airgapped network (OZL-293, Urgent). The URL never appears
  in our source — it arrives inside `@monaco-editor/loader`'s default config and is only visible
  after bundling, so every source-level audit before this one missed it. Scan `dist/`, not `src/`:
  `grep -ohE "https?://[a-zA-Z0-9._-]+" dist/assets/*.js | sort -u`. Verified the chunk actually
  ships (referenced from the main bundle), that the loader injects a `<script>` tag, and that no
  local Monaco chunk exists — a string in a bundle is not by itself a defect, so check all three.
  Cleared while there: `example.com` is admin placeholder text, `react.dev`/`fb.me`/`w3.org` are
  error-message and namespace strings, and the built CSS has no `@font-face` or external `url()`.
- **A `pnpm gate` failure under load is usually a timeout, and it does not look like one.** Seen
  twice on 2026-08-16 at load average ~34: `backend-utils` "failed" after **978 seconds with
  `tests 0ms`** (it never ran a test — it hung), and three unrelated `workshop-frontend` files
  failed at ~6.6s each, vitest's default timeout, in a run reporting `tests 1.40s` against
  `import 341s`. All passed in isolation in seconds. Distinguish it from a real break by the
  *shape*: `tests 0ms` with a huge duration means starvation, not assertion failure. Check
  `uptime` before believing a gate failure, re-run the named package alone, and confirm the failing
  files have any connection to what you changed — here none of them referenced `AdminPage`, and no
  test covers `AdminPage` at all. Note this is **not** the orphaned-`workerd` trap below: only one
  was running.
- **A background task's "exit code 0" notification is the wrapper's, not your command's.** A
  `pnpm gate` that exited 1 was reported as `completed (exit code 0)`. Grep the output file for
  your own `GATE_EXIT=` marker rather than trusting the notification — the same "read the log, not
  the exit code" rule as the DoS repro.
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
- A runaway gadget interrupts the deployment until the watchdog restarts it (OZL-239). The
  post-Alpha fix (gadget execution in a separate OS process) is **cheaper than OZL-239 estimates** —
  see the 2026-08-12 log entry. Verified by execution: each facet already has its own sqlite file,
  and a second workerd process can open it as an ordinary DO, so "migration path for existing gadget
  state" is a file copy, not a data conversion. `ctx.restore()` is *not* process-local for facets
  either (only `executeCode`'s `#codeIdMap` hack is). What remains is single-writer discipline
  across processes (the localDisk backend does **not** lock), minting a durable identity for a
  gadget that has none, the facet-stub Proxy becoming real RPC, and abort semantics — including the
  **gatekeeper** facets the ticket omits.
- On-prem MCP servers cannot be connected without disabling an orthogonal control (OZL-240).
- Blueprints are fetchable unauthenticated by id, bypassing org separation (OZL-223).
- Admin revocation targets a *named* user; there is no user directory.
- Gadget PDF export is unavailable — no `BROWSER` binding off-platform. It degrades cleanly.
- `webFetch` document conversion is unavailable; it falls back to plain text and is near-moot on an
  isolated network anyway.
