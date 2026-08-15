// Per-account management API exposed to the library iframe. Users manage their own private
// collections; admins also manage public collections. Everything is sharing-domain scoped.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  ContextApi, ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_GIT_BRANCH, EnabledCollectionInfo,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import {
  listPublicCollectionsFromKv, metadataToSummary,
} from "./collection-kv.js";
import { domainName } from "./domain.js";
import { isCollectionVisibleToOrg, isOrgSeparationEnabled } from "./org-scoping.js";

// Collections visible to this account's agents.
//
// `readerOrg` scopes the public half (OZL-291). This is the SECOND union computing owned ∪ public —
// the agent's own gating union is `getEnabledCollections` in user-library.ts, fixed separately in
// OZL-217. Both must filter: this one feeds the management iframe and `getAgentCatalog`, so leaving
// it unscoped would hide cross-org collections from the agent's reads while still showing it their
// titles, and show them in full in the UI.
export async function loadEnabledContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>,
    readerOrg: string | undefined,
    orgSeparationEnabled: boolean): Promise<EnabledCollectionInfo[]> {
  let [owned, publicCollections] = await Promise.all([
    userLibrary.listOwnedCollections(),
    listPublicCollectionsFromKv(env, domain),
  ]);
  // Owned collections are private and per-account, so they need no org filter — only the public
  // half crosses accounts.
  publicCollections = publicCollections.filter(
      c => isCollectionVisibleToOrg(c, readerOrg, orgSeparationEnabled));

  let result: EnabledCollectionInfo[] = [];
  let seen = new Set<string>();
  for (let collection of owned) {
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "private",
      lastUpdated: collection.lastUpdated,
    });
  }
  for (let collection of publicCollections) {
    if (seen.has(collection.id)) continue;
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "public",
      lastUpdated: collection.lastUpdated,
    });
  }
  return result;
}

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    private isAdmin: boolean,
    private orgId: string | undefined,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private registries: DurableObjectNamespace<LibraryRegistryDurableObject>,
  ) {
    super();
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  // Whether this account owns the private collection.
  async #ownsPrivate(collectionId: string): Promise<boolean> {
    return this.#userLib().hasOwned(collectionId);
  }

  // Whether a public collection is in this viewer's org (OZL-291).
  //
  // Reads the tag from the domain's public snapshot rather than the collection DO: the snapshot is
  // the same source every other read path filters on, so a collection can never be visible in a
  // listing and denied by a guard (or the reverse). An id absent from the snapshot is not public,
  // and the callers below only consult this once `isPublic` says otherwise.
  async #publicCollectionInOrg(collectionId: string): Promise<boolean> {
    let entry = (await listPublicCollectionsFromKv(this.env, this.domain))
        .find(c => c.id === collectionId);
    if (!entry) return false;
    return isCollectionVisibleToOrg(entry, this.orgId, isOrgSeparationEnabled(this.env));
  }

  // Read: own private collections, or a public collection in this viewer's org.
  async #assertCanRead(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (owns) return;
    if (isPublic && await this.#publicCollectionInOrg(collectionId)) return;
    throw new Error("Collection not found or you don't have access.");
  }

  // Write: own private collections, or public collections for admins — but only within the admin's
  // own org. Admins are deployment-wide and flat (`ADMINS` env list), so without the org dimension
  // one org's admin could edit another org's public collection: the boundary would scope reads
  // while leaving writes global.
  async #assertCanWrite(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (owns) return;
    if (isPublic && this.isAdmin && await this.#publicCollectionInOrg(collectionId)) return;
    throw new Error("Collection not found or you don't have access.");
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  #assertAdmin(): void {
    if (!this.isAdmin) throw new Error("Admin access required.");
  }

  async getViewerInfo(): Promise<{
    isAdmin: boolean;
    supportsGitCollections: boolean;
    orgSeparationEnabled: boolean;
    orgId?: string;
    knownOrgs: string[];
  }> {
    let orgSeparationEnabled = isOrgSeparationEnabled(this.env);
    return {
      isAdmin: this.isAdmin,
      supportsGitCollections: !!this.env.ARTIFACTS,
      orgSeparationEnabled,
      orgId: this.orgId,
      // Suggestions, not a directory. The deployment stores no list of orgs -- an org is whatever
      // an IdP group claim yields -- so the only honest source is the tags already in use. Scoped
      // to what this viewer can see, so the picker never discloses another org's existence.
      knownOrgs: orgSeparationEnabled && this.isAdmin ? await this.#knownOrgs() : [],
    };
  }

  // Distinct org tags on public collections visible to this viewer, sorted for a stable picker.
  async #knownOrgs(): Promise<string[]> {
    let orgs = new Set<string>();
    for (let entry of await listPublicCollectionsFromKv(this.env, this.domain)) {
      if (entry.orgId && isCollectionVisibleToOrg(entry, this.orgId, true)) orgs.add(entry.orgId);
    }
    if (this.orgId) orgs.add(this.orgId);
    return [...orgs].toSorted((left, right) => left.localeCompare(right));
  }

  // --- Collection management ---

  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
    orgId?: string,
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (source !== "web" && source !== "git") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }

    // The org tag, and the one place the OZL-291 policy is enforced: the admin names the target org
    // at creation (option A) rather than the collection inheriting one implicitly.
    //
    // Required when separation is on, because an untagged public collection fails closed and would
    // be invisible to everyone the moment it was created — a silent no-op that reads as a bug. The
    // UI prefills the admin's own org, so this is a confirm rather than a recall for the common
    // case; a deployment-wide collection has no representation here and must be created per org.
    let tag: string | undefined;
    if (visibility === "public" && isOrgSeparationEnabled(this.env)) {
      tag = orgId?.trim();
      if (!tag) {
        throw new Error(
            "This deployment separates orgs, so a public collection must name the org it belongs " +
            "to. Untagged public collections are visible to no one.");
      }
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      orgId: tag,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    // Initialize before indexing; if this fails, nothing is reachable yet.
    metadata = await this.#collection(id).initialize(metadata, this.domain, visibility === "private" ? this.accountId : "");

    // Private collections live in the owner's library; public ones live in the domain registry.
    try {
      if (visibility === "public") {
        await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
      } else {
        await this.#userLib().createOwnedCollection(id, title, description, icon);
      }
    } catch (err) {
      // Indexing failed; delete the now-unreachable collection.
      await this.#collection(id).deleteSelf().catch(() => {});
      throw err;
    }
    return metadata;
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#collection(collectionId).updateMetadata(options);
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    // Only collection owners/admins can manually trigger an artifact
    // sync. Read requests from non-owners/admins may trigger a
    // stale-while-revalidate sync in the background, but they do not
    // have direct control over this.
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    await this.#collection(collectionId).syncArtifactSource();
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).createGitToken();
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).listGitTokens();
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).revokeGitToken(tokenId);
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteSelf();
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    try {
      let [meta, owns, isPublic] = await Promise.all([
        this.#collection(collectionId).getMetadata(),
        this.#ownsPrivate(collectionId),
        this.#registry().isPublic(collectionId),
      ]);
      if (!meta.id || (!owns && !isPublic)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).listContextDocuments(prefix);
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).getContextDocument(path);
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).putContextDocument(path, doc);
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteContextDocument(path);
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).moveContextDocument(fromPath, toPath);
  }

  // --- Listing & access ---

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    return loadEnabledContextCollections(
        this.env, this.domain, this.#userLib(), this.orgId, isOrgSeparationEnabled(this.env));
  }

  async canWriteContextCollection(collectionId: string): Promise<boolean> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    return owns || (isPublic && this.isAdmin);
  }
}
