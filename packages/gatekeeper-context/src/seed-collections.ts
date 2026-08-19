// Installs the deployment's bundled sample collections (OZL-311), so a new user has something for
// the agent to read instead of an empty Context Library.
//
// WHY THIS RUNS ON AN ADMIN'S FIRST VISIT rather than at deploy. A public collection requires
// admin (`createContextCollection` asserts it), and `isAdmin` arrives only through
// `startAppUi({ isAdmin })` -- supplied fresh per open, deliberately never read from props, which
// are fixed at provisioning and go stale. There is no backend-callable path, and adding one would
// let a gatekeeper create domain-wide content with authority no human granted -- the shape
// CLAUDE.md's capability rule exists to prevent ("a gatekeeper must never assert its own
// ambience"). So the human admin *is* the authority: seeding is something an admin does by
// opening the library, not something the deployment does to itself.
//
// The cost is that a deployment with no admin visit has no seeded content. That is the correct
// trade: no content is a visible absence, whereas a gatekeeper granting itself authority is an
// invisible one.

import { SEED_CONTEXT, type SeedContextCollection } from "./generated/seed-context.js";
import { VENDOR_ID, type ContextCollectionSummary } from "./context-types.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context.seed", vendorId: VENDOR_ID,
});

/**
 * The write surface `installSeedCollections` needs, named structurally rather than imported as a
 * class so this file does not depend on the whole API implementation (and so tests can drive it
 * with a stub).
 */
export interface SeedInstaller {
  createContextCollection(
    title: string, description: string, visibility: "public" | "private", icon?: string,
  ): Promise<{ id: string }>;
  putContextDocument(
    collectionId: string, path: string, doc: { description: string; body: string },
  ): Promise<void>;
}

/**
 * Marks a collection as one this deployment seeded, and which one.
 *
 * Stored in the collection's description rather than a parallel index: the registry is a list of
 * summaries with no room for private metadata, and a second source of truth would drift from the
 * collections it claims to describe. The marker is invisible in normal use because it is appended
 * after the curated description.
 */
function seedMarker(collectionKey: string): string {
  return `​[seeded:${collectionKey}]`;
}

/** Whether an existing public collection was installed from `collectionKey`. */
function isSeededAs(summary: { description?: string }, collectionKey: string): boolean {
  return (summary.description ?? "").includes(seedMarker(collectionKey));
}

/**
 * Install any bundled collection this domain does not already have.
 *
 * Idempotent by `collectionKey`, not by title: an admin who renames a seeded collection keeps
 * their rename instead of getting a duplicate on the next visit. Deliberately does **not** update
 * documents in a collection that already exists -- an admin's edits to sample content are theirs,
 * and silently reverting them on every visit would be worse than shipping stale samples.
 *
 * Never throws. Seeding is a convenience on a path whose actual job is opening the library; a
 * failure here must not deny the admin their UI.
 *
 * @param api The admin-scoped write surface (see {@link SeedInstaller}).
 * @param existing Public collections already in this domain.
 * @param isAdmin Whether the caller holds admin authority. Non-admins install nothing.
 * @returns How many collections were created.
 */
export async function installSeedCollections(
  api: SeedInstaller,
  existing: ContextCollectionSummary[],
  isAdmin: boolean,
): Promise<number> {
  if (!isAdmin || SEED_CONTEXT.length === 0) return 0;

  let created = 0;
  for (const seed of SEED_CONTEXT) {
    if (existing.some(summary => isSeededAs(summary, seed.collectionKey))) continue;
    try {
      created += await installOne(api, seed) ? 1 : 0;
    } catch (err) {
      // One bad collection must not deny the deployment the others, and must not deny the admin
      // the library they actually asked for.
      logger.error("failed to install seed collection", {
        event: "context.seed.install.failed", collectionKey: seed.collectionKey, error: err,
      });
    }
  }
  return created;
}

async function installOne(api: SeedInstaller, seed: SeedContextCollection): Promise<boolean> {
  const { id: collectionId } = await api.createContextCollection(
    seed.title,
    `${seed.description} ${seedMarker(seed.collectionKey)}`,
    "public",
    seed.icon,
  );

  for (const doc of seed.documents) {
    await api.putContextDocument(collectionId, doc.path, {
      description: doc.description,
      body: doc.body,
    });
  }

  logger.info("installed seed collection", {
    event: "context.seed.install.ok",
    collectionKey: seed.collectionKey,
    documentCount: seed.documents.length,
  });
  return true;
}
