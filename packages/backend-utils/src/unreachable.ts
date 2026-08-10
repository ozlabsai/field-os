// Turning a runtime connection failure into something an operator can act on.
//
// When an outbound request fails below the HTTP layer, the runtime tells the calling code almost
// nothing: the thrown value is a bare `Error` whose message is an opaque reference token, with no
// `code`, no `cause`, and no mention of the address it was trying to reach. The matching workerd
// log line (`connect() blocked by restrictPeers()`) does not record the address either, so an
// operator holding both halves still cannot tell which of their configured hosts failed.
//
// The caller always knows the target, though, so the fix is to say so at the point where the URL
// is still in scope. What we deliberately do *not* do is claim a cause: a network-policy refusal
// and a DNS failure are byte-identical here, so "blocked by the allowlist" would be confidently
// wrong whenever it was really a typo in a hostname.

/** How an outbound request failed, as far as the runtime lets us tell. */
export type UnreachableKind =
  // The request never left the process: refused by the outbound network policy, or the name did
  // not resolve. These two are indistinguishable -- see `describeUnreachable`.
  | "refused-locally"
  // The request reached the network and the peer refused or dropped it. The address is permitted
  // and resolvable; something at the other end is wrong.
  | "refused-by-peer";

// The runtime's opaque failure, e.g. "internal error; reference = ks64dkbmgt5s00edfgan62rh".
// Matched on text because there is nothing else: the thrown value carries no own properties.
//
// ponytail: string match on a message the runtime does not document as stable. The test pins the
// exact strings so a workerd bump fails loudly rather than silently degrading to today's opaque
// behaviour.
const REFUSED_LOCALLY = /^internal error; reference = /;

// Thrown when the connection got out and the far side refused it. Carries `retryable: true`.
const REFUSED_BY_PEER = "Network connection lost.";

// The OpenAI SDK replaces the underlying error with this constant before we ever see it, demoting
// the runtime's message to `cause`. Without special-casing it the user is told "Connection error."
// with no indication of *what* could not be connected to.
const SDK_CONNECTION_ERROR = "Connection error.";

/**
 * Classifies an outbound-request failure, or returns null if it is not one.
 *
 * Returning null for anything unrecognised is deliberate: callers pass those through untouched, so
 * an error that already reads well is never replaced by a vaguer one.
 */
export function classifyUnreachable(err: unknown): UnreachableKind | null {
  const message = err instanceof Error ? err.message : "";
  if (REFUSED_LOCALLY.test(message)) return "refused-locally";
  if (message === REFUSED_BY_PEER || message === SDK_CONNECTION_ERROR) return "refused-by-peer";
  return null;
}

/**
 * Rewrites an outbound-request failure into a message naming `target`, or returns null if `err` is
 * not a connection failure.
 *
 * `target` is whatever the operator would recognise -- a host, a `host:port`, or a URL. It is the
 * one piece of information the runtime drops and the caller still has.
 *
 * The two cases say different things on purpose. A locally-refused request may be a network-policy
 * problem *or* a bad hostname, so the message names both possibilities rather than guessing; a
 * peer-refused request means the address was fine, so mentioning the policy there would send an
 * operator to edit an allowlist that was never the problem.
 */
export function describeUnreachable(err: unknown, target: string): string | null {
  switch (classifyUnreachable(err)) {
    case "refused-locally":
      return `Could not reach ${target}. The request failed before leaving this deployment — ` +
        `either the host could not be resolved, or this deployment's network policy does not ` +
        `permit that address.`;
    case "refused-by-peer":
      return `Reached ${target}, but the connection was refused or dropped. The service may not ` +
        `be running.`;
    default:
      return null;
  }
}
