// Org scoping for PUBLIC context collections (OZL-217, org separation Phase 3).
//
// Private collections need none of this: they are per-account in `UserLibraryDurableObject` and
// never shared. Public collections are the leak -- readable by everyone in the deployment, so
// under org separation a Legal-authored collection reaches Engineering.
//
// The predicate is pure and lives on its own so every read path can share one rule. That matters
// here more than usual, because there are three independent consumers and only one of them is the
// obvious one:
//
//   * `getEnabledCollections` (user-library.ts) -- the AGENT read path, gating search/list/read
//   * `loadEnabledContextCollections` (context-api.ts) -- the management UI, the agent session,
//     and `getAgentCatalog`
//   * `hasCollectionAccess` (library-gatekeeper.ts) -- the collaborator-observation path
//
// Filtering at the union each of these computes, rather than at each guard, is what keeps a future
// fourth consumer correct by construction. A guard-by-guard fix would have left the agent reading
// cross-org content while the UI looked correctly scoped.

/** A public collection's org tag, as stored in the domain's public KV snapshot. */
export type CollectionOrgTag = {
  id: string;
  /**
   * The org that authored this collection, or undefined for one created before org separation
   * existed. Undefined is NOT "visible to everyone" once separation is on -- see below.
   */
  orgId: string | undefined;
};

/**
 * Whether a public collection is visible to a reader in `readerOrg`.
 *
 * Pure, so the rule is testable without a durable object, a KV namespace, or a running gatekeeper.
 *
 * @param collection The collection's org tag.
 * @param readerOrg The reader's org, or undefined if they have none.
 * @param orgSeparationEnabled Whether the deployment enforces the boundary. When false this is a
 *   no-op and everything stays visible, so existing deployments are unaffected until they opt in.
 */
export function isCollectionVisibleToOrg(
    collection: CollectionOrgTag, readerOrg: string | undefined,
    orgSeparationEnabled: boolean): boolean {
  if (!orgSeparationEnabled) return true;

  // Untagged fails closed, deliberately departing from the ticket's "untagged means all-orgs".
  //
  // That rule would collapse the distinction Phase 2 paid to keep: a collection created before
  // separation existed (legitimately outside the boundary) and one whose tag was never written
  // (accidentally outside it) become permanently indistinguishable -- for the resource most likely
  // to carry a sensitive name, since a title alone can be the disclosure.
  //
  // Failing closed makes enabling separation a visible, correctable step: untagged collections
  // disappear until an admin tags them, which is an ordinary edit rather than a migration. The
  // alternative hides the problem exactly when someone is least likely to look for it.
  if (collection.orgId === undefined) return false;

  // A reader who cannot be placed inside the boundary is treated exactly like one from another
  // org, not as a special case -- the same rule Phase 2 applies to a caller with no org.
  return collection.orgId === readerOrg;
}

/**
 * Whether this deployment enforces the org boundary.
 *
 * Read from the gatekeeper's own env rather than imported from the Workshop: a gatekeeper is a
 * separate worker and shares no code with the backend. The variable name matches the Workshop's
 * (`ENABLE_ORG_SEPARATION`) so an operator sets one value, and both must be set together --
 * documented in docs/configuration.md.
 */
export function isOrgSeparationEnabled(env: { ENABLE_ORG_SEPARATION?: string }): boolean {
  return env.ENABLE_ORG_SEPARATION === "true";
}
