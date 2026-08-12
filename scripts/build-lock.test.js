// The build lock (OZL-256).
//
// The property under test is mutual exclusion of a *non-atomic* critical section. That shape
// matters: a test that only checked "both calls finished" would pass against no lock at all, since
// the race is a torn read, not a crash. So each worker here empties a directory, repopulates it,
// and verifies it never observed a partial tree -- the same destroy-then-rewrite that
// `capnweb-validate build --out` performs, which is what made the real builds tear.
//
// Verified to fail without the lock: dropping withBuildLock from the child below makes
// "excludes concurrent builds of one package" fail on every run.

import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { withBuildLock } from "./build-lock.mjs";

const execFile = promisify(execFileCb);

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "build-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * One `wrangler deploy --dry-run` on a package: run the build command (capnweb-validate empties
 * the output tree, then repopulates it), then read the tree back as wrangler reads `main` and the
 * modules it imports.
 *
 * Each builder writes files tagged with its own pid. That is what makes tearing *observable*: if a
 * peer wipes and repopulates the tree mid-read, this builder sees fewer than all of its own files.
 * With identical filenames a torn read is invisible, since a peer's rewrite is indistinguishable
 * from your own -- which is the trap that made three earlier versions of this test pass while
 * proving nothing.
 */
const CHILD = `
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withBuildLock } from ${JSON.stringify(join(HERE, "build-lock.mjs"))};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const [pkgDir, lock] = [process.argv[2], process.argv[3] === "lock"];
const out = join(pkgDir, "out");
const FILES = 8;
const mine = (i) => "m" + process.pid + "_" + i + ".js";

function buildThenRead() {
  // The build command: destroy, then repopulate slowly, holding the torn state the way the real
  // one does (observed: ~0.9s empty, then a partial tree).
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(out, mine(i)), "x");
    sleep(20);
  }

  // The bundle step: read the modules back, spread over time so a peer's wipe can land mid-read.
  let lowest = FILES;
  for (let i = 0; i < 5; i++) {
    const ours = readdirSync(out).filter((f) => f.startsWith("m" + process.pid + "_")).length;
    lowest = Math.min(lowest, ours);
    sleep(20);
  }
  return lowest;
}

const seen = lock ? withBuildLock(pkgDir, buildThenRead) : buildThenRead();
process.stdout.write(String(seen));
`;

describe("build lock", () => {
  it("excludes concurrent builds of one package", async () => {
    const pkgDir = mkdtempSync(join(root, "par-"));
    const child = join(pkgDir, "child.mjs");
    writeFileSync(child, CHILD);

    // Spawn all four first, then await them, so they genuinely overlap. execFile (async) rather
    // than a shell with background jobs: `sh -c '... & wait'` can return before the redirected
    // output files are flushed, which made this test itself intermittently read an empty file.
    const runs = Array.from({ length: 4 }, () =>
        execFile(process.execPath, [child, pkgDir, "lock"], { encoding: "utf8" }));
    const counts = (await Promise.all(runs)).map((r) => Number(r.stdout));

    // Each builder must have seen a complete tree throughout its read. A torn read sees fewer.
    for (const n of counts) {
      assert.equal(n, 8, `a builder observed a partial tree (${counts.join(", ")})`);
    }
  });

  it("survives a stale-break racing an acquisition", async () => {
    // The release and stale-break paths both remove the lock directory, and acquisition renames a
    // staging directory *onto* that same path. A plain rmSync(recursive, force) walks the tree and
    // then rmdir's it, so an acquisition landing mid-walk makes the rmdir throw ENOTEMPTY --
    // `force` swallows ENOENT, not that. This reproduced on merged main as a gate failure, while
    // the mutual-exclusion case above stayed green: exclusion held, the *cleanup* was what broke.
    const pkgDir = mkdtempSync(join(root, "stalerace-"));

    // The window is the microseconds between rimraf's walk and its rmdir, so the builders here
    // take the lock in a tight loop rather than doing the slow build the case above uses -- many
    // fast release/acquire handoffs is what makes the collision likely rather than theoretical.
    const spinner = join(pkgDir, "spin.mjs");
    writeFileSync(spinner, `
import { withBuildLock } from ${JSON.stringify(join(HERE, "build-lock.mjs"))};
for (let i = 0; i < 150; i++) withBuildLock(process.argv[2], () => {});
process.stdout.write("done");
`);
    const runs = Array.from({ length: 8 }, () =>
        execFile(process.execPath, [spinner, pkgDir], { encoding: "utf8" }));
    const results = await Promise.allSettled(runs);

    const crashed = results.filter((r) => r.status === "rejected");
    assert.equal(crashed.length, 0,
        `a builder crashed instead of taking the lock: ${crashed.map((c) => c.reason?.message).join("; ")}`);
  });

  it("is reentrant within one process", () => {
    const pkgDir = mkdtempSync(join(root, "re-"));
    // A nested acquisition must not deadlock: same pid, so it proceeds.
    const got = withBuildLock(pkgDir, () => withBuildLock(pkgDir, () => "inner"));
    assert.equal(got, "inner");
    // And the outermost frame released, so the lock is free again.
    assert.equal(withBuildLock(pkgDir, () => "after"), "after");
  });

  it("breaks a lock whose owner is gone", () => {
    const pkgDir = mkdtempSync(join(root, "stale-"));
    // A pid that cannot be running: forge the leftovers of a SIGKILLed build. Without the
    // liveness check this call would block until the stale timeout, turning a random failure
    // into a deterministic hang.
    const lockDir = join(pkgDir, ".wrangler", "build.lock");
    execFileSync("/bin/mkdir", ["-p", lockDir]);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 0x7ffffff0, at: Date.now() }));

    assert.equal(withBuildLock(pkgDir, () => "recovered"), "recovered");
  });

  it("releases the lock when the build throws", () => {
    const pkgDir = mkdtempSync(join(root, "throw-"));
    assert.throws(() => withBuildLock(pkgDir, () => { throw new Error("build failed"); }),
        /build failed/);
    // A failed build must not wedge every later one.
    assert.equal(withBuildLock(pkgDir, () => "still works"), "still works");
  });
});
