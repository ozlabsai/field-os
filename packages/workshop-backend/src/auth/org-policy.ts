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

import { AdminOrgSeparation } from "@gadgets/workshop-shared/api";
import { hasAuthGatekeepers, isPasswordAuthEnabled } from "./config.js";

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

/**
 * Why a deployment's org-separation configuration cannot work as the operator intended.
 *
 * `null` means coherent — either separation is off, or it is on with an identity provider that can
 * actually supply the claim it depends on.
 *
 * Not an error type: enforcement stays correct in every case below (it fails closed, which is the
 * point). This exists because "correct" and "what the operator meant" have come apart, and nothing
 * in the denial path can say so — a denied collaborator sees the same result whether the boundary
 * is working or the deployment can never resolve an org for anyone.
 */
export type OrgSeparationConfigIssue =
    /**
     * Separation is on but no auth gatekeeper is allowlisted, so `orgId` is never written for
     * anyone (`loginOrCreateViaGatekeeper` in user.ts is the only writer). Every user is
     * permanently org-less: owners still reach their own workspaces, but no collaborator can open
     * anyone else's. That is a deployment-wide halt to sharing, configured by accident.
     */
    | "no-identity-provider"
    /**
     * Separation is on with an IdP, but password auth is also live, so the deployment has two
     * classes of user: SSO users carrying an org, and password users permanently without one.
     * Collaboration then works among SSO users and silently fails for everyone else.
     *
     * Legitimate if deliberate (break-glass admins, service accounts), which is why this is
     * reported and not refused — set DISABLE_PASSWORD_AUTH=true to make it go away.
     */
    | "password-auth-users-have-no-org";

/**
 * Diagnose the deployment's org-separation configuration; see {@link OrgSeparationConfigIssue}.
 *
 * Deliberately reports rather than refuses. Sign-in has the same shape one layer down —
 * `isPasswordAuthEnabled` ignores DISABLE_PASSWORD_AUTH when it would strand every user rather
 * than honouring it — but refusing here would mean an IdP outage could stop the Worker from
 * booting, trading a sharing outage for a total one. Enforcement already fails closed; what was
 * missing is anyone being told why.
 *
 * @param separationEnabled Whether the org boundary is enforced ({@link isOrgSeparationEnabled}).
 * @param hasIdentityProvider Whether any auth gatekeeper is allowlisted (`hasAuthGatekeepers`).
 * @param passwordAuthEnabled Whether username/password login is live (`isPasswordAuthEnabled`).
 */
export function diagnoseOrgSeparationConfig(
    separationEnabled: boolean, hasIdentityProvider: boolean, passwordAuthEnabled: boolean):
    OrgSeparationConfigIssue | null {
  if (!separationEnabled) return null;
  if (!hasIdentityProvider) return "no-identity-provider";
  if (passwordAuthEnabled) return "password-auth-users-have-no-org";
  return null;
}

/**
 * The admin panel's view of org separation. Mirrors `sessionBoundsView` in session-policy.ts: a
 * read-only projection of env-driven authorization config, surfaced so an operator can see what is
 * in force without reading the deployment's env.
 *
 * Takes `env` rather than booleans because it is a composition root, not a decision — the pure
 * predicates above stay env-free so the decision table remains testable without a runtime.
 */
export function orgSeparationView(env: Cloudflare.Env): AdminOrgSeparation {
  const enabled = isOrgSeparationEnabled(env);
  const issue = diagnoseOrgSeparationConfig(
      enabled, hasAuthGatekeepers(env), isPasswordAuthEnabled(env));
  return {
    enabled,
    crossOrgSharingAllowed: isCrossOrgSharingAllowed(env),
    ...(issue ? { issue } : {}),
  };
}
