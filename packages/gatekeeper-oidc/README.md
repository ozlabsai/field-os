# gatekeeper-oidc

Single sign-on against any standards-compliant OpenID Connect provider — Keycloak, Okta, Authentik,
Dex, ADFS. One connector serves every deployment: the issuer and client credentials are
configuration, not code, so a new customer with a different identity provider needs no new package.

This connector **authenticates and nothing else**. It exposes no resources, mints no agent-facing
sessions, and stores no access token. Its whole job is to answer "who is this?" with an email
address the Workshop can trust.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `OIDC_ISSUER` | yes | Issuer base URL, no trailing slash. Endpoints are discovered from `{issuer}/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | yes | Client ID of a confidential client registered for this deployment. |
| `OIDC_CLIENT_SECRET` | yes | That client's secret. |
| `OIDC_SCOPES` | no | Extra scopes. `openid` and `email` are always requested. |
| `OIDC_GROUPS_CLAIM` | no | Claim to read group membership from, for org separation. Unset means this deployment does not use org separation. |
| `OIDC_ORG_PREFIX` | no | Optional prefix marking which groups are orgs, e.g. `fieldos-` so `fieldos-legal` yields org `legal`. |

Issuer examples: Keycloak `https://host/realms/{realm}`, Okta `https://org.okta.com` (or
`https://org.okta.com/oauth2/{authServerId}` for a custom authorization server), Entra
`https://login.microsoftonline.com/{tenant}/v2.0`, Authentik `https://host/application/o/{slug}`,
ADFS `https://host/adfs`.

**Okta needs `OIDC_SCOPES=groups`** if you use org separation: Okta only emits the groups claim when
the scope is requested.

Register the redirect URI as `{PUBLIC_BASE_URL}/gatekeeper/oidc/callback`, exactly.

Sign-in must then be enabled deployment-side by adding `oidc` to the `AUTH_GATEKEEPERS` allowlist —
auth configuration is env-driven so that it cannot be changed from a compromised admin session.

## Requirements on the provider

**The ID token must carry a verified email.** Sign-in is refused unless `email_verified` is exactly
`true`; an absent claim counts as unverified, because some providers omit it rather than sending
`false`. The Workshop keys accounts by email, so accepting an unverified address would let anyone
who can register `victim@corp` at a permissive provider sign in as that user here.

Discovery is required rather than optional. Hand-configuring endpoint URLs is repeated opportunity
to point token verification at the wrong host, and every supported provider publishes a discovery
document. Its declared `issuer` must match what is configured, and every endpoint it advertises
must share that origin and use HTTPS.

**If using `OIDC_GROUPS_CLAIM` for org separation**, the provider must be configured to actually
emit that claim — it is off by default in every provider here — and the claim must reach the **ID
token** specifically, since this connector verifies the ID token and never calls the userinfo
endpoint. Three provider-specific traps, each of which otherwise fails silently to "no org":

- **Keycloak** emits group *paths* (`/eng/fieldos-legal`), not names. Matching is on the last
  segment, so nesting is handled; but check the mapper's ID-token checkbox.
- **Okta** requires `groups` in `OIDC_SCOPES` as well as a configured claim.
- **Entra** emits group **GUIDs** by default, which no prefix can match. Use App Roles (point
  `OIDC_GROUPS_CLAIM` at `roles`) unless the groups are AD-synced. Entra also drops the claim
  entirely above 200 groups; that case is logged as `oidc.org.claim.overage` rather than passing
  silently, and sign-in still succeeds.

See [org resolution in `docs/configuration.md`](../../docs/configuration.md#org-resolution) for the
full reasoning and the Entra constraint.

## Design notes

- **Two nonce stages.** An initiation nonce is spent when the user opens the sign-in link; only
  then is the `state` nonce minted. A captured link cannot be reused, and a captured callback URL
  cannot be replayed — the nonce is deleted before the code exchange.
- **The grant is transient.** Once the Workshop has read the email, the account self-destructs on a
  two-minute alarm. Abandoned attempts are reaped after an hour.
- **No access token is kept**, because there is no resource to reach with one.

## Layout

| File | Contents |
|---|---|
| `src/identity.ts` | Discovery and ID token verification — what the provider claims, and whether to believe it. |
| `src/oauth.ts` | Nonces, the authorize URL, the code exchange. |
| `src/oidc.ts` | Durable state and the Workshop-facing contract. |

`identity.ts` and `oauth.ts` hold no Workers types, so their rules are unit-testable directly;
`__tests__/` covers every rejection path.
