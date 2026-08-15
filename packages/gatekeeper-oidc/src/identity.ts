// ID token verification and the sign-in identity derived from it.
//
// This is the security-critical half of the connector. The Workshop keys user accounts by email
// (see `GatekeeperUser.getAuthenticatedEmail` in workshop-shared/gatekeeper.ts), so an email this
// module accepts is an identity the Workshop will sign someone in as. Everything here exists to
// make sure that email genuinely came from the configured issuer, for this client, and was
// verified by the identity provider.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Deployment-supplied OIDC configuration. */
export interface OidcConfig {
  /** Issuer URL, matched exactly against the `iss` claim. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scopes. `openid` and `email` are always required and added if absent. */
  scopes: string;
}

/** Endpoints resolved from the issuer's discovery document. */
export interface OidcEndpoints {
  authorization: string;
  token: string;
  jwks: string;
}

/** A verified sign-in identity. `email` is safe to use as the Workshop's account key. */
export interface OidcIdentity {
  email: string;
  /** The IdP's stable subject identifier, for logging and future account linking. */
  subject: string;
  /** `exp` from the ID token, so the Workshop can bound the session it mints. */
  expiresAt?: Date;
  /**
   * Organization this user belongs to, from the configured group claim, or undefined when the
   * deployment does not use org separation or the claim yielded nothing.
   *
   * Undefined means **no org**, never a default one. See `resolveOrg`.
   */
  orgId?: string;
}

/** How a deployment maps an IdP group claim onto an org. */
export interface OrgClaimConfig {
  /**
   * Claim to read group membership from. There is no standard name — GitLab exposes this as
   * `groups_attribute`, Grafana requires a mapper on the Keycloak client — so it is configuration
   * rather than a constant. Unset disables org resolution entirely.
   */
  claim?: string;
  /**
   * Optional prefix marking which groups are orgs. A user is typically in many groups that have
   * nothing to do with FieldOS; with `fieldos-` set, `fieldos-legal` yields the org `legal` and
   * every other group is ignored.
   */
  prefix?: string;
}

// Scopes we always request. `openid` makes it an OIDC (not bare OAuth) flow, and without `email`
// there is no identity to sign in with.
const REQUIRED_SCOPES = ["openid", "email"];

/** Normalizes configured scopes, adding the ones the flow cannot work without. */
export function resolveScopes(configured: string): string {
  let scopes = configured.split(/\s+/).filter(Boolean);
  for (let required of REQUIRED_SCOPES) {
    if (!scopes.includes(required)) scopes.push(required);
  }
  return scopes.join(" ");
}

// JWKS clients are cached per issuer: `createRemoteJWKSet` maintains its own key cache and
// rotation handling, so rebuilding it per request would refetch keys and defeat that. Same
// approach as workshop-backend/src/access.ts.
const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwkSetFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let existing = jwkSets.get(jwksUri);
  if (existing) return existing;
  let created = createRemoteJWKSet(new URL(jwksUri));
  jwkSets.set(jwksUri, created);
  return created;
}

/**
 * Fetches the issuer's discovery document and extracts the endpoints we need.
 *
 * Discovery is required rather than optional: hand-configuring three URLs per deployment is three
 * chances to point token verification at the wrong host, and every IdP this connector targets
 * (Keycloak, ADFS, Okta, Authentik, Dex) publishes one.
 *
 * Each advertised endpoint must share the issuer's origin. A discovery document is fetched over
 * TLS from the issuer, so this is defence in depth rather than the primary control — but it means
 * a tampered or misconfigured document cannot redirect token exchange to an attacker's host.
 */
export async function discoverEndpoints(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcEndpoints> {
  let base = issuer.replace(/\/$/, "");
  let response = await fetchImpl(`${base}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(
        `OIDC discovery failed for ${base} (HTTP ${response.status}). ` +
        `Check OIDC_ISSUER points at the issuer's base URL.`);
  }

  let doc = await response.json() as Record<string, unknown>;
  // The issuer in the document must match what we were configured with; otherwise we would trust
  // keys and endpoints belonging to a different issuer than the one whose `iss` we later check.
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/$/, "") !== base) {
    throw new Error(
        `OIDC discovery document declares issuer ${String(doc.issuer)}, expected ${base}.`);
  }

  let endpoints = {
    authorization: requireUrl(doc, "authorization_endpoint", base),
    token: requireUrl(doc, "token_endpoint", base),
    jwks: requireUrl(doc, "jwks_uri", base),
  };
  return endpoints;
}

function requireUrl(doc: Record<string, unknown>, field: string, issuerBase: string): string {
  let value = doc[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`OIDC discovery document is missing ${field}.`);
  }
  let url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`OIDC ${field} must use https (got ${url.protocol}//).`);
  }
  if (url.origin !== new URL(issuerBase).origin) {
    throw new Error(
        `OIDC ${field} (${url.origin}) is not on the issuer's origin (${new URL(issuerBase).origin}).`);
  }
  return value;
}

/**
 * Verifies an ID token and extracts the sign-in identity, or throws.
 *
 * `jwtVerify` checks the signature against the issuer's published keys and enforces `iss`, `aud`
 * and the time-based claims. On top of that we require a **verified** email: the Workshop keys
 * accounts by email, so accepting an unverified one lets anyone who can register `victim@corp` at
 * a permissive IdP sign in as that user here.
 */
export async function verifyIdToken(
  idToken: string,
  config: OidcConfig,
  endpoints: OidcEndpoints,
  org?: OrgClaimConfig,
  onOverage?: (claim: string) => void,
): Promise<OidcIdentity> {
  let { payload } = await jwtVerify(idToken, jwkSetFor(endpoints.jwks), {
    issuer: config.issuer.replace(/\/$/, ""),
    audience: config.clientId,
  });

  return identityFromClaims(payload, org, onOverage);
}

/**
 * Whether the IdP replaced this claim with a pointer to an external directory.
 *
 * Entra signals its group overage by omitting the claim and listing it in `_claim_names`, with the
 * retrieval endpoint in `_claim_sources` (RFC 7515 aggregated/distributed claims). Both are checked
 * so a token merely *carrying* distributed claims for something else is not mistaken for one.
 */
function isClaimOverage(payload: JWTPayload, claim: string): boolean {
  let names = payload._claim_names;
  if (!names || typeof names !== "object" || !(claim in names)) return false;
  return payload[claim] === undefined;
}

/**
 * Resolves the org a user belongs to from their verified claims.
 *
 * Returns undefined — meaning **no org** — whenever the answer is not unambiguous. That is
 * deliberate and is the whole safety property of this function: a user with no resolvable org gets
 * no access to org-scoped resources, rather than landing in whichever org a default would have
 * picked.
 *
 * The case that makes this non-theoretical: above 200 groups (JWT) or 150 (SAML), Microsoft Entra
 * **omits the groups claim entirely** and substitutes a pointer to Microsoft Graph, which an
 * airgapped deployment cannot reach. A user in 250 groups therefore arrives looking exactly like a
 * user in none. Defaulting would silently place them in someone else's org.
 *
 * Multiple matching groups are also treated as unresolvable: picking the first would make access
 * depend on the order an IdP happened to serialize a claim.
 */
export function resolveOrg(
    payload: JWTPayload, config: OrgClaimConfig,
    onOverage?: (claim: string) => void): string | undefined {
  if (!config.claim) return undefined;

  // Entra's group overage. Above 200 groups (JWT) it omits the claim ENTIRELY and substitutes
  // `_claim_names`/`_claim_sources` pointing at Microsoft Graph -- an internet endpoint an
  // airgapped deployment cannot reach. Without this branch such a user is byte-identical to one in
  // no groups at all, so a tenant-wide misconfiguration would present as an ordinary permissions
  // complaint from a handful of users. Detected, not resolved: there is nothing to fetch here, and
  // the fix is to reconfigure the IdP to emit only application-assigned groups.
  // Deliberately NOT a thrown error, even though it is a misconfiguration: `resolveOrg` runs
  // inside `verifyIdToken` on the sign-in path, so throwing would refuse the login outright and
  // turn a claim misconfiguration into an outage -- exactly what `#resolveOrg` in the Workshop's
  // login-flow.ts declines to do. The user resolves to no org (reaching nothing org-scoped, which
  // is recoverable and visible) and the deployment gets a distinct log line naming the cause.
  if (isClaimOverage(payload, config.claim)) {
    onOverage?.(config.claim);
    return undefined;
  }

  let raw = payload[config.claim];
  // Accept an array (the common shape) or a single string; anything else is not a group list.
  let groups = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  let names = groups.filter((g): g is string => typeof g === "string" && g.length > 0);
  if (names.length === 0) return undefined;

  // Keycloak emits group *paths*, not names: its group-membership mapper defaults `full.path` to
  // true, so a nested group arrives as `/eng/fieldos-legal` and a top-level one as
  // `/fieldos-legal`. Match on the LAST segment rather than stripping only the leading slash --
  // otherwise every user in a nested group silently resolves to no org under Keycloak's default
  // configuration, which is indistinguishable from a user who genuinely has none.
  let leaves = names.map(n => n.slice(n.lastIndexOf("/") + 1)).filter(n => n.length > 0);

  let matched = config.prefix
      ? leaves.filter(n => n.startsWith(config.prefix!))
              .map(n => n.slice(config.prefix!.length))
              .filter(n => n.length > 0)
      : leaves;

  // Deduplicate before deciding: an IdP repeating the same group is not an ambiguity.
  let unique = [...new Set(matched.map(n => n.toLowerCase()))];
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * Extracts a sign-in identity from already-verified ID token claims.
 *
 * Split from `verifyIdToken` so the claim rules can be tested without standing up a signer; do not
 * call it with unverified claims.
 */
export function identityFromClaims(
    payload: JWTPayload, org?: OrgClaimConfig,
    onOverage?: (claim: string) => void): OidcIdentity {
  let email = payload.email;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error(
        "The identity provider did not return an email claim. Ensure the 'email' scope is granted " +
        "and the client is configured to include email in the ID token.");
  }

  // Absent is treated as unverified. Some IdPs omit the claim entirely when they have not verified
  // the address, so defaulting to "trusted" here would be exactly backwards.
  if (payload.email_verified !== true) {
    throw new Error(
        `The identity provider reports ${email} as unverified. Sign-in requires a verified email ` +
        `address, because accounts are keyed by it.`);
  }

  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("The identity provider did not return a subject (sub) claim.");
  }

  return {
    // Lower-cased so the Workshop's account key is stable across IdPs that vary the casing.
    email: email.toLowerCase(),
    subject: payload.sub,
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : undefined,
    orgId: org ? resolveOrg(payload, org, onOverage) : undefined,
  };
}
