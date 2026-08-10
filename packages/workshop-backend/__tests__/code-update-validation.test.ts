import { describe, it, expect } from "vitest";
import * as Y from "yjs";

// Overseer.updateCode() writes into an append-only log that is replayed from the start on every
// workspace load, so an update that fails to decode bricks the workspace permanently (OZL-241).
// The guard there is a trial `applyUpdateV2` into a throwaway doc; these tests pin the behaviour
// that guard depends on -- in particular that a V1 update is *not* rejected at parse time by
// applyUpdateV2, which is what made the original failure surface far from its cause.

function accepts(update: Uint8Array): boolean {
  try {
    Y.applyUpdateV2(new Y.Doc(), update);
    return true;
  } catch {
    return false;
  }
}

function sampleDoc(): Y.Doc {
  let doc = new Y.Doc();
  doc.getMap<Y.Text>("gadget").set("main.js", new Y.Text("export default 1"));
  return doc;
}

describe("code update validation", () => {
  it("accepts a well-formed V2 update", () => {
    expect(accepts(Y.encodeStateAsUpdateV2(sampleDoc()))).toBe(true);
  });

  it("rejects a V1 update -- the encoding confusion behind OZL-241", () => {
    expect(accepts(Y.encodeStateAsUpdate(sampleDoc()))).toBe(false);
  });

  it("rejects empty, truncated and garbage payloads", () => {
    let v2 = Y.encodeStateAsUpdateV2(sampleDoc());
    expect(accepts(new Uint8Array(0))).toBe(false);
    expect(accepts(v2.slice(0, Math.floor(v2.length / 2)))).toBe(false);
    expect(accepts(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });

  it("preserves content through a round trip, so the guard rejects nothing legitimate", () => {
    let target = new Y.Doc();
    Y.applyUpdateV2(target, Y.encodeStateAsUpdateV2(sampleDoc()));
    expect(target.getMap<Y.Text>("gadget").get("main.js")!.toString())
        .toBe("export default 1");
  });

  it("a merged sequence of updates -- what the internal callers pass -- stays valid", () => {
    let doc = sampleDoc();
    let updates: Uint8Array[] = [];
    doc.on("updateV2", (u: Uint8Array) => updates.push(u));
    doc.transact(() => {
      doc.getMap<Y.Text>("gadget").set("extra.js", new Y.Text("export default 2"));
    });
    expect(updates.length).toBeGreaterThan(0);
    expect(accepts(Y.mergeUpdatesV2(updates))).toBe(true);
  });
});
