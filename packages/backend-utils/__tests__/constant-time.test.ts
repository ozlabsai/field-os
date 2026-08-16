import { describe, expect, it } from "vitest";

import { constantTimeEqual } from "../src/constant-time.js";

// This suite runs under workerd (vitest-pool-workers), where `crypto.subtle.timingSafeEqual`
// exists — verified, it is a function here. So the cases below exercise the workerd path by
// default, and `withoutTimingSafeEqual` shadows it to reach the XOR fallback. Both branches are
// covered deliberately: the fallback is the reason this helper is shared at all, and testing only
// the default branch would leave it unexercised while still reading as full coverage.
// `@cloudflare/workers-types` declares `timingSafeEqual` as a required member of SubtleCrypto,
// so intersecting it with an optional one collapses to `never`. Omit it, then re-add as optional.
type MaybeTimingSafe = Omit<SubtleCrypto, "timingSafeEqual"> & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};

// `timingSafeEqual` lives on SubtleCrypto's *prototype*, not the instance (verified: own=false,
// proto=true), so `delete crypto.subtle.timingSafeEqual` is a no-op and the native path keeps
// running. An own property set to undefined shadows the inherited one; deleting that own property
// restores it. The first version of this helper used the plain delete and silently tested the
// native path twice — two deliberate breaks passed before this was fixed.
function withoutTimingSafeEqual(body: () => void): void {
  const subtle = crypto.subtle as MaybeTimingSafe;
  Object.defineProperty(subtle, "timingSafeEqual", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    if (subtle.timingSafeEqual !== undefined) throw new Error("failed to shadow timingSafeEqual");
    body();
  } finally {
    delete subtle.timingSafeEqual;
  }
}

describe("constantTimeEqual", () => {
  it("accepts identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("rejects strings differing at any position", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false); // last byte
    expect(constantTimeEqual("abc123", "Abc123")).toBe(false); // first byte
    expect(constantTimeEqual("abc123", "abd123")).toBe(false); // middle byte
  });

  it("rejects strings of differing length, including a prefix", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });

  // The mcp-shared copy compared `charCodeAt` over UTF-16 code units rather than UTF-8 bytes.
  // Pinned so a future "simplification" back to string comparison is caught.
  it("compares as UTF-8 bytes, not UTF-16 code units", () => {
    expect(constantTimeEqual("é", "é")).toBe(true);
    expect(constantTimeEqual("é", "e")).toBe(false);
    // Same UTF-16 length (2 units), different UTF-8 byte length (4 vs 2).
    expect(constantTimeEqual("😀", "ab")).toBe(false);
    // The discriminating case. "A" (U+0041) and "Ł" share a low byte, so comparing
    // UTF-16 code units truncated to a byte calls these EQUAL - two distinct secrets
    // matching. Only a UTF-8 byte comparison rejects them.
    expect(constantTimeEqual("A", "Ł")).toBe(false);
    expect(constantTimeEqual("é", "ǩ")).toBe(false);
  });

  // The whole matrix again with the workerd extension removed, so the fallback is held to the
  // same contract rather than merely existing.
  it("behaves identically on the XOR fallback", () => {
    withoutTimingSafeEqual(() => {
      expect(constantTimeEqual("abc123", "abc123")).toBe(true);
      expect(constantTimeEqual("", "")).toBe(true);
      expect(constantTimeEqual("abc123", "abc124")).toBe(false);
      expect(constantTimeEqual("abc123", "Abc123")).toBe(false);
      expect(constantTimeEqual("abc", "abcd")).toBe(false);
      expect(constantTimeEqual("é", "é")).toBe(true);
      expect(constantTimeEqual("é", "e")).toBe(false);
      expect(constantTimeEqual("😀", "ab")).toBe(false);
      expect(constantTimeEqual("A", "Ł")).toBe(false);
    });
  });

  it("uses the runtime's timingSafeEqual when present", () => {
    const subtle = crypto.subtle as MaybeTimingSafe;
    const had = "timingSafeEqual" in subtle;
    let called = 0;
    subtle.timingSafeEqual = () => {
      called++;
      return true;
    };
    try {
      // Bytes differ; a `true` result can only come from the injected implementation.
      expect(constantTimeEqual("aaa", "bbb")).toBe(true);
      expect(called).toBe(1);
    } finally {
      if (!had) delete subtle.timingSafeEqual;
    }
  });
});
