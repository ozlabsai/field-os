// Constant-time comparison, shared by every connector that checks a nonce or secret.
//
// Previously forked four ways (gatekeeper-github, gatekeeper-homeassistant, gatekeeper-oidc,
// mcp-shared). Two of those copies called `crypto.subtle.timingSafeEqual` with no fallback, so
// their comparison paths could not be unit-tested off workerd — which is why neither had tests.

/**
 * Compares two strings without leaking their contents through timing.
 *
 * `crypto.subtle.timingSafeEqual` is a workerd extension rather than standard WebCrypto, so it is
 * absent under a plain Node test runner. The fallback is a real constant-time comparison, not a
 * test stub: it accumulates the XOR of every byte and branches only on length, which is already
 * public. Production runs the workerd path.
 *
 * Inputs are compared as UTF-8 bytes, so this is safe for values that are not hex nonces.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(bufA, bufB);

  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}
