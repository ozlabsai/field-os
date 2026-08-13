// Org separation: the deployment-wide authorization boundary between organizations sharing one
// installation (OZL-216, design in `plans/org-separation.md`).
//
// Lives here, beside the sign-in configuration, rather than in `AdminConfig` — deliberately, and
// for the reason `admin-config.ts` states in its own header: authentication/authorization config
// "stays env-var driven so it can't be changed by a compromised admin session". `AdminConfig` is
// writable by any live admin session (`#isAdmin()` in server.ts compares a username against the
// `ADMINS` env list), so putting either of these knobs there would let one hijacked admin session
// -- or an XSS in the admin UI -- open the boundary over *other users'* workspaces, deployment
// wide, with no redeploy. That is a materially different blast radius from the presentation
// toggles `AdminConfig` otherwise holds, and it is precisely what the env-var rule exists to stop.

/**
 * Whether the org boundary is enforced at all. OFF by default, so the enforcement in this file is
 * inert until a deployment opts in.
 *
 * The flag exists so Phase 1's observability can be verified against a real IdP *before* anything
 * is denied, and so the rollout is not a one-way door: turning it off must restore the previous
 * behaviour exactly. That reversibility is why an org denial must not delete the caller's
 * workspace listing — see `crossOrgAccessDenied` in `@gadgets/workshop-shared/api`.
 */
export function isOrgSeparationEnabled(env: Cloudflare.Env): boolean {
  return (env as { ENABLE_ORG_SEPARATION?: string }).ENABLE_ORG_SEPARATION === "true";
}

/**
 * Whether a workspace may be opened by a collaborator from a different org. Default DENY, which is
 * the entire point of the boundary; a deployment that wants cross-org collaboration opts back in.
 *
 * Only consulted when {@link isOrgSeparationEnabled} is true.
 */
export function isCrossOrgSharingAllowed(env: Cloudflare.Env): boolean {
  return (env as { ALLOW_CROSS_ORG_SHARING?: string }).ALLOW_CROSS_ORG_SHARING === "true";
}

/**
 * A workspace's org stamp, as recorded at creation.
 *
 * `orgId` absent with `orgUnknown` false means the workspace predates org separation, which is
 * legitimately exempt. `orgUnknown` true means the stamp was *attempted and failed* — see
 * `#stampOrg` in overseer.ts, which records the failure rather than failing creation.
 */
export type WorkspaceOrgStamp = {
  orgId: string | undefined;
  orgUnknown: boolean;
};

/**
 * Whether a non-owner in `callerOrg` may open a workspace carrying `stamp`.
 *
 * Pure, so the whole decision table is testable without a workspace, a user DO, or a running
 * runtime. Callers supply the inputs; nothing here reads storage or env.
 *
 * The owner is never subject to this — enforcement lives inside the non-owner branch, so a user
 * can always reach their own workspaces regardless of org state. That is what keeps a
 * misconfiguration recoverable rather than a lockout.
 *
 * @param stamp The workspace's org stamp.
 * @param callerOrg The caller's current org, or undefined if they have none (never signed in
 *   through an org-carrying gatekeeper, or the deployment resolves no org for them).
 * @param allowCrossOrg Whether the deployment permits cross-org collaboration.
 */
export function isOrgAccessAllowed(
    stamp: WorkspaceOrgStamp, callerOrg: string | undefined, allowCrossOrg: boolean): boolean {
  // Fail closed on a failed stamp. An absent `orgId` otherwise has two causes that look identical
  // -- "created before org separation" (exempt by design) and "we failed to read the creator's
  // org" (exempt by accident) -- and anything that made that one RPC fail at creation would
  // otherwise mint a permanently boundary-exempt workspace. `orgUnknown` is the only thing that
  // distinguishes them, so it must deny. Owners are unaffected (see above), and an admin can clear
  // the flag by re-stamping.
  if (stamp.orgUnknown) return false;

  // No stamp at all: a legacy workspace, created before the boundary existed. Exempt by design --
  // enforcing here would strand every workspace that predates the feature.
  if (stamp.orgId === undefined) return true;

  // Same org: the ordinary allow, and the only case that passes on its own merits.
  if (stamp.orgId === callerOrg) return true;

  // Everything left is a boundary crossing, and they collapse to one rule rather than two.
  //
  // A caller with NO org (`undefined`) is treated exactly like a caller from a *different* org --
  // not as a special case. They cannot be shown to be inside the boundary, so on a security
  // boundary "unknown" must not read as "permitted". It is deliberately not a separate, stricter
  // branch: a deployment that has opted into cross-org sharing has said this boundary is not one
  // it wants enforced, and denying an org-less caller while permitting a wrong-org one would be
  // incoherent -- strictly less safe callers would get strictly more access.
  return allowCrossOrg;
}
