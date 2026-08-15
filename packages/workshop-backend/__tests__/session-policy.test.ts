import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IDLE_MINUTES, DEFAULT_MAX_LIFETIME_HOURS,
  getSessionCeiling, resolveSessionPolicy, sessionBoundsView, sessionExpiry,
} from "../src/auth/session-policy.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Only the two session vars matter here; cast keeps the fixtures readable.
const env = (vars: Record<string, string> = {}) => vars as unknown as Cloudflare.Env;

describe("getSessionCeiling", () => {
  it("falls back to the defaults when unset", () => {
    expect(getSessionCeiling(env())).toEqual({
      lifetimeMs: DEFAULT_MAX_LIFETIME_HOURS * HOUR,
      idleMs: DEFAULT_MAX_IDLE_MINUTES * MINUTE,
    });
  });

  it("reads the configured ceilings", () => {
    expect(getSessionCeiling(env({
      SESSION_MAX_LIFETIME_HOURS: "4",
      SESSION_MAX_IDLE_MINUTES: "15",
    }))).toEqual({ lifetimeMs: 4 * HOUR, idleMs: 15 * MINUTE });
  });

  // A typo must not switch the control off, so non-positive and unparseable values fall back to
  // the default rather than being honoured as "never expires".
  it.each(["0", "-1", "nonsense", ""])("falls back for %o", raw => {
    expect(getSessionCeiling(env({ SESSION_MAX_LIFETIME_HOURS: raw })).lifetimeMs)
        .toBe(DEFAULT_MAX_LIFETIME_HOURS * HOUR);
  });
});

describe("resolveSessionPolicy", () => {
  const ceiling = env({ SESSION_MAX_LIFETIME_HOURS: "12", SESSION_MAX_IDLE_MINUTES: "60" });

  it("uses the ceiling when the admin has set nothing", () => {
    expect(resolveSessionPolicy(ceiling, {}))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });

  it("lets the admin tighten within the ceiling", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 }))
        .toEqual({ lifetimeMs: 8 * HOUR, idleMs: 30 * MINUTE });
  });

  // The security property: a compromised admin session must not be able to weaken expiry.
  it("clamps an admin trying to exceed the ceiling", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 720, sessionIdleMinutes: 10_080 }))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });

  // Lowering the env ceiling must tighten deployments that already stored a looser admin value,
  // without requiring the stored config to be rewritten.
  it("re-clamps stored admin values when the ceiling is lowered", () => {
    const lowered = env({ SESSION_MAX_LIFETIME_HOURS: "2", SESSION_MAX_IDLE_MINUTES: "5" });
    expect(resolveSessionPolicy(lowered, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 }))
        .toEqual({ lifetimeMs: 2 * HOUR, idleMs: 5 * MINUTE });
  });

  it("treats non-positive admin values as unset", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 0, sessionIdleMinutes: -5 }))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });
});

describe("sessionExpiry", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const policy = { lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE };

  it("uses our lifetime when no IdP expiry is supplied", () => {
    expect(sessionExpiry(policy, now)).toEqual(new Date("2026-08-10T00:00:00Z"));
  });

  it("honours a shorter IdP expiry", () => {
    expect(sessionExpiry(policy, now, new Date("2026-08-09T13:00:00Z")))
        .toEqual(new Date("2026-08-09T13:00:00Z"));
  });

  // A permissive or misconfigured IdP must not be able to mint an effectively immortal session.
  it("clamps an IdP expiry beyond our ceiling", () => {
    expect(sessionExpiry(policy, now, new Date("2027-08-09T12:00:00Z")))
        .toEqual(new Date("2026-08-10T00:00:00Z"));
  });
});

// ---------------------------------------------------------------------------
// OZL-226: what the admin panel is shown.
//
// The panel displays three numbers per bound -- the env ceiling, the admin's stored choice, and
// what is actually in force -- because the stored value and the effective one are NOT the same:
// clamping happens at read time, so lowering the ceiling tightens sessions without rewriting
// config. A panel echoing back only the stored value would display a number that is not in effect,
// which is precisely the confusion this read-out exists to prevent.
//
// `sessionBoundsView` is the pure projection behind `AdminSettings.getSettings()`, kept here so the
// rule is testable without a Durable Object.
describe("session bounds as the admin panel sees them", () => {
  const ceiling = env({ SESSION_MAX_LIFETIME_HOURS: "12", SESSION_MAX_IDLE_MINUTES: "60" });

  it("reports the ceiling as effective when the admin has chosen nothing", () => {
    expect(sessionBoundsView(ceiling, {})).toEqual({
      ceilingLifetimeHours: 12, ceilingIdleMinutes: 60,
      lifetimeHours: undefined, idleMinutes: undefined,
      effectiveLifetimeHours: 12, effectiveIdleMinutes: 60,
    });
  });

  it("reports the admin's choice as effective when it tightens", () => {
    let view = sessionBoundsView(ceiling, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 });
    expect(view.lifetimeHours).toBe(8);
    expect(view.effectiveLifetimeHours).toBe(8);
    expect(view.effectiveIdleMinutes).toBe(30);
  });

  // THE case the read-out exists for. A stored value above the ceiling stays stored (so raising the
  // ceiling later restores the admin's intent) but is NOT in force. Showing only `lifetimeHours`
  // here would tell an admin their sessions last 720 hours when they in fact last 12.
  it("distinguishes a stored above-ceiling value from the value in force", () => {
    let view = sessionBoundsView(ceiling, { sessionLifetimeHours: 720, sessionIdleMinutes: 10_080 });
    expect(view.lifetimeHours).toBe(720);
    expect(view.effectiveLifetimeHours).toBe(12);
    expect(view.idleMinutes).toBe(10_080);
    expect(view.effectiveIdleMinutes).toBe(60);
  });

  // Lowering the ceiling must move the effective value without touching the stored one.
  it("re-reports effective values when the ceiling is lowered", () => {
    let lowered = env({ SESSION_MAX_LIFETIME_HOURS: "2", SESSION_MAX_IDLE_MINUTES: "5" });
    let view = sessionBoundsView(lowered, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 });
    expect(view.ceilingLifetimeHours).toBe(2);
    expect(view.lifetimeHours).toBe(8);
    expect(view.effectiveLifetimeHours).toBe(2);
  });
});
