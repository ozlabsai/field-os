import { describe, expect, it } from "vitest";
import { SEED_CONTEXT } from "../src/generated/seed-context.js";
import { installSeedCollections } from "../src/seed-collections.js";

// Asserts the *generated* seed data rather than the generator script, matching
// format-blueprints.test.ts: the generated module is what ships, and a rule that held in the
// script but not in its output would be a test that proves nothing.
//
// A deployment may legitimately ship no seed content at all (SEED_CONTEXT_DIR pointed elsewhere,
// or emptied), so these assert the *shape* of whatever is bundled instead of requiring a
// particular collection to exist. Hard-coding "sample-field-reports" here would fail every fork
// that replaced it, which is the supported case.
describe("bundled seed context", () => {
  it("gives every collection a non-empty key, title and description", () => {
    for (const collection of SEED_CONTEXT) {
      expect(collection.collectionKey.trim()).not.toBe("");
      expect(collection.title.trim()).not.toBe("");
      expect(collection.description.trim()).not.toBe("");
    }
  });

  it("keeps collection keys unique", () => {
    // Installation is keyed on collectionKey, so a duplicate would have two source directories
    // fighting over one collection with the last writer winning, silently.
    const keys = SEED_CONTEXT.map(c => c.collectionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ships no empty collection", () => {
    // An empty collection installs nothing but still appears in the Context Library, which reads
    // as a broken deployment rather than an absent one.
    for (const collection of SEED_CONTEXT) {
      expect(collection.documents.length).toBeGreaterThan(0);
    }
  });

  it("gives every document a description and a body", () => {
    // The description is the file's first non-empty line and is *removed* from the body. A
    // document whose body is empty means the file was a single line, and installing it would put
    // the same sentence in both fields.
    for (const collection of SEED_CONTEXT) {
      for (const doc of collection.documents) {
        expect(doc.description.trim(), `${collection.collectionKey}/${doc.path}`).not.toBe("");
        expect(doc.body.trim(), `${collection.collectionKey}/${doc.path}`).not.toBe("");
      }
    }
  });

  it("does not repeat the description as the first line of the body", () => {
    for (const collection of SEED_CONTEXT) {
      for (const doc of collection.documents) {
        const firstLine = doc.body.split("\n").find(line => line.trim() !== "") ?? "";
        expect(firstLine.trim(), `${collection.collectionKey}/${doc.path}`)
            .not.toBe(doc.description.trim());
      }
    }
  });

  it("keeps document paths unique within a collection", () => {
    for (const collection of SEED_CONTEXT) {
      const paths = collection.documents.map(d => d.path);
      expect(new Set(paths).size, collection.collectionKey).toBe(paths.length);
    }
  });
});

// The installer's decision logic, driven with a stub write surface. The real
// `createContextCollection` asserts admin itself; these cover the layer above it -- what gets
// installed, what is skipped, and what happens when one collection fails.
describe("installSeedCollections", () => {
  type Created = { title: string; description: string; visibility: string };

  function stub(failOn?: string) {
    const created: Created[] = [];
    const documents: Array<{ collectionId: string; path: string }> = [];
    return {
      created,
      documents,
      api: {
        async createContextCollection(
          title: string, description: string, visibility: "public" | "private",
        ) {
          if (failOn && title.includes(failOn)) throw new Error("stubbed failure");
          created.push({ title, description, visibility });
          return { id: `id-${created.length}` };
        },
        async putContextDocument(collectionId: string, path: string) {
          documents.push({ collectionId, path });
        },
      },
    };
  }

  it("installs nothing for a non-admin", async () => {
    const s = stub();
    expect(await installSeedCollections(s.api, [], false)).toBe(0);
    expect(s.created).toHaveLength(0);
  });

  it("installs every bundled collection into an empty domain, as public", async () => {
    const s = stub();
    const count = await installSeedCollections(s.api, [], true);
    expect(count).toBe(SEED_CONTEXT.length);
    expect(s.created.every(c => c.visibility === "public")).toBe(true);
    expect(s.documents).toHaveLength(
        SEED_CONTEXT.reduce((n, c) => n + c.documents.length, 0));
  });

  it("is idempotent: a second visit installs nothing", async () => {
    const first = stub();
    await installSeedCollections(first.api, [], true);
    // Feed the first run's output back as the domain's existing collections.
    const existing = first.created.map((c, i) => ({
      id: `id-${i}`, title: c.title, description: c.description,
      visibility: "public" as const, documentCount: 0, lastUpdated: new Date(),
    }));
    const second = stub();
    expect(await installSeedCollections(second.api, existing as never, true)).toBe(0);
    expect(second.created).toHaveLength(0);
  });

  it("keys on collectionKey, so a renamed collection is not reinstalled", async () => {
    // An admin who renames sample content keeps their rename; matching on title would hand them a
    // duplicate on the next visit.
    const first = stub();
    await installSeedCollections(first.api, [], true);
    const renamed = first.created.map((c, i) => ({
      id: `id-${i}`, title: "Renamed by an admin", description: c.description,
      visibility: "public" as const, documentCount: 0, lastUpdated: new Date(),
    }));
    const second = stub();
    expect(await installSeedCollections(second.api, renamed as never, true)).toBe(0);
  });

  it("does not let one failing collection deny the others", async () => {
    if (SEED_CONTEXT.length < 2) return;   // nothing to prove with a single bundled collection
    const s = stub(SEED_CONTEXT[0].title);
    const count = await installSeedCollections(s.api, [], true);
    expect(count).toBe(SEED_CONTEXT.length - 1);
  });
});
