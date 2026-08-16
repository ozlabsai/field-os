# Security runbook — risk acceptances and audit evidence

This is the document OZL-231 requires: the place where deferred security decisions are **either
fixed or explicitly accepted in writing**, and where the evidence behind each is recorded so a
reviewer is not asked to take a claim on trust.

It did not exist before 2026-08-16. OZL-219 was closed without it, even though its own "Done when"
required "the risk-acceptance document is written and signed off" — so the acceptance below was
outstanding rather than granted.

**Nothing here is signed.** Every acceptance carries an empty signature line. An unsigned row is an
*open* risk, not an accepted one, and this file makes the difference visible instead of letting an
undocumented default stand in for a decision.

## How to read this

Each item states what was **verified by execution**, what was **verified by reading code**, and what
is **inferred**. Those are different strengths of claim and the distinction is load-bearing: this
fork runs on a different runtime than upstream tests against, so an unexecuted claim decays quietly.

Line references are to the state at commit `db7ff56` (2026-08-16).

---

## 1. `global_fetch_strictly_public` — MANDATORY SIGNED ACCEPTANCE

**Status: not disabled anywhere. No acceptance is currently required.**

OZL-231 requires that *disabling* this flag be a written, signed-off risk acceptance, because it
removes DNS-rebinding protection wholesale. The audit found it is **omitted** in most packages but
**disabled** in none:

| Package | `global_fetch_strictly_public` |
|---|---|
| `workshop-backend` | present (`wrangler.jsonc:27`) |
| `gatekeeper-mcp` | present (`:20`) |
| `gatekeeper-mcp-portal` | present (`:16`) |
| `gatekeeper-context`, `-github`, `-homeassistant`, `-oidc`, `-scheduler`, `router` | absent |

Omission is not the same as disabling, and on this fork the distinction matters less than it looks:
the flag is a Cloudflare-platform control and is **near-inert off-platform** (inferred from
`plans/fieldos-log.md:497,935`, not re-executed). The operative control on standalone workerd is
`INTERNAL_REACH` in `scripts/run-workerd.mjs:304-310`, which grants private-network reach **per
worker, per role** — verified by execution: a `--allow none` stack emits `allow = []` for every
per-worker service.

**If a future deployment disables the flag, sign here first:**

> I accept that disabling `global_fetch_strictly_public` removes DNS-rebinding protection for the
> named workers, and that the compensating control is the `INTERNAL_REACH` address allowlist.
>
> Name: ______________________  Role: ______________  Date: __________

---

## 2. SSRF module review — the redirect artifact

OZL-231 requires the redirect-hop case (allowed → disallowed must be blocked) as **an explicit
artifact, not a claim**. There are two fetch paths and they have deliberately different postures.

### `mcp-shared` — guarded, and the artifact exists

`guardedFetch` (`packages/mcp-shared/src/fetch.ts:141-206`) follows redirects **manually**
(`redirect: "manual"`, `:157`) so every hop is revalidated:

- `:171` `isAllowedUrl(next)` on each hop; `MAX_REDIRECTS = 3` (`:15`)
- `:188-192` drops `Authorization` and `Mcp-Session-Id` cross-origin
- `:182` refuses to replay a body cross-origin on 307/308

**The required artifact:** `packages/mcp-shared/__tests__/fetch.test.ts:39-47`, *"does not follow a
redirect into a blocked host"* — `https://mcp.example.com/mcp` → `http://169.254.169.254/latest/`,
asserting the second hop is never made. This satisfies the ticket's demand and predates this audit.

### `webFetch` — deliberately unguarded, now pinned

`packages/workshop-backend/src/web-fetch.ts` has **no host allowlist by design** (`:56-59`): it is a
general web-fetch tool, and the file argues a textual blocklist is unsound because a hostname can
resolve anywhere at fetch time. It uses `redirect: "follow"` (`:276-284`) and does **not**
revalidate the landing URL.

`__tests__/web-fetch.test.ts:310-403` pins this **in both directions**, including a test named
*"does NOT re-validate the URL after a cross-origin redirect"*. That is intentional: it documents
the gap rather than hiding it, so closing it later is a visible change to an expectation.

**Accepted, pending signature:**

> I accept that `webFetch` follows cross-origin redirects without revalidating the landing URL, on
> the basis that its blast radius is bounded by `INTERNAL_REACH` (`workshop-backend` holds only the
> `inference` role) rather than by application code.
>
> Name: ______________________  Role: ______________  Date: __________

---

## 3. `gatekeeper-homeassistant` — no host check

**Confirmed, and narrower than first assessed.**

Verified by reading code: HA has no `isBlockedHost` equivalent, and its connect form validates the
pasted `baseUrl` for **scheme only** — `http:` or `https:`, no host constraint
(`homeassistant.ts:308-315`). `fetchJson` sets `Authorization: Bearer` unconditionally and passes no
`redirect:` option, so the runtime default (`follow`) applies (`homeassistant-api.ts:70-94`).

**A correction worth recording, because the first reading was wrong.** The initial assessment was
that a malicious `baseUrl` could redirect cross-origin and carry the user's HA bearer token to an
attacker host. **Verified by execution — it cannot:** the runtime strips `Authorization` on a
cross-host redirect automatically, and retains it only same-origin. `mcp-shared` strips the header
by hand only because it follows hops itself with `redirect: "manual"`, which bypasses that automatic
behaviour. The two are consistent.

So the real finding is not credential leakage but that **nothing constrains which private address HA
reaches**. HA holds private reach deliberately — `run-workerd.mjs:285-286` names it as the on-prem
template, "a public Home Assistant is the unusual case" — and `FIELDOS_INTERNAL_HOSTS` narrows that
to declared addresses.

**Accepted, pending signature:**

> I accept that `gatekeeper-homeassistant` performs no host validation on the user-supplied instance
> URL, on the basis that its reach is constrained by `INTERNAL_REACH` / `FIELDOS_INTERNAL_HOSTS` and
> that the credential it holds is the user's own Home Assistant token.
>
> Name: ______________________  Role: ______________  Date: __________

---

## 4. Private-CA TLS — NOT IMPLEMENTED

**No connector supports a custom CA bundle.** Verified: the only TLS configuration anywhere is
`scripts/run-workerd.mjs:614`, `tlsOptions = (trustBrowserCas = true)` — the *system* bundle. There
is no `caCerts`, no `trustedCertificates`, no `NODE_EXTRA_CA_CERTS` in any source file.

OZL-219 lists this as a required compensating control and it was not delivered. An internal PKI is
described there as "likely immediate", so this is a **gap, not an acceptance**: a deployment whose
internal services use a private CA cannot currently be reached over HTTPS by any connector.

Tracked as future work in `plans/fieldos.md:206`. **This item blocks any deployment with an internal
PKI** and should be resolved rather than signed away.

---

## 5. Prompt-injection defences — FIXED during this audit

OZL-231 names the compaction framing (`agent.ts`) as "the strongest prompt-injection defence in the
codebase" and requires audit remediation to leave it intact. The audit found the claim is accurate
**and narrower than it sounds**: it is the *only* content-framing defence applied to untrusted input
anywhere on the path into the model's context.

Every other untrusted channel reaches the model as plain text — verified by reading code: `webFetch`
bodies, MCP tool results (`tools.ts:127-143` `toCallResult` applies no framing; the quoting helpers
in that file protect the **approval UI**, not the model), `executeCode` output, Context Library
documents, text attachments, and gadget-authored messages (which are built identically to user
messages, `agent.ts:1449-1450`).

**A real, exploitable gap was found and fixed.** The stripping used a single `.replace()`, which
never rescans its own output — so an overlapping tag was *reconstructed by the act of stripping*:

```
<prior<prior_conversation>_conversation>   ->   <prior_conversation>
```

**Demonstrated by execution:** a summary containing `</prior<prior_conversation>_conversation>`
yielded a valid **closing** tag, placing text after it outside the framing while still arriving in a
`user` message — precisely the escape the code comment says the stripping prevents.

Fixed by stripping to a fixpoint (`stripPriorConversationTags`, `agent.ts`). The framing itself is
unchanged, as the ticket requires.

**The defence had zero test coverage** — a grep for `prior_conversation` across every test directory
returned nothing, despite `agent-compaction.test.ts` being 443 lines. Now covered by
`__tests__/prior-conversation-framing.test.ts`, RED-checked: reverting to the single-pass regex fails
exactly the two tests that describe the bug.

**Deliberately not claimed:** Unicode lookalikes (`＜prior_conversation＞`, Cyrillic `о`) are *not*
stripped. They are not valid delimiters for any parser, and whether a model honours them is
speculation. The test pins this as a known limit rather than asserting a defence that was never
verified.

**Accepted, pending signature:**

> I accept that untrusted content other than the compaction summary reaches the model unframed, and
> that the framing is a prompt-level convention which no downstream mechanism enforces.
>
> Name: ______________________  Role: ______________  Date: __________

---

## 6. Blueprints unauthenticated by id (OZL-223) — OPEN DECISION

**Confirmed.** `getBlueprint` and `downloadBlueprint` are declared on `PublicApi`
(`packages/workshop-shared/src/api.ts:106,110`) — the unauthenticated surface. The doc comment at
`:104-105` states the design intent outright: *"No authentication required (knowing the ID is
sufficient, since a blueprint is 'just data')."* Verified: neither implementation
(`server.ts:852-871`) performs any auth check, and `/blueprint-screenshot/` is likewise
unauthenticated (`router/src/index.ts:31-33`, `server.ts:678-694`).

They never call `open()`, so **org separation does not apply to them** — verified: the only
enforcement predicate is `isOrgAccessPermitted`, with exactly two call sites
(`overseer.ts:6644`, `:6754`), neither on this path.

This is a **decision, not a defect** (OZL-223), and it needs the customer's answer: a blueprint is a
snapshot of a workspace's code, so in a deployment where "what Legal is working on" is itself
sensitive, an unauthenticated fetch by id is a real leak.

**This item requires a decision before sign-off. Do not sign it as accepted without one.**

---

## 7. Context gatekeeper `sharingDomain` — BLOCKS multi-classification deployments

`packages/gatekeeper-context/src/domain.ts:1-2` disclaims it in its own source: it "prevents
accidental mixing between trusted deployments sharing a gatekeeper instance; it is **not a boundary
against malicious peer configs**."

Verified: `sharingDomain` arrives from the calling Workshop's binding props
(`library-gatekeeper.ts:396,421`), set by the deploy service to the instance origin
(`manifest-lib.mjs:193-197`). The gatekeeper accepts it as given — no validation, no cross-check
against caller identity, no registry of legitimate domains. Two deployments sharing one gatekeeper
instance with the same string share the **public collection set** (`library-gatekeeper.ts:213`);
private collections stay separated by a per-account UUID.

**Per OZL-231, if the deployment spans classification levels, this blocks.** It is adequate for a
single trusted deployment and inadequate across classification levels on shared infrastructure.

**Accepted only for single-deployment installs, pending signature:**

> I confirm this deployment does **not** share a `gatekeeper-context` instance across classification
> levels, and accept `sharingDomain` as an anti-accident measure rather than a security boundary.
>
> Name: ______________________  Role: ______________  Date: __________

---

## 8. Scope boundaries stated to the reviewer

OZL-231 asks that these be stated plainly rather than discovered:

- **Admin revocation targets a named user.** Verified: `revokeSessionsForUser`
  (`server.ts:175-181`) addresses a user DO by name, and **no user enumeration exists anywhere** —
  searches for `listUsers`/`userIndex`/`allUsers` across the backend return nothing. "Revoke
  everyone" is not implementable without building a user directory the deployment deliberately does
  not have (`api.ts:356-358`, `overseer.ts:6355-6359`).
- **`readOnlyHint` is server self-labelling.** A tool the MCP server declares `readOnlyHint: true`
  runs as an observation without approval, on both trust tiers (`tools.ts:48-58`). Only
  auto-*applying* a write additionally requires a `vetted` endpoint, which only the portal can
  produce via `MCP_PORTAL_TRUST_ANNOTATIONS` (`gatekeeper-mcp-portal/src/config.ts:35`, off by
  default). Tracked as OZL-228.
- **Org separation is two env vars in two workers.** `ENABLE_ORG_SEPARATION` is read independently
  by the backend (`auth/org-policy.ts:22`) and by `gatekeeper-context` (`org-scoping.ts:74-76`).
  Nothing enforces they are set together; setting only one half-enforces the boundary while looking
  correct. Documented as an operator obligation (`docs/configuration.md:155`).
- **A workerd connection refusal is nearly undiagnosable.** The caller gets an opaque reference
  token naming neither cause nor address, so a policy refusal and a DNS failure are
  indistinguishable to application code. See `plans/handoff.md` § Traps.

---

## Sign-off

The audit is complete when every row above is signed or resolved. As of 2026-08-16:

| Item | State |
|---|---|
| 1. `global_fetch_strictly_public` | No acceptance needed — not disabled anywhere |
| 2. SSRF review + redirect artifact | Artifact exists; `webFetch` gap pinned by test — **needs signature** |
| 3. HomeAssistant host check | **Needs signature** |
| 4. Private-CA TLS | **GAP — resolve, do not sign** |
| 5. Prompt-injection framing | **Fixed** during this audit — residual scope needs signature |
| 6. Blueprints unauthenticated | **Needs a decision** (OZL-223) |
| 7. `sharingDomain` | **Needs signature**, and blocks multi-classification deployments |
| 8. Scope boundaries | Stated, no signature required |
