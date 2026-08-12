// A cross-process lock around a package's `wrangler deploy` build output.
//
// WHY THIS EXISTS (OZL-256). Eight packages declare, in wrangler.jsonc, both
//
//     "main":          ".wrangler/validate/src/server.ts"
//     "build.command": "... capnweb-validate build --out .wrangler/validate"
//
// -- a *fixed* path that the build command rewrites and that wrangler then reads as its bundle
// input. `capnweb-validate build` is not atomic: it empties the tree before repopulating it.
// Observed on workshop-backend, sampling every 150ms through one build:
//
//     files=0  (~0.9s)  ->  files=26  ->  files=36
//
// So a second `wrangler deploy --dry-run` running in the same package during that window reads a
// tree that is empty or half-written. That produced both of the symptoms this issue was filed for,
// which are one race observed at two instants:
//
//   - `.wrangler/validate/src/server.ts` not found        -- torn read during the files=0 window
//   - `Could not resolve "./observability"` &c.           -- torn read during files=26; the entry
//                                                            point exists, its siblings do not
//   - `workerd exited early with code 1`                  -- a torn read that still emitted a
//                                                            bundle; the failure lands at boot
//
// WHY A LOCK RATHER THAN SERIALIZING THE CALLERS. `--concurrency=1` on the script tests and
// `fileParallelism: false` on the vitest side would make collisions unlikely by removing
// concurrency, but they do not remove the race -- they only reduce the number of contenders, and
// every future parallel caller reintroduces it. The contended resource is one directory per
// package, so excluding on *that* fixes every caller at once, including callers not yet written,
// and leaves concurrency intact everywhere except the genuinely serial section.
//
// ponytail: a directory rename as the mutex, not a lockfile dependency. `rename` onto an existing
// directory fails rather than clobbering, so the move either wins or loses atomically -- that is
// the whole primitive. Upgrade path if this ever needs more: a real advisory-lock dependency, or
// per-invocation build dirs, which would need a synthesized wrangler.jsonc per call since
// `wrangler deploy` has no `--main` override to point at one.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Name of the file inside the lock directory identifying its holder. */
const OWNER = "owner.json";

/** How long to wait for a peer's build before declaring its lock stale. */
const STALE_MS = 10 * 60 * 1000;

/** Gap between acquisition attempts. Builds run in the seconds, so polling need not be tight. */
const POLL_MS = 100;

/**
 * The lock directory for a package. Lives beside the output it guards, so it is covered by the
 * same `.wrangler/` gitignore entry and is removed by the same cleanup.
 * @param {string} pkgDir Absolute path to the package (the directory holding wrangler.jsonc).
 */
function lockPath(pkgDir) {
  return join(pkgDir, ".wrangler", "build.lock");
}

/**
 * Whether a held lock belongs to a process that no longer exists.
 *
 * A build killed with SIGKILL (or a machine that lost power) leaves its lock directory behind, and
 * nothing would ever clean it up. Checking liveness makes that self-healing instead of a hang that
 * needs a human to `rm -rf`. `kill(pid, 0)` tests existence without signalling.
 *
 * @param {string} dir The lock directory.
 * @returns {boolean} true if the lock may be broken.
 */
function isStale(dir) {
  const owner = readOwner(dir);
  // No owner file at all. Acquisition is atomic (see withBuildLock), so a lock without one is not
  // a half-built lock -- it is debris from an interrupted run, or a directory someone created by
  // hand. Either way nothing holds it.
  if (!owner) return true;

  if (typeof owner.pid === "number") {
    try {
      process.kill(owner.pid, 0); // signal 0: test for existence without signalling
      return false; // alive, so genuinely held
    } catch (err) {
      // ESRCH: no such process, so the holder is gone -- a SIGKILLed build leaves exactly this,
      // and without this check the next run would block until STALE_MS rather than recover.
      // EPERM means it exists under another uid, which is alive.
      if (err && err.code === "ESRCH") return true;
    }
  }

  return typeof owner.at === "number" && Date.now() - owner.at > STALE_MS;
}

/**
 * The holder recorded in a lock directory, or null if it cannot be read.
 * @param {string} dir The lock directory.
 */
function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, OWNER), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove a lock directory without racing a concurrent acquisition.
 *
 * `rmSync(recursive, force)` is NOT safe here. rimraf walks the directory, unlinks each entry,
 * then `rmdir`s -- so if anything creates a file inside that window it throws `ENOTEMPTY`, which
 * `force` does not suppress (it only swallows ENOENT). And something does: acquisition renames a
 * staging directory *onto* this path, so a stale-break racing an acquire repopulates the tree
 * mid-walk. Measured at 107/400 with a writer running against a concurrent rimraf.
 *
 * Renaming the directory aside first makes the removal atomic in the same way acquisition is: the
 * name is freed in one step, and whatever is left is ours alone to delete at leisure.
 *
 * @param {string} dir The lock directory.
 * @param {string} wrangler Its parent, where the doomed copy is parked.
 */
function removeLockDir(dir, wrangler) {
  let doomed;
  try {
    doomed = mkdtempSync(join(wrangler, ".build.lock.dead-"));
    rmSync(doomed, { recursive: true, force: true }); // rename needs the target gone
    renameSync(dir, doomed);
  } catch (err) {
    // ENOENT: someone else already released or broke it -- the name is free, which is all we
    // wanted. Anything else is a real filesystem problem worth surfacing.
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  // Nothing can reach `doomed` by name, so this cannot race an acquisition.
  rmSync(doomed, { recursive: true, force: true });
}

/**
 * Run `fn` with exclusive access to `pkgDir`'s wrangler build output.
 *
 * Blocks (synchronously, by design -- every caller is already a synchronous `execFileSync` build
 * step) until no other process is building this package, then runs `fn` and releases.
 *
 * Reentrant across nested calls in one process: an inner call sees the same pid in the owner file
 * and proceeds without deadlocking, and only the outermost call releases.
 *
 * @template T
 * @param {string} pkgDir Absolute path to the package to lock.
 * @param {() => T} fn Ran while the lock is held.
 * @returns {T} Whatever `fn` returned.
 */
export function withBuildLock(pkgDir, fn) {
  const dir = lockPath(pkgDir);
  const wrangler = join(pkgDir, ".wrangler");
  mkdirSync(wrangler, { recursive: true });

  for (;;) {
    // Build the lock complete-with-owner off to the side, then move it into place. `rename` onto
    // an existing directory fails (ENOTEMPTY/EEXIST) rather than clobbering, so the move is the
    // atomic acquisition -- and the lock is never observable without its owner file.
    //
    // Doing it the obvious way instead -- mkdir, then write owner.json -- leaves a window where a
    // contender reads a lock that has no owner yet, judges it stale, and deletes a *live* lock.
    // That is not theoretical: it let two builders run concurrently in ~1 run in 3.
    const staging = mkdtempSync(join(wrangler, ".build.lock.tmp-"));
    writeFileSync(join(staging, OWNER), JSON.stringify({ pid: process.pid, at: Date.now() }));

    try {
      renameSync(staging, dir);
      break; // acquired
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (!err || (err.code !== "ENOTEMPTY" && err.code !== "EEXIST" && err.code !== "EPERM")) {
        throw err;
      }
    }

    // Held by someone. If it is us, this is a nested call: proceed, and leave the release to the
    // outermost frame.
    if (readOwner(dir)?.pid === process.pid) return fn();

    if (isStale(dir)) {
      removeLockDir(dir, wrangler);
      continue; // retry the acquisition rather than assume we won the cleanup race
    }

    // Someone else is mid-build. Sleep without spinning a CPU: Atomics.wait on a throwaway buffer
    // is the stdlib's only synchronous sleep.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }

  try {
    return fn();
  } finally {
    removeLockDir(dir, wrangler);
  }
}
