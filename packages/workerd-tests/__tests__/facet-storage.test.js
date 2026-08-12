// Tier-1: where a Durable Object facet's storage actually lives on disk, and whether it is
// portable out of the parent it hangs off.
//
// WHY THIS EXISTS (OZL-239). A gadget runs as a *facet* of its workspace DO
// (`overseer.ts:2409`), which makes it in-process by construction — and a runaway gadget therefore
// wedges the whole deployment, because workerd serves everything on one event loop. The fix is to
// move gadget execution into a separate OS process, and OZL-239 gated that on a question it said
// "deserves a spike before committing": what happens to existing gadget state when a gadget stops
// being a facet?
//
// This pins the answer, which is that the premise was wrong: a facet ALREADY has its own database
// file, and that file is byte-identical in format to an ordinary DO's. Migration is a file
// copy plus an index fixup, not a data-model conversion. If a future workerd bump changes the
// layout, this suite is the canary — the whole plan rests on it (see the 2026-08-12 log entry).
//
// The on-disk shape, for a parent DO whose id hashes to <parentHash>:
//
//     <parentHash>.sqlite      the parent's own storage
//     <parentHash>.1.sqlite    facet #1
//     <parentHash>.2.sqlite    facet #2
//     <parentHash>.facets      a small name->slot manifest
//
// RED-CHECKED. Each assertion was confirmed able to fail. Note especially the cross-process case:
// the first version of that check read back the right value for the WRONG reason — the probe
// passed `?name=` where the fixture reads `?id=`, so the positive and negative runs both hit the
// default id and returned identical data. It looked exactly like proof. The negative control below
// is what caught it, and it is not optional.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { resetDoStorage, startWorkerd } from "../src/harness.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture-facet-storage");
const STORAGE_DIR = join(FIXTURE_DIR, "dodata");
const UNIQUE_KEY = "ozl239-probe-parent"; // must match fixture.capnp's durableObjectNamespaces

/** @type {{base: string, stop: () => void} | undefined} */
let workerd;
/** @type {string[]} */
let tempDirs = [];

afterEach(() => {
  workerd?.stop();
  workerd = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** Files workerd wrote for this uniqueKey, excluding sqlite's -wal/-shm sidecars. */
function storageFiles() {
  // Unsorted: every caller matches by regex rather than position, and sorting here would only
  // pick a fight between oxlint's no-array-sort and this package's pre-ES2023 `lib` target,
  // which has no `toSorted()`.
  return readdirSync(join(STORAGE_DIR, UNIQUE_KEY))
      .filter(/** @param {string} name */ name =>
          !name.endsWith("-wal") && !name.endsWith("-shm"));
}

/** @param {string} path */
async function get(path) {
  if (!workerd) throw new Error("workerd is not running");
  const response = await fetch(`${workerd.base}${path}`);
  return /** @type {any} */ (await response.json());
}

test("a facet's storage is a separate file from its parent's", async () => {
  resetDoStorage(STORAGE_DIR);
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, extraArgs: ["--experimental"] });

  // Distinct values, so which file holds what is unambiguous. Asserting only that two files exist
  // would pass even if both held the same data.
  await get("/parent-write?value=parent-value-1");
  await get("/child-write?value=child-value-1");

  // Liveness first: a facet that never ran would leave no file, and "no file" must not read as
  // "separate file".
  expect((await get("/parent-read")).value).toBe("parent-value-1");
  expect((await get("/child-read")).value).toBe("child-value-1");

  workerd.stop();
  workerd = undefined;

  const files = storageFiles();
  const parentDb = files.find(/** @param {string} f */ f => /^[0-9a-f]{64}\.sqlite$/.test(f));
  const facetDb = files.find(/** @param {string} f */ f => /^[0-9a-f]{64}\.1\.sqlite$/.test(f));
  const manifest = files.find(/** @param {string} f */ f => f.endsWith(".facets"));

  // Thrown rather than expect()ed, so the later uses narrow: a missing file means the premise is
  // already gone, and the message names what was actually on disk.
  if (!parentDb || !facetDb || !manifest) {
    throw new Error(`expected parent, facet and manifest files, got: ${files.join(", ")}`);
  }
  // The facet hangs off the parent's hash rather than owning a uniqueKey of its own -- which is
  // why moving one out means minting a new identity for it.
  expect(facetDb.slice(0, 64)).toBe(parentDb.slice(0, 64));

  // The manifest maps the facet NAME we passed to ctx.facets.get() onto the numeric slot. A
  // migration has to preserve or rewrite exactly this.
  expect(readFileSync(join(STORAGE_DIR, UNIQUE_KEY, manifest), "latin1")).toContain("child");
}, 60_000);

test("a separate process can open a facet's file as an ordinary Durable Object", async () => {
  // The crux of the OZL-239 spike. If this holds, "migration path for existing gadget state" is a
  // file copy rather than a data conversion.
  resetDoStorage(STORAGE_DIR);
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, extraArgs: ["--experimental"] });
  await get("/child-write?value=child-value-1");
  expect((await get("/child-read")).value).toBe("child-value-1");
  workerd.stop();
  workerd = undefined;

  const files = storageFiles();
  const parentDb = files.find(/** @param {string} f */ f => /^[0-9a-f]{64}\.sqlite$/.test(f));
  const facetDb = files.find(/** @param {string} f */ f => /^[0-9a-f]{64}\.1\.sqlite$/.test(f));
  // Assert rather than narrow: if either file is absent the premise of this test is already gone,
  // and a skipped copy would otherwise surface later as a confusing null read.
  if (!parentDb || !facetDb) throw new Error(`expected parent and facet dbs, got ${files.join(", ")}`);

  // Rename the FACET's file to the filename a normal, non-facet namespace expects for the same
  // uniqueKey + id. Nothing else is converted.
  const migrated = join(FIXTURE_DIR, "dodata-migrated");
  tempDirs.push(migrated);
  rmSync(migrated, { recursive: true, force: true });
  mkdirSync(join(migrated, UNIQUE_KEY), { recursive: true });
  // The -wal sidecar too: workerd leaves recent writes there rather than checkpointing on exit,
  // so copying the .sqlite alone moves an EMPTY database and the read comes back null. That is a
  // migration hazard in its own right -- an operator copying only *.sqlite would silently lose
  // the most recent state -- so the sidecars are part of the answer, not an artifact of the test.
  for (const [from, to] of [[facetDb, parentDb], [`${facetDb}-wal`, `${parentDb}-wal`]]) {
    const src = join(STORAGE_DIR, UNIQUE_KEY, from);
    if (existsSync(src)) copyFileSync(src, join(migrated, UNIQUE_KEY, to));
  }

  workerd = await startWorkerd({
    fixtureDir: FIXTURE_DIR,
    configFile: "fixture-migrated.capnp", // same uniqueKey, plain DO namespace, no facets
    extraArgs: ["--experimental"],
  });

  // The facet's value, read back through an ordinary ctx.storage.get() in a different process.
  expect((await get("/?id=the-parent")).value).toBe("child-value-1");

  // The negative control, and the reason this test is trustworthy: a different id hashes to a
  // different filename, for which no file was placed. Without this, a fixture that ignored `id`
  // would return the right value for the wrong reason and read as a pass.
  const missing = await get("/?id=no-such-actor");
  expect(missing.value).toBeNull();
}, 60_000);

test("ctx.facets.clone() copies a facet's storage", async () => {
  // The in-protocol alternative to an offline file copy: a migration primitive that works while
  // the deployment is running.
  resetDoStorage(STORAGE_DIR);
  workerd = await startWorkerd({ fixtureDir: FIXTURE_DIR, extraArgs: ["--experimental"] });

  await get("/child-write?value=child-value-1");
  await get("/child-clone?dst=child-clone");

  // Read through the CLONE's name, not the source's -- reading the source back would pass even if
  // clone() had done nothing at all.
  expect((await get("/clone-read?name=child-clone")).value).toBe("child-value-1");

  workerd.stop();
  workerd = undefined;

  // A second slot on disk, so the copy is real storage rather than an alias.
  expect(storageFiles().some(
      /** @param {string} f */ f => /^[0-9a-f]{64}\.2\.sqlite$/.test(f))).toBe(true);
}, 60_000);
