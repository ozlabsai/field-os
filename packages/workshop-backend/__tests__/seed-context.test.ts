import { describe, expect, it } from "vitest";
import { SEED_CONTEXT } from "../src/generated/seed-context.js";

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
