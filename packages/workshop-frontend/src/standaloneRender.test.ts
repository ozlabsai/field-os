// The standalone-render rule decides whether a page renders WITHOUT AuthProvider. Getting it wrong
// in the permissive direction is not a cosmetic bug: the tree below it calls useAuthenticatedApi(),
// which throws. That is OZL-312 — `isSignup` was missing the `!isAuthenticated` guard that
// `isBlueprint` already had, so an authenticated user briefly rendered outside the provider.

import { describe, expect, it } from "vitest";

import { isStandaloneRender } from "./standaloneRender";

describe("isStandaloneRender", () => {
  it("is standalone for signed-out visitors to public routes", () => {
    expect(isStandaloneRender("/signup", false)).toBe(true);
    expect(isStandaloneRender("/blueprint/abc", false)).toBe(true);
  });

  it("is NOT standalone once authenticated, on either public route", () => {
    // The regression. Signup writes the token and only then assigns window.location.href, so
    // `isAuthenticated` flips while pathname is still "/signup" — and a standalone render there
    // puts the routed component outside AuthProvider.
    expect(isStandaloneRender("/signup", true)).toBe(false);
    expect(isStandaloneRender("/blueprint/abc", true)).toBe(false);
  });

  it("is never standalone on a private route, signed in or out", () => {
    for (const authed of [true, false]) {
      expect(isStandaloneRender("/", authed)).toBe(false);
      expect(isStandaloneRender("/workspaces", authed)).toBe(false);
      expect(isStandaloneRender("/outputs", authed)).toBe(false);
    }
  });

  it("does not treat a path merely containing 'signup' as the signup route", () => {
    expect(isStandaloneRender("/workspaces/signup-flow", false)).toBe(false);
  });
});
