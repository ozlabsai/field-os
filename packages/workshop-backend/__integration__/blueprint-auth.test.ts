// Blueprints require a session (OZL-231 / OZL-223).
//
// `getBlueprint` and `downloadBlueprint` used to sit on `PublicApi`, reachable by id alone. The
// doc comment argued "knowing the ID is sufficient, since a blueprint is 'just data'" -- but a
// blueprint is a snapshot of a workspace's code (schemas, API shapes, internal terminology), and
// the id was not uniformly capability-grade: the shipped format blueprints are literally
// `format.document`, `format.spreadsheet` and `format.slides`, so the deployment's own set was
// enumerable by guessing. That is an insecure direct object reference (OWASP A01), and the fix is
// to require a session rather than to rely on the id as a secret.
//
// These tests pin the boundary from the outside: the methods must be absent from the
// unauthenticated surface and present on the authenticated one. Deliberately NOT tested here is
// org scoping -- blueprints remain deployment-wide by design, and any signed-in user may read any
// blueprint. Making that a per-org boundary is a separate decision (OZL-223) that this does not take.

import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function authenticate(publicApi: RpcStub<PublicApi>): Promise<RpcStub<AuthenticatedApi>> {
  const name = username("bp");
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return await publicApi.authenticate(token);
}

describe("blueprint reads require a session", () => {
  it("does not expose getBlueprint or downloadBlueprint on the unauthenticated surface", async () => {
    using publicApi = await connect();

    // Cast away the type so the test exercises the *runtime* surface. The compiler already
    // rejects these (they were moved off PublicApi), but a compile error is not evidence that an
    // anonymous caller is refused -- only calling it is.
    const anonymous = publicApi as unknown as RpcStub<AuthenticatedApi>;

    // Asserted on the *reason*, not merely that it rejected. A bare `.rejects.toThrow()` passes
    // for the wrong reason: with the methods restored to PublicApi they resolve to `null` in a
    // test deployment where no blueprint is installed, and an assertion that only checks "did not
    // resolve with data" cannot tell the two apart. Verified by probe -- the pre-fix behaviour is
    // `{ ok: null }`, not a rejection -- so the property under test is that the method is *absent
    // from the surface*, which capnweb reports by name.
    await expect(anonymous.getBlueprint("format.document"))
      .rejects.toThrow(/'getBlueprint' is not a function/);
    await expect(anonymous.downloadBlueprint("format.document"))
      .rejects.toThrow(/'downloadBlueprint' is not a function/);
  });

  // The negative control. Without it, a backend that had simply deleted the methods would pass the
  // test above while breaking the feature entirely.
  it("still serves them to a signed-in caller", async () => {
    using publicApi = await connect();
    using authenticated = await authenticate(publicApi);

    // A guessable id, on purpose: this is exactly the value that was anonymously readable before,
    // and it must still resolve for someone holding a session.
    const blueprint = await authenticated.getBlueprint("format.document");

    // Null is an acceptable answer (the format blueprints are only present once the generated
    // bundle has been installed); a rejection is not. The property under test is reachability.
    if (blueprint !== null) {
      expect(blueprint.id).toBe("format.document");
    }
  });

  it("rejects an unknown id the same way for a signed-in caller", async () => {
    using publicApi = await connect();
    using authenticated = await authenticate(publicApi);

    // Absence is reported as null rather than as an error, so a caller cannot distinguish
    // "no such blueprint" from "not allowed" -- there is nothing to distinguish, since every
    // signed-in caller may read every blueprint.
    expect(await authenticated.getBlueprint("definitely-not-a-real-blueprint-id")).toBeNull();
  });
});
