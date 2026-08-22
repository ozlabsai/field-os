// @vitest-environment jsdom

// An expired session used to produce five independent console errors and an app that looked
// broken, because `classifyRpcError` returned 'auth' and nothing consumed it. These pin the
// consumption: the class announces, and only that class does.

import { afterEach, describe, expect, it, vi } from "vitest";

import { logRpcFailure } from "./rpcErrors";
import { SESSION_EXPIRED_EVENT } from "./sessionExpiryBus";

function countEventsFrom(run: () => void): number {
  let seen = 0;
  const listener = () => { seen++; };
  window.addEventListener(SESSION_EXPIRED_EVENT, listener);
  try {
    run();
  } finally {
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logRpcFailure announces an expired session", () => {
  it("announces on an auth-class failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = countEventsFrom(() => {
      logRpcFailure("Failed to check onboarding status:", new Error("invalid session token"));
    });
    expect(seen).toBe(1);
  });

  it("announces once per caller, so the listener is what collapses a storm", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The real failure mode: five callers fail simultaneously on the same dead session.
    const seen = countEventsFrom(() => {
      for (const site of ["onboarding", "walkthrough", "sidebar", "models", "branding"]) {
        logRpcFailure(`Failed to load ${site}:`, new Error("invalid session token"));
      }
    });
    expect(seen).toBe(5);
  });

  it("stays silent for every other class", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const seen = countEventsFrom(() => {
      // connection: the reconnect owns this, and logging out mid-reconnect would be destructive.
      logRpcFailure("conn", new Error("WebSocket connection lost"));
      // do-reset: the Worker already retried; the session is fine.
      logRpcFailure("reset", Object.assign(new Error("nope"), { retryable: true }));
      // other: an ordinary application error must never end the session.
      logRpcFailure("other", new Error("something went wrong"));
    });
    expect(seen).toBe(0);
  });

  it("still reports transience the same way", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Auth is not transient: callers must not treat it as a skip-the-toast retry.
    expect(logRpcFailure("auth", new Error("invalid session token"))).toBe(false);
  });
});
