#!/usr/bin/env node

// Consistent backup of the standalone-workerd Durable Object state.
//
// WHY THIS IS NOT `tar`. Each DO directory holds SQLite databases, and on a running stack the
// recent commits are in `-wal` rather than the `.sqlite` file. Archiving those files while workerd
// is writing can capture a torn pair: the backup restores, opens, and is quietly missing the last
// transactions. That is worse than having no backup, because it is trusted. `VACUUM INTO` asks
// SQLite for a consistent snapshot of a live database instead, so the copy is a valid database as
// of one instant, WAL included.
//
// WHAT THIS IS NOT. Not the product's backup story -- that is OZL-229, which has to cover restore
// procedure, retention, and the fact that `localDisk` is marked EXPERIMENTAL and
// SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE in the workerd schema, so every upgrade is a migration
// event. This is a local safety net for a deployment with real workspaces in it and no other net.
//
// WHAT A COMPLETE BACKUP IS. The databases AND `keys.json`. That file holds the uniqueKeys that
// *name* the DO directories, so databases without it restore into a deployment that cannot address
// its own data -- `uniqueKeyFor()` mints fresh UUIDs, workerd creates new empty directories, and
// every existing workspace sits unreachable on the same disk. `run-workerd.mjs` refuses to boot
// into exactly that state. This script copies both, and says so loudly when keys.json is missing.
//
// TO RESTORE: stop the stack (supervisor first, then the child -- it may need `kill -9`). The DO
// directories are at the backup's root and `keys.json` beside them, so it is two copies: the
// directories into `do-disk/`, and `keys.json` into its parent. Verify by opening a workspace in
// the UI, NOT by `quick_check`: a torn WAL pair passes structural checks while missing the last
// transactions, which is the failure this script exists to prevent.
//
// Usage: node scripts/backup-do-disk.mjs [--out <dir>] [--state <state dir | do-disk dir>]
// Exit:  0 backed up, 1 nothing to back up, 2 one or more databases failed.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { out: undefined, state: join(ROOT, ".workerd", "do-disk") };
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--state") args.state = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.state)) {
  console.error(`nothing to back up: ${args.state} does not exist`);
  process.exit(1);
}

// `keys.json` holds the uniqueKeys that NAME the DO directories, and it is the sibling of
// `do-disk/`, not a file inside it -- so a backup of the databases alone restores state that the
// deployment cannot address. Without it `uniqueKeyFor()` mints fresh UUIDs, workerd creates new
// empty directories, and every existing workspace sits unreachable on the same disk. That is the
// exact failure `run-workerd.mjs`'s keys.json guard refuses to boot into, and a backup that
// cannot be restored from is worse than no backup, because it is trusted.
//
// Accept `--state` pointing at either the state directory or the `do-disk` inside it: this script
// historically meant the latter, `run-workerd.mjs --state` means the former, and guessing wrong
// silently omits the file. Resolved by looking, not by convention.
const stateRoot = basename(args.state) === "do-disk" ? dirname(args.state) : args.state;
const doDisk = basename(args.state) === "do-disk" ? args.state : join(args.state, "do-disk");
const keysPath = join(stateRoot, "keys.json");

// Timestamped so a run never overwrites its predecessor. Deliberately not pruning old backups:
// deleting someone's only copy of a workspace to save disk is not a decision this script should
// make quietly.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.out ?? join(ROOT, ".workerd", "backups", stamp);
mkdirSync(outDir, { recursive: true });

/** Every `.sqlite` under the state directory, with its path relative to that directory. */
function findDatabases(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findDatabases(path));
    else if (entry.name.endsWith(".sqlite")) found.push(path);
  }
  return found;
}

const databases = findDatabases(doDisk);
if (databases.length === 0) {
  console.error(`nothing to back up: no .sqlite files under ${doDisk}`);
  process.exit(1);
}

let failed = 0;
for (const source of databases) {
  const target = join(outDir, relative(doDisk, source));
  mkdirSync(dirname(target), { recursive: true });
  try {
    // VACUUM INTO takes a read lock and writes a fresh, fully-checkpointed database. It refuses
    // rather than truncating if the target exists, which is why `target` is always new here.
    execFileSync("sqlite3", [source, `VACUUM INTO '${target.replace(/'/g, "''")}'`],
        { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    // Report and continue: one unreadable database should not cost the operator the other 78.
    console.error(`  FAILED ${relative(doDisk, source)}: ${String(e.stderr ?? e).trim()}`);
    ++failed;
  }
}

// Non-SQLite files in the state tree (workerd writes a few) are copied as-is; they are small and
// not transactional, so a plain copy is honest for them.
for (const entry of readdirSync(doDisk, { withFileTypes: true, recursive: true })) {
  if (entry.isDirectory()) continue;
  if (/\.sqlite(-wal|-shm)?$/.test(entry.name)) continue;
  const source = join(entry.parentPath ?? doDisk, entry.name);
  const target = join(outDir, relative(doDisk, source));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

// Copied verbatim rather than through sqlite: it is a small JSON file, not a database. Its
// absence is reported loudly, because a backup missing it looks complete and restores into a
// deployment that cannot find its own data.
const keysBackedUp = existsSync(keysPath);
if (keysBackedUp) cpSync(keysPath, join(outDir, "keys.json"));

const total = databases.length - failed;
writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify({
  createdAt: new Date().toISOString(),
  source: doDisk,
  databases: total,
  failed,
  // Recorded so a restore can tell a complete backup from one that will not address its data.
  keys: keysBackedUp,
  // Recorded because restoring into a different workerd is the risky case: localDisk's on-disk
  // format is explicitly not guaranteed stable across versions.
  workerd: (() => {
    try {
      return JSON.parse(execFileSync("node",
          ["-e", "console.log(JSON.stringify(require('workerd/package.json').version))"],
          { cwd: ROOT, encoding: "utf8" }).trim());
    } catch { return null; }
  })(),
}, null, 2) + "\n");

const size = execFileSync("du", ["-sh", outDir], { encoding: "utf8" }).split("\t")[0];
console.log(`backed up ${total}/${databases.length} databases` +
    `${keysBackedUp ? " + keys.json" : ""} (${size.trim()}) -> ${outDir}`);
if (!keysBackedUp) {
  console.error(
      `WARNING: no keys.json at ${keysPath}, so this backup CANNOT be restored on its own.\n` +
      "         The uniqueKeys in that file name the DO directories; without it a restore boots " +
      "with fresh keys\n         and every workspace in this backup is unreachable. Find it " +
      "before trusting this copy.");
}
if (failed > 0) {
  console.error(`${failed} database(s) failed; the backup is INCOMPLETE`);
  process.exit(2);
}
// The DO directories are written at the backup root (paths are relative to `doDisk`), and
// keys.json sits beside them -- so the restore is two copies, not one, and naming them exactly
// matters more than brevity here.
// The glob has NO trailing slash, and that is load-bearing: `cp -R src/*/ dst/` copies each
// directory's CONTENTS, flattening every DO namespace into one pile of loose .sqlite files and
// destroying the structure the uniqueKeys address. Measured, because both forms read correct --
// with the slash, 24 directories became 57 loose files; without it, 24 directories.
// `*-*` matches the UUID-named namespace dirs without sweeping up keys.json or MANIFEST.json.
console.log(`restore: stop the stack, then:\n` +
    `           rm -rf ${doDisk} && mkdir -p ${doDisk}\n` +
    `           cp -R ${outDir}/*-* ${doDisk}/` +
    `${keysBackedUp ? `\n           cp ${outDir}/keys.json ${keysPath}` : ""}\n` +
    "         Verify by opening a workspace in the UI, not by quick_check.");
