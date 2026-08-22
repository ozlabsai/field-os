// Lets any RPC caller report an auth-class failure without knowing that auth state exists.
//
// Five independent callers (onboarding, walkthrough, sidebar workspaces, models, vendor branding)
// each meet the same expired session and each logged its own unrelated-looking error, leaving the
// user an app that looks broken rather than a session that ended. They all pass through
// `logRpcFailure`, which is the chokepoint -- but that helper is pure logging with no React
// context, and giving a logging function a side effect on global auth state would be the wrong
// layer. So it announces, and AuthProvider (which holds `logout`) decides.
//
// Same decoupling as commandPaletteBus and walkthroughBus, for the same reason: producer and
// consumer sit on opposite sides of the tree.
export const SESSION_EXPIRED_EVENT = 'gadgets:session-expired'

/**
 * Announce that an RPC failed because the session is no longer valid.
 *
 * Safe to call repeatedly: several callers usually fail together, and the listener collapses them.
 */
export function notifySessionExpired(): void {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
}
