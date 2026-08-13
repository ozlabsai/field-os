// The org-separation decision table (OZL-216).
//
// `isOrgAccessAllowed` is pure precisely so this exists: every row below is a plain function call,
// with no workspace, no user DO, no running runtime and no mocking. The rows that matter most --
// fail-closed on `orgUnknown`, and legacy workspaces staying reachable -- are the ones that would
// otherwise need a whole stack to reach.
//
// Owners never reach this predicate at all: enforcement lives inside `open()`'s non-owner branch,
// so a user can always open their own workspaces whatever the org state. That is deliberate, and
// it is what makes a misconfigured deployment recoverable rather than a lockout.

import { describe, expect, it } from "vitest";
import {
  isCrossOrgSharingAllowed, isOrgAccessAllowed, isOrgSeparationEnabled,
} from "../src/auth/org-policy";

/** A workspace stamped with an org, i.e. created while separation was configured. */
const stamped = (orgId: string) => ({ orgId, orgUnknown: false });

/** A workspace created before org separation existed. Legitimately exempt. */
const LEGACY = { orgId: undefined, orgUnknown: false };

/** A workspace whose stamp was attempted and FAILED. Must never be treated as exempt. */
const FAILED_STAMP = { orgId: undefined, orgUnknown: true };

describe("isOrgAccessAllowed", () => {
  describe("with cross-org sharing denied (the default)", () => {
    it("allows a caller from the same org", () => {
      expect(isOrgAccessAllowed(stamped("legal"), "legal", false)).toBe(true);
    });

    it("denies a caller from a different org", () => {
      expect(isOrgAccessAllowed(stamped("legal"), "engineering", false)).toBe(false);
    });

    it("denies a caller with no org at all", () => {
      // "Unknown" must not read as "permitted": the caller cannot be shown to be inside the
      // boundary, so they are treated exactly like a wrong-org caller.
      expect(isOrgAccessAllowed(stamped("legal"), undefined, false)).toBe(false);
    });

    it("allows a legacy workspace that predates org separation", () => {
      // Enforcing here would strand every workspace created before the feature existed.
      expect(isOrgAccessAllowed(LEGACY, "legal", false)).toBe(true);
      expect(isOrgAccessAllowed(LEGACY, undefined, false)).toBe(true);
    });

    it("FAILS CLOSED when the stamp failed at creation", () => {
      // The obligation carried from the Phase 1 review, and the reason `orgUnknown` exists at all.
      // Without it, anything that made one RPC fail at creation would mint a permanently
      // boundary-exempt workspace indistinguishable from a legacy one.
      expect(isOrgAccessAllowed(FAILED_STAMP, "legal", false)).toBe(false);
      expect(isOrgAccessAllowed(FAILED_STAMP, undefined, false)).toBe(false);
    });
  });

  describe("with cross-org sharing allowed", () => {
    it("allows a caller from a different org", () => {
      expect(isOrgAccessAllowed(stamped("legal"), "engineering", true)).toBe(true);
    });

    it("allows a caller with no org", () => {
      expect(isOrgAccessAllowed(stamped("legal"), undefined, true)).toBe(true);
    });

    it("still FAILS CLOSED on a failed stamp", () => {
      // `allowCrossOrgSharing` widens which *orgs* may collaborate. It says nothing about a
      // workspace whose org was never established, so it must not rescue that case -- otherwise
      // the single knob a deployment is most likely to turn on would silently disable the
      // fail-closed guarantee entirely.
      expect(isOrgAccessAllowed(FAILED_STAMP, "legal", true)).toBe(false);
    });
  });
});

describe("env flags", () => {
  // Both default OFF/deny, and both read only the exact string "true" -- so a typo, an empty
  // string, or the literal "false" leaves the boundary in its safe state rather than silently
  // enabling or disabling it.
  const env = (vars: Record<string, string>) => vars as unknown as Cloudflare.Env;

  it("leaves org separation off unless explicitly enabled", () => {
    expect(isOrgSeparationEnabled(env({}))).toBe(false);
    expect(isOrgSeparationEnabled(env({ ENABLE_ORG_SEPARATION: "false" }))).toBe(false);
    expect(isOrgSeparationEnabled(env({ ENABLE_ORG_SEPARATION: "1" }))).toBe(false);
    expect(isOrgSeparationEnabled(env({ ENABLE_ORG_SEPARATION: "true" }))).toBe(true);
  });

  it("denies cross-org sharing unless explicitly allowed", () => {
    expect(isCrossOrgSharingAllowed(env({}))).toBe(false);
    expect(isCrossOrgSharingAllowed(env({ ALLOW_CROSS_ORG_SHARING: "false" }))).toBe(false);
    expect(isCrossOrgSharingAllowed(env({ ALLOW_CROSS_ORG_SHARING: "TRUE" }))).toBe(false);
    expect(isCrossOrgSharingAllowed(env({ ALLOW_CROSS_ORG_SHARING: "true" }))).toBe(true);
  });
});
