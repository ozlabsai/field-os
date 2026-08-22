// @vitest-environment jsdom

// OZL-313: a real user sent a message that went nowhere. The chain was that onboarding persisted
// the NO_AGENT sentinel when the deployment had no models yet, and that sentinel permanently
// defeats the "fall back to the first configured model" behaviour below -- so every later message
// went out with no model, silently.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getStoredSelectedModel,
  persistSelectedModel,
  NO_AGENT_OPTION_VALUE,
} from "./modelSelection";

const models = [{ id: "a" }, { id: "b" }] as Parameters<typeof getStoredSelectedModel>[0];

beforeEach(() => localStorage.clear());

describe("getStoredSelectedModel", () => {
  it("falls back to the first model when nothing is stored", () => {
    expect(getStoredSelectedModel(models)).toBe("a");
  });

  it("honours a stored model that still exists", () => {
    persistSelectedModel("b");
    expect(getStoredSelectedModel(models)).toBe("b");
  });

  it("falls back when the stored model is gone", () => {
    localStorage.setItem("lastSelectedModel", "removed");
    expect(getStoredSelectedModel(models)).toBe("a");
  });

  it("honours an explicit No-agent choice, which is why it must not be written by accident", () => {
    persistSelectedModel(null);
    expect(localStorage.getItem("lastSelectedModel")).toBe(NO_AGENT_OPTION_VALUE);
    // The sentinel outranks the fallback -- deliberately, and the reason OZL-313 was permanent
    // rather than a one-off: once written it survives models appearing later.
    expect(getStoredSelectedModel(models)).toBeNull();
  });

  it("returns null when the deployment genuinely has no models", () => {
    expect(getStoredSelectedModel([])).toBeNull();
  });
});

// A sentinel written before OZL-313 was fixed came from onboarding running with no models
// configured, not from a user declining inference -- and left them unanswered forever with no way
// to know a fix had shipped. The two cases are told apart by a marker written alongside an
// explicit pick; clearing indiscriminately would silently override a real "No agent" choice, which
// is a different bug rather than a fix.
describe("migrating a pre-fix sentinel", () => {
  it("clears an unmarked sentinel so the fallback can resolve a model", () => {
    localStorage.setItem("lastSelectedModel", NO_AGENT_OPTION_VALUE);   // no marker: pre-fix
    expect(getStoredSelectedModel(models)).toBe("a");
    // Cleared, not merely ignored -- so it cannot resurface on a later read.
    expect(localStorage.getItem("lastSelectedModel")).toBeNull();
  });

  it("honours a marked sentinel, which is a deliberate choice", () => {
    persistSelectedModel(null);
    expect(getStoredSelectedModel(models)).toBeNull();
    expect(getStoredSelectedModel(models)).toBeNull();   // and stays honoured on re-read
  });

  it("drops the marker once a model is chosen", () => {
    persistSelectedModel(null);
    persistSelectedModel("b");
    expect(getStoredSelectedModel(models)).toBe("b");
  });

  it("still returns null after migration when there is nothing to fall back to", () => {
    localStorage.setItem("lastSelectedModel", NO_AGENT_OPTION_VALUE);
    expect(getStoredSelectedModel([])).toBeNull();
  });
});
