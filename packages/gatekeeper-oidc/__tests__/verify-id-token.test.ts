// verifyIdToken against REAL signed tokens and a real JWKS (OZL-222).
//
// This is the security-critical half of the connector: the Workshop keys accounts by the email
// this function accepts, so anything it lets through is an identity someone gets signed in as.
// Until now it had NO test coverage at all -- `identity.test.ts` exercises `identityFromClaims`,
// which takes already-verified claims, and `discoverEndpoints`, which takes an injected fetch.
// The signature, `iss` and `aud` checks in between were never executed by a test.
//
// Tokens here are signed with a generated RS256 key and served through a real JWKS endpoint, so
// `jwtVerify` does the same work it does against Keycloak, Okta or Entra. That matters because of
// the OZL-225 lesson: a permissive stand-in proves nothing. A mock that skipped signing would pass
// while a real IdP rejected us -- exactly the failure mode that cost time on the inference path.
//
// What this does NOT prove: that a real Keycloak's discovery document, claim names and group
// mapper behave as expected end to end. That still needs a live IdP (OZL-222's remaining half).

import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { verifyIdToken } from "../src/identity.js";

const ISSUER = "https://idp.corp.internal/realms/fieldos";
const CLIENT_ID = "fieldos";

let privateKey: CryptoKey;
let publicJwk: JWK;

// Serve the JWKS the way an IdP does, so `createRemoteJWKSet` fetches keys over "the network".
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "test-key" };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/jwks`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }),
          { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input as RequestInfo);
  }) as typeof fetch;
});

const endpoints = {
  authorization: `${ISSUER}/auth`,
  token: `${ISSUER}/token`,
  jwks: `${ISSUER}/jwks`,
};
const config = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s", scopes: "openid email" };

async function signToken(claims: Record<string, unknown>, over: {iss?: string; aud?: string} = {}) {
  return await new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? CLIENT_ID)
      .setSubject((claims.sub as string) ?? "user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
}

describe("verifyIdToken against real signed tokens", () => {
  it("accepts a correctly signed token and returns the identity", async () => {
    const token = await signToken({ email: "alice@corp.test" });
    const identity = await verifyIdToken(token, config, endpoints);
    expect(identity.email).toBe("alice@corp.test");
    expect(identity.subject).toBe("user-1");
    expect(identity.expiresAt).toBeInstanceOf(Date);
  });

  // THE property this function exists for. A token signed by anyone else must not authenticate.
  it("rejects a token signed by a different key", async () => {
    const attacker = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ email: "alice@corp.test", email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject("user-1")
        .setIssuedAt().setExpirationTime("5m")
        .sign(attacker.privateKey);
    await expect(verifyIdToken(forged, config, endpoints)).rejects.toThrow();
  });

  it("rejects a token from a different issuer", async () => {
    const token = await signToken({ email: "alice@corp.test" }, { iss: "https://evil.example" });
    await expect(verifyIdToken(token, config, endpoints)).rejects.toThrow();
  });

  // A token minted for a DIFFERENT client at the same IdP must not be replayable here.
  it("rejects a token minted for another audience", async () => {
    const token = await signToken({ email: "alice@corp.test" }, { aud: "some-other-app" });
    await expect(verifyIdToken(token, config, endpoints)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ email: "alice@corp.test", email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject("user-1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(privateKey);
    await expect(verifyIdToken(expired, config, endpoints)).rejects.toThrow();
  });

  // Verified signature is not enough: an unverified address would let anyone who can register
  // victim@corp at a permissive IdP sign in as that user here.
  it("rejects a validly signed token whose email is unverified", async () => {
    const token = await new SignJWT({ email: "alice@corp.test", email_verified: false })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject("user-1")
        .setIssuedAt().setExpirationTime("5m")
        .sign(privateKey);
    await expect(verifyIdToken(token, config, endpoints)).rejects.toThrow(/unverified/);
  });

  // A trailing slash on the configured issuer must not break the `iss` comparison -- operators
  // paste issuer URLs both ways, and Keycloak's own console shows one without.
  it("tolerates a trailing slash on the configured issuer", async () => {
    const token = await signToken({ email: "alice@corp.test" });
    const identity = await verifyIdToken(token, { ...config, issuer: `${ISSUER}/` }, endpoints);
    expect(identity.email).toBe("alice@corp.test");
  });

  // The org claim is read only AFTER verification, so a forged group cannot grant org access.
  it("resolves the org from a verified token", async () => {
    const token = await signToken({ email: "alice@corp.test", groups: ["/fieldos-legal"] });
    const identity = await verifyIdToken(token, config, endpoints,
        { claim: "groups", prefix: "fieldos-" });
    expect(identity.orgId).toBe("legal");
  });
});
