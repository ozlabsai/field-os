# Upstream ports

Append-only ledger of what we took from
[`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os) and what we deliberately
did not. Process: [`upstream-sync.md`](./upstream-sync.md).

**Triaged through: `8b08672` (2026-08-10).**

Update that mark on every pass. It cannot be derived: cherry-picking does not create ancestry, so
`merge-base` stays at the fork point forever and would keep re-offering commits already ported.

| upstream sha | date | verdict | why |
|---|---|---|---|
| `b2a51b5` | 2026-08-09 | **PORTED** | RPC error classification. Rule 3 (auth) + rule 4 (touches `user.ts`, `server.ts`, `api.ts`). Also fixed a defect of ours — see below. |
| `2508099` | 2026-08-10 | **TO PORT** | "Fix custom ports for local development". Rule 4 (touches `scripts/dev-server-config.js`, which we modified). Dev-ergonomics only, no runtime surface — low risk, low urgency. |
| `8b08672` | 2026-08-10 | **TO PORT** | "Fix code that aborts the WebSocket when an overseer DO dies". Rule 4 (`server.ts`). The direct follow-up to `b2a51b5` — it builds on the same reconnect path, so porting it *after* this one is the cheap ordering. Touches the DO lifecycle, so unlike `b2a51b5` it genuinely needs the full gate. |

## Ported: `b2a51b5` — the first exercise of this process

Chosen because it is small, real, and fixes something we broke.

**It repaired our own session-expiry work.** `user.ts:328` threw `new Error("invalid session
token")` for *both* a bogus token and an expired session, because we routed expiry through
`checkSession()`. `server.ts:736` threw a differently-capitalised `"Invalid session token."`. So a
client could not distinguish "expired, log in again" from "bad token, something is wrong" — and
upstream's new classifier keys on exactly this. Upstream's own commit message calls out the
capitalised variant *"which the lowercase message fallback could never have matched"*, i.e. it
independently found the same defect. Porting was cheaper than designing our own, which is the whole
argument for soft-forking.

### What it actually cost

The dry-run predicted 3 conflict hunks; that was exactly right.

* **Two import lines** (`user.ts`, `server.ts`) — mechanical unions. Ours contributes `OrgLookup`,
  upstream contributes `AUTH_ERROR_CODES` and `createAuthError`.
* **One throw site** (`user.ts:328`) — the only real decision. Upstream replaces the call with a
  bare `this.storage.sessions.get(tokenId)` existence check. Taking that verbatim would have
  **silently un-expired every session**, because our `checkSession()` also enforces the idle and
  absolute deadlines and deletes the row when either passes (OZL-212). Resolution: keep our
  `checkSession()`, adopt upstream's coded error. A comment at the site records why, so a future
  port does not "simplify" it back.

`workshop-shared/src/api.ts` auto-merged cleanly despite our `+42/−5`, and all 14 frontend files
applied with zero conflicts — as predicted.

### One thing the dry-run did not predict

`pnpm gate` failed the first run on `rpcErrors.test.ts`: two `@ts-expect-error` directives that are
**unused in our tree** (TS2578, a hard error). Upstream needs them because its frontend `src/`
tsconfig carries only browser types; ours resolves node builtins. Dropped the directives, kept the
imports, and left a comment explaining the divergence.

Worth recording because it is the *class* of thing that makes ports expensive: not the conflicted
hunks git shows you, but the clean-merging code that then fails to compile against a differently
configured tree. The gate caught it in one run.

### Gate result

`pnpm gate` exit 0 — lint clean, 66 script tests, `workerd-tests` 17/17 across 9 files (tiers 1 and
2 on the pinned workerd), `workshop-frontend` 135 tests across 26 files, up from 118/24: upstream's
new `rpcErrors` and `accountsSubscriber` suites now run here.

This is the first port gated on standalone workerd rather than lint+test alone, which was the
caveat OZL-243 carried until OZL-242 landed.
