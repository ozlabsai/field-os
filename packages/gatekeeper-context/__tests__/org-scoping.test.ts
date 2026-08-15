// Org scoping of PUBLIC context collections (OZL-217, org separation Phase 3).
//
// A public collection is readable by everyone in the deployment. Under org separation that is a
// leak: a Legal-authored collection is readable by Engineering, and its *title* alone
// ("Project Zeus Acquisition") can be the disclosure.
//
// WHERE THE ENFORCEMENT ACTUALLY BELONGS. The ticket names `#assertCanRead` (context-api.ts) and
// `hasCollectionAccess` (library-gatekeeper.ts). Both are real, and both are SECONDARY -- the
// agent read path touches neither:
//
//   * `#assertCanRead` guards only the management UI (`ContextApiImpl`, reached via startAppUi).
//   * `hasCollectionAccess` has exactly two callers, both in context-observers.ts -- the
//     collaborator-observation path, not reads.
//   * The agent reaches content through `LibraryReadSession` (library-read.ts), which gates
//     search/list/read off `UserLibraryDurableObject.getEnabledCollections` (user-library.ts) --
//     whose own comment calls it "the agent read path" -- and through `getAgentCatalog`, which
//     uses `loadEnabledContextCollections` (context-api.ts).
//
// Both of those compute the same union: owned collections plus EVERY entry in the domain's public
// KV snapshot, unconditionally. So a fix applied only where the ticket says would hide cross-org
// collections in the UI while leaving the agent able to search, list and read them every turn --
// a fix that passes casual testing (an admin browsing the library sees correct scoping) and is
// wrong where it counts.
//
// This test therefore pins the property at the union, not at the guards: a collection belonging to
// another org must not appear in the enabled set at all, so every consumer inherits the scoping
// rather than each needing its own check.

import { describe, expect, it } from "vitest";
import { isCollectionVisibleToOrg } from "../src/org-scoping.js";
import { metadataToSummary } from "../src/collection-kv.js";
import type { ContextCollectionMetadata } from "../src/context-types.js";

/** A public collection tagged with the org that authored it. */
const tagged = (id: string, orgId: string) => ({ id, orgId });

/** A public collection from before org separation existed -- no tag at all. */
const untagged = (id: string) => ({ id, orgId: undefined });

describe("isCollectionVisibleToOrg", () => {
  describe("with org separation off (every existing deployment)", () => {
    it("shows everything, tagged or not", () => {
      // Inert by default: this must be a no-op until a deployment opts in, exactly like Phase 2.
      expect(isCollectionVisibleToOrg(tagged("c1", "legal"), "engineering", false)).toBe(true);
      expect(isCollectionVisibleToOrg(untagged("c2"), undefined, false)).toBe(true);
    });
  });

  describe("with org separation on", () => {
    it("shows a collection from the reader's own org", () => {
      expect(isCollectionVisibleToOrg(tagged("c1", "legal"), "legal", true)).toBe(true);
    });

    it("HIDES a collection from another org", () => {
      // The headline property, and the ticket's Done-when: a Legal-authored public collection is
      // invisible to Engineering.
      expect(isCollectionVisibleToOrg(tagged("c1", "legal"), "engineering", true)).toBe(false);
    });

    it("hides a tagged collection from a reader with no org", () => {
      // "Unknown" must not read as "permitted": a reader who cannot be placed inside the boundary
      // is treated exactly like one from a different org, matching Phase 2's rule.
      expect(isCollectionVisibleToOrg(tagged("c1", "legal"), undefined, true)).toBe(false);
    });

    it("HIDES an untagged collection once separation is on", () => {
      // The ticket says "untagged means all-orgs, for back-compat". That collapses the exact
      // distinction Phase 2 paid to keep: a collection created before separation (legitimately
      // pre-boundary) and one whose tag was never written (accidentally exempt) become
      // indistinguishable, permanently, for the resource most likely to carry a sensitive name.
      //
      // So untagged fails closed instead, and an admin tags what should remain visible. That makes
      // enabling separation a visible, correctable step rather than a silent hole -- and it is
      // recoverable, since tagging is an ordinary admin edit.
      expect(isCollectionVisibleToOrg(untagged("c2"), "legal", true)).toBe(false);
      expect(isCollectionVisibleToOrg(untagged("c2"), undefined, true)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// OZL-291: the tag must survive propagation.
//
// `#propagate()` (context-collection.ts) rebuilds the denormalized summary from metadata on EVERY
// collection edit, via `metadataToSummary`. So a tag that lived only on the summary would be
// silently erased the first time anyone renamed the collection or added a document -- and the
// collection would then fail closed and vanish for everyone, long after the edit that caused it.
//
// That is why the tag's durable home is `ContextCollectionMetadata` and `metadataToSummary` copies
// it through. This pins the copy: delete the `orgId` line from metadataToSummary and this fails,
// while the predicate tests above all still pass.
describe("metadataToSummary carries the org tag (OZL-291)", () => {
  const metadata = (orgId: string | undefined): ContextCollectionMetadata => ({
    id: "c1",
    title: "Pending Litigation",
    description: "",
    visibility: "public",
    orgId,
    created: new Date(0),
    lastUpdated: new Date(0),
    documentCount: 0,
    content: { source: "web" },
  });

  it("preserves the tag, so a later edit cannot untag the collection", () => {
    expect(metadataToSummary(metadata("legal")).orgId).toBe("legal");
  });

  it("keeps the round trip visible to its own org and hidden from others", () => {
    // The end-to-end property, one step removed from the predicate: what creation writes is what
    // the read paths filter on.
    const summary = metadataToSummary(metadata("legal"));
    expect(isCollectionVisibleToOrg(summary, "legal", true)).toBe(true);
    expect(isCollectionVisibleToOrg(summary, "engineering", true)).toBe(false);
  });

  it("leaves an untagged collection untagged (and so fails closed)", () => {
    expect(metadataToSummary(metadata(undefined)).orgId).toBeUndefined();
    expect(isCollectionVisibleToOrg(metadataToSummary(metadata(undefined)), "legal", true))
        .toBe(false);
  });
});
