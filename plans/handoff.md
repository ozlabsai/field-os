# Handoff — state of the airgap port

Written 2026-08-10, last updated 2026-08-20. What is done, what is true, and what to pick up next.

The living design is [`fieldos.md`](./fieldos.md); the append-only record is
[`fieldos-log.md`](./fieldos-log.md). This file is the orientation layer: read it first, then those.

The deployment layer has its own orientation file:
[`handoff-deployment.md`](./handoff-deployment.md) — FieldOS running on GKE at os.ozlabs.ai, what is
proven about it, and the traps that only appear on a real cluster.

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
| **admin gating** | a user in `ADMINS` gets the capability, another gets `null` (2026-08-16) |
| **session bounds** | 720h clamped to the 8h env ceiling; the stored value kept; clearing inherits |
| **org boundary** | an org-tagged public collection is invisible to an org-less viewer, while their own private collection stays visible |
| **egress under `--allow none`** | zero `restrictPeers` / DNS-failure lines across a full run |
| **private-CA TLS** | a worker in the real generated config completed a handshake with a private-CA origin; removing the CA failed it (2026-08-17) |

`node scripts/run-workerd.mjs` does the whole thing: bundles nine workers, writes the capnp config,
spawns and supervises workerd. Backend instance state — `ADMINS`, `ENABLE_ORG_SEPARATION`, the
session ceilings — is forwarded from the process environment, which is what makes the bottom four
rows above testable at all:

```sh
ADMINS='["alice"]' ENABLE_ORG_SEPARATION=true SESSION_MAX_LIFETIME_HOURS=8   node scripts/run-workerd.mjs --allow none
```

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
| OZL-216 | Org separation Phase 2 — enforcement behind `ENABLE_ORG_SEPARATION` |
| OZL-217 | Org separation Phase 3 — the agent read path scoped |
| OZL-291 | **Phase 3b** — public collections tagged and the UI/write paths scoped; the flag is now usable |
| OZL-226 | **Admin dashboard verified airgapped** — session bounds and the org read-out built, then exercised on a live `--allow none` stack |
| OZL-293 | **The code editor loaded Monaco from a CDN** and could not work airgapped; fixed, with a build-time guard over bundled output |
| OZL-292 | One `constantTimeEqual`; `webFetch`'s redirect pinned; the oidc host-guard gap written down |
| OZL-295 | **Standalone workerd had no TLS context** — no worker could make *any* https request; fixed |
| OZL-296 | A provider display name rendered a mis-pasted API key verbatim; guarded at the input |
| OZL-224 | **doc / sheet / deck verified airgapped** — all three round-trip, survive `kill -9`, sheets compute |
| OZL-227 | **The sharing boundary tested** — replay-after-revocation, in CI; the dead integration suite revived |
| OZL-300 | **Private-CA TLS** — `FIELDOS_CA_BUNDLE`, verified by execution with a negative control |

## What to pick up next

**Start here.** As of 2026-08-19 the shortest reads of the current state are:

**Alpha is complete and tagged `v0.1.0-alpha.1` (`460ab56`).** All 20 Alpha issues are Done; the
release build is verified reproducible on a clean CI machine for the first time. What follows is
what is *open*, not what is missing from Alpha.

| Ticket | State |
|---|---|
| ~~OZL-311~~ | **Done** (PRs #110, #113, #114). Guided first build: seeded context, the walkthrough, and the story rewrite that came out of watching it run. Notes below — two of them are traps that will recur. |
| OZL-231 | Security audit. **Advanced, not closable** — the code work is done; five rows in `docs/security-runbook.md` need human signatures. Beta-scoped, so it does not block Alpha. |
| OZL-229 | Logging and maintenance dashboard, with OZL-308 folded in. **The production side of logging is already built** (116 structured calls across 16 files); the gap is that nothing *consumes* it — stdout with no retention, and `ERROR_REPORTER` unbound in the workerd stack so all 8 `reportIssue()` sites are no-ops. |
| OZL-302 | Model config is per-user and any signed-in user can name an inference endpoint. Not privilege escalation (per-user DO state), but on a controlled-egress network it is a data-exfiltration path. |
| OZL-228 | The post-OZL-239 sandbox work, and the largest open item. The log entry says it is *cheaper* than the ticket estimates. |
| OZL-299 | **May deserve a bump from Low.** It is the likely cause of an intermittent CI failure in `__integration__/sharing-boundary.test.ts` — the two replay-after-revocation cases pass locally 16/16 and fail on CI hardware. The test file comments on the same 30s eviction timing at line 258. If confirmed, it is a build-reliability problem, not just an eviction curiosity. |
| OZL-303/305/306/307/309/310 | Filed and triaged 2026-08-18 with `file:line` evidence. Three of them correct the premise of the original report — read the triage before starting. |

### ~~OZL-311~~ — done, in three PRs

**#110 — the seeded context.** Seed content as committed data with a generator, mirroring
`format-blueprints/` including the `SEED_CONTEXT_DIR` per-fork override, plus driver.js 1.8.0
(zero deps, MIT, clears `minimumReleaseAge`; its only embedded URL, `www.w3.org`, is already
allowlisted in the airgap check).

The installer runs **on an admin's first visit to the Context Library**, not at deploy. That is the
load-bearing decision: a public collection requires admin, `isAdmin` arrives only through
`startAppUi({ isAdmin })`, and a backend-callable path was **rejected** because it would let a
gatekeeper create domain-wide content with authority no human granted.

**#113 — the walkthrough.** `data-tour` selectors, the `walkthroughCompleted` flag (two RPC
methods, 28 kernel lines), the tour component, and conditional steps.

**#114 — the story rewrite**, which came out of watching #113 run. Both fixes there are worth
knowing before touching this again.

**Four things not to re-derive:**

1. **`data-tour` is derived from the route, not passed in.** `SidebarItem` already resolves route
   params to compute its active state, so the attribute costs one line there and every nav row
   gets one — *including* the dynamically-listed gatekeeper apps, which is what makes a Context
   Library step possible without hardcoding. It also cannot drift from the route it points at.
   Before this, the app shell had **no stable selectors at all**: `data-testid` appears only in
   test files.

2. **driver.js's defaults are wrong for a compact sidebar, and the failure looks like a
   mis-anchor.** The highlight covered ~3 rows while the popover named one. Not a bad selector —
   `stagePadding: 10` on a **32px** row yields a 52px cutout, and `duration: 400` means most of a
   step change is the cutout *tweening between* the old and new box. Now `4` and `150`. The
   give-away was that the cutout spanned exactly the gap between two consecutive targets; a
   mis-anchor would have sat in one wrong place instead.

3. **`/workspace/$id` is fullscreen with no sidebar** (`__root.tsx`, the `fullscreen` branch).
   Any tour step pointing at a rail row has nothing to attach to there, and a component mounted
   inside `AppShell` unmounts outright on that navigation. The tour now uses that as the mechanism:
   it tears down on the way in and resumes from a persisted step index on the way back, so no
   popover floats over the editor. The index is client-side (`localStorage`, like AppShell's own
   `gadgets:sidebar-collapsed`) because a tour position is per-device UI state; the **completion
   flag stays on the server**, because that one is an account fact.

4. **Teardown and finishing must be distinguishable.** `tour.destroy()` fires `onDestroyed`, so the
   unmount caused by navigating into the workspace would otherwise mark the walkthrough complete —
   at the exact moment the user did the thing it asked for. The cleanup sets its `finished` guard
   *before* destroying.

**On "advancing on real events, not Next buttons":** this file previously scoped all five steps
that way. Both shapes were built. A pure nav tour has nothing to wait for — every target co-exists
in the DOM — and reads as a slideshow; a pure event tour has only one honest event to wait on. The
resolution is mixed: the composer step advances on a **real send** and deliberately has *no* Next,
since letting someone click past it would mean completing a guided *build* without building
anything. The remaining steps are ordinary Back/Next.

**Testing it needs two layers, and the second one earned itself.** Fixture-based cases pin the
step *filter*; two more mount the real `SidebarItem` through a real router and run the real
`presentSteps()` against what it rendered, pinning the declaration to the derivation. Drifting the
derivation reddens only the second layer — which is exactly the drift that would otherwise make the
tour silently decline to run, indistinguishable from a deployment with no rail.

Watch the async detail if you extend those: the router resolves its initial match on a microtask,
so a synchronous `act()` returns with the DOM still empty. That first showed up as a failure that
looked like a product bug.

**Resetting the flag to see the tour again** (the stack must be stopped — workerd holds the DB):
```sh
sqlite3 <the user DO's .sqlite> \
  "pragma wal_checkpoint(TRUNCATE); delete from _cf_KV where key='walkthroughCompleted';"
```
Find it with a scan for `walkthroughCompleted` under `.workerd/do-disk`. Deleting the row is
correct rather than setting it false: a missing key reads back the declared default, which is the
same path an account that predates the feature takes.

**Not claimed:** the full resume path — send, land in the workspace, come back, pick up at
Outputs — has not been driven end to end in a browser. The pieces are unit-tested and it is
deployed, but that sequence is watched, not proven.

**Two claims deliberately NOT made, which a fresh session should not assume:**

- **Org separation is proven to *exclude*, not to *include*.** An org-less viewer sees no org-tagged
  public collection, with a private-collection negative control proving the filter is org-driven.
  Nobody has yet shown a viewer *with* org A seeing A's collection and not B's — that needs a user
  whose org resolves, which needs an IdP (OZL-222).
- **Nothing has been driven through a browser.** All the verification above runs over the real RPC
  API against the real stack: gating and policy behaviour, not rendering.



**~~OZL-300~~ — done. Private-CA TLS works, and the probe corrected several assumptions.**
`FIELDOS_CA_BUNDLE=/path/ca.pem` (comma-separated for several) emits `trustedCertificates` on every
worker's outbound network service; `FIELDOS_CA_TRUST_SYSTEM=false` additionally drops the system
bundle. Documented in `docs/configuration.md`; the runbook's section 4 is no longer a gap.

Four things worth not re-deriving:

1. **`trustedCertificates` is additive, not a replacement.** With `trustBrowserCas = true` *and* a
   private CA, both a private-CA origin and `https://example.com` succeed — verified in one config.
   So the add-versus-replace question OZL-300 raises is a real operator choice, not something the
   mechanism forces. That is why `FIELDOS_CA_TRUST_SYSTEM` exists at all.
2. **The log's earlier "does parse and boot" was true but not the same claim.** It was observed
   while probing `ExternalServer`, where `tlsOptions` hangs off that unfiltered binding. OZL-300
   needs it on the `network` service (`workerd.capnp:844`), a different place — and "parses" is not
   "validates a chain". Both had to be executed.
3. **`capnpString` did not escape newlines, and a PEM is inherently multi-line.** The generated
   config was written successfully and then failed to *parse at boot* — the script exits 0, and the
   error surfaces later as `Parse error` with no mention of the CA. Fixed in the shared helper, not
   at the call site: instance vars forwarded from the environment (`INSTANCE_VARS`) run through the
   same function and were exposed to the same bug.
4. **Verification needed `--experimental`.** The first real-stack run returned `CURL_FAILED` and
   looked like a CA failure; workerd had actually refused to start over worker-loader bindings, and
   the origin logged no handshake. The origin's own log is what separated the two — a fixture that
   never connects looks exactly like a rejected certificate.

**A caveat this does not cover: the deployed (non-workerd) path is a separate mechanism.** OZL-300
lists it as item 4 and nothing here touches it. `FIELDOS_CA_BUNDLE` is a `run-workerd.mjs` variable.

**Stale doc noticed, not fixed:** `docs/configuration.md` "Known gaps" still says "No admin UI for
session bounds yet", which OZL-226 (PR #73/#74) closed. Left alone as out of scope.

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

**Cheapest first: OZL-224 and OZL-227** — doc/sheet/deck and sharing, each verification rather than
construction. (OZL-226 was the third and is now done.) Both are far cheaper than they were: the
instance-var passthrough means a local `--allow none` stack can now be driven as a real admin with
a real policy, which is what made OZL-226's verification possible at all.

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

**The signature path is now tested against real signed tokens** (2026-08-16). `verifyIdToken` — the
function deciding whose email the Workshop trusts — had **zero** coverage: `identity.test.ts`
exercises `identityFromClaims`, which takes *already-verified* claims, and `discoverEndpoints`,
which takes an injected fetch. Everything in between was never executed by a test.

`verify-id-token.test.ts` signs RS256 tokens with a generated key and serves a real JWKS, so
`jwtVerify` does the same work it does against Keycloak. It pins that a token signed by another
key, from another issuer, for another audience, expired, or with `email_verified: false` is all
rejected — and that a trailing slash on the configured issuer does not break the `iss` comparison,
since operators paste it both ways. RED-checked: dropping the audience check fails exactly one test.

**What still remains is a live IdP.** A signing stub proves our verification logic; it does not
prove a real Keycloak's discovery document, claim names and group mapper behave as expected end to
end. That is the same gap OZL-225 closed for inference, and the OZL-225 lesson is the reason the
stub here *signs* rather than merely returning fixtures: a permissive stand-in proves nothing.

## Traps that have already cost time

**`pnpm gate` is not what CI runs. This cost time three separate ways on 2026-08-19.**
The gate is `lint && test`. CI additionally runs `pnpm build`, the frontend **airgap check**, and
the **integration suite** — and each one caught something the gate had passed:

| Caught by | What it was |
|---|---|
| `pnpm build` | stale `.wrangler/validate/` breaking a later `tsc` (green CI, red local, same commit) |
| airgap check | a hardcoded `openrouter.ai` preset in the bundle |
| integration suite | `sharing-boundary` replay tests, passing locally 16/16, failing on CI |

"Gate green" therefore does not mean "CI will pass". Before pushing anything release-shaped, run
`pnpm gate:release` — and for a frontend change, `pnpm --filter @gadgets/workshop-frontend build`,
since that is what runs the airgap check.

**`VITE_BACKEND_HOST` bit again on 2026-08-20, exactly as the log predicted it would.** A plain
`pnpm --filter @gadgets/workshop-frontend build` bakes in the *dev* backend (`localhost:8787`), so
a stack serving `:8080` hands the browser a UI that loads and then never connects. `run-workerd`
prints a warning; the health check still returns **200**, because the SPA itself is served fine —
the failure is one layer further in. Rebuild with `VITE_BACKEND_HOST=localhost:8080` before
redeploying, and read the *boot log*, not the status code. This is now the fourth occurrence, and
the previous entry already said a warning on a hot path is not a control.

**But do not carry that habit into a deployment build — there, the fix is to leave it unset.**
`getBackendHost()` (`main.tsx:61-68`) falls back to `window.location.host`, so **same-origin is
already the assumed topology and the variable is an override, not a requirement**. The
`localhost:8787` fallback fires only when `hostname === 'localhost'`, which is why a dev-built
bundle breaks a localhost stack and why that failure cannot occur on a real hostname. Verified by
building with `env -u VITE_BACKEND_HOST`: the only `localhost:8787` left in the bundle is the
literal inside that guarded ternary — no host is baked in at all. Setting the variable for a
deployment bakes a constant into an artifact that did not need one, and costs you one image per
customer hostname for nothing. (Found by the GCP work, 2026-08-20.)

**Stopping the local stack needs the supervisor first, then the child — and the child may need
`kill -9`.** `run-workerd.mjs` spawns `workerd serve` as a child that **survives its parent**: kill
the supervisor alone and :8080 stays held by an orphan with no watchdog behind it. SIGTERM to the
child is frequently ignored, so escalation is normal, not a symptom. Take a backup first
(`node scripts/backup-do-disk.mjs`, `VACUUM INTO`, consistent on a live DB) — state has survived
every `kill -9` so far and `quick_check` confirms it, but that is an observation, not a guarantee.

Related: `pgrep -f "workerd serve"` **over-counts in two directions, and a `pkill` built on it is
deployment-wide, not per-stack.** Test fixtures leak `workerd serve fixture.capnp` processes that
outlive their runs (nine were parked on the dev box on 2026-08-19) — those are test litter, safe to
kill. But **another session's stack matches too**: neither `run-workerd.mjs` nor
`workerd/bin/workerd serve` carries a port, so `pkill -9 -f "workerd/bin/workerd serve"` takes down
every stack on the box. That happened on 2026-08-20 with two sessions sharing a machine; the
watchdog respawned the collateral stack within three probe intervals and nothing was lost, but it
is luck, not design.

The command line cannot tell two stacks apart — every one of them is the same
`workerd serve config.capnp`. What *is* unique is the process's **`cwd`, which is the `--out`
directory**, and the port it listens on. Neither shows up in `ps`, so identify by port:

```sh
# who holds :8080 -- this is your stack
lsof -nP -iTCP:8080 -sTCP:LISTEN

# and what --out it is running from, to be sure
lsof -a -p <pid> -d cwd -Fn | grep ^n
```

Kill that pid, not a pattern. Reserve the bare deployment-wide `pkill` for a deliberate "stop
everything on this box" — and remember the supervisor still has to go first, or the watchdog
respawns what you just killed.

**`--out` is not a free choice: it is only relocatable near the repo.** The generated config mixes
two path schemes — disk services are embedded **absolute** (`run-workerd.mjs:654,693`, the frontend
`dist` and `do-disk`), while every worker module is embedded **relative to `--out`**
(`:470,473,617,631,646,707`, via `relative(args.out, ...)`). Point `--out` somewhere far away, say
`/tmp`, and the relative paths climb out of the tree: the config writes fine, the script exits 0,
and workerd dies at boot with `Couldn't read file for embed: ../../Users/.../fieldos-runtime/src/kv.js`.

Same failure signature as the `capnpString` newline bug below — late, at boot, naming a *file*
rather than the flag that caused it. Keep `--out` beside the repo, or make the module embeds
absolute too. (Found by the GCP containerization work, 2026-08-20.)

**A URL field that accepts the URL from the vendor's own docs will be pasted that way.**
Every model call 404'd on a live deployment because `apiUrl` held
`https://openrouter.ai/api/v1/chat/completions` — the URL every OpenAI and OpenRouter sample
shows. The base-building code stripped a trailing `/api` or `/v1` but not `/chat/completions`, so
it produced `.../chat/completions/v1`. Fixed, with the normalizer moved to `workshop-shared` so
the picker and the server cannot disagree. The general lesson: the field said "Base URL of your
OpenAI-compatible server" and that was **not enough** — people paste from the source they are
copying, not from the field description.

**Reading raw SQLite strings is not reading the config.** While diagnosing that 404 I matched a
`resourceUrl` value and reported it as the API URL, sending the user to change something already
correct. The field names were in the same output. Their pushback is what caught it.

**`git clean -fdX` with a pathspec does not constrain the way you expect.** It removed every
package's `node_modules` and `dist/`, which then produced six phantom test failures that had to be
isolated before being recognised as self-inflicted. Recovered with `pnpm install && pnpm build`.


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
  gitignored `.wrangler/validate/`; clear with
  `find packages -maxdepth 2 -name .wrangler -type d -exec rm -rf {} +`. `pnpm gate` trips
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
- **A `pnpm build` run immediately after `pnpm gate` can fail on a torn generated file.** Seen on
  2026-08-16: `gatekeeper-oidc` failed with three `error TS2345` in `.wrangler/validate/src/oidc.ts`,
  all reading `Type 'string' is not assignable to type '"workerEntrypoint"'`. That signature means a
  **partially-written** generated file (the OZL-256 race), not a type error you introduced — the
  build passes reproducibly from a cleared tree. Distinguish it from the `.wrangler` non-idempotence
  trap below by the message: this one is a *widened* literal type in generated output, that one is
  ordinary type errors in machine-generated sources. Both are cured by clearing `.wrangler`, so it
  is tempting to stop at the first explanation that fits — but they are different bugs, and reading
  a `main` comparison as proof either way is a mistake when the comparison also cleared the tree.

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
  `pgrep -f "workerd/bin/workerd serve" | wc -l` before trusting any timing measurement, and
  kill **the supervisor first** between runs. Untriaged — it makes benchmarks lie, not the suite
  fail.
- **Killing `workerd serve` does not stop a `run-workerd.mjs` stack, and `pgrep -f "workerd serve"`
  over-counts.** Two corrections to the line above, both found the slow way on 2026-08-16. The
  supervisor (`node scripts/run-workerd.mjs`) keeps holding port 8080 after its child dies, so
  backgrounded runs accumulate — **six** were alive at once, the oldest 3h49m. A new run then logs
  `Address already in use; toString() = *:8080` while the *old* stack keeps answering `GET /`, so
  what you measure is not the config you just generated. Separately, that `pgrep` pattern matches
  the zsh wrapper whose command line contains the string, so it reports processes that are not
  workerd. Tear down in this order, and confirm all three are zero before trusting any result:

  ```sh
  pkill -9 -f "run-workerd.mjs"            # supervisors first
  pkill -9 -f "workerd/bin/workerd serve"  # then real binaries (note the path)
  lsof -ti:8080 | xargs -r kill -9
  ```
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

- **The gate is not idempotent: a second `pnpm gate` without clearing `.wrangler` first fails.**
  Deterministic, pre-existing, and *not* the OZL-256 flake — it is the `.wrangler/validate` trap
  below, firing on `types:check` in `gatekeeper-oidc`. It is always that package because its
  tracked `worker-configuration.d.ts` is the **only** one whose `mainModule` points into the
  generated tree (`"./.wrangler/validate/src/oidc"`); the other seven say `"./src/…"` or the
  `"my-main-module"` placeholder. That path is gitignored, so it resolves to `any` on a clean tree
  and is *type-checked* once a build recreates it — machine-generated sources, with errors nobody
  wrote. `exclude` in tsconfig cannot fix it (the file is reached by import, not by the `include`
  glob — tried and reverted); regenerating that one file on a clean tree probably can. Clear
  `.wrangler` between gate runs until someone does.
  Clear with `find packages -maxdepth 2 -name .wrangler -type d -exec rm -rf {} +`, **not**
  `rm -rf packages/*/.wrangler`: under zsh an unmatched glob is an error, so that form exits 1 and
  deletes nothing when the dirs are already absent. It works when they exist, which is why it
  looked fine for so long — the failure is invisible in exactly the case where it does no harm,
  and it silently breaks a `&&` chain that expects it to succeed.
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
