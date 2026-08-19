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
// Usage: node scripts/backup-do-disk.mjs [--out <dir>] [--state <do-disk dir>]
// Exit:  0 backed up, 1 nothing to back up, 2 one or more databases failed.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

const databases = findDatabases(args.state);
if (databases.length === 0) {
  console.error(`nothing to back up: no .sqlite files under ${args.state}`);
  process.exit(1);
}

let failed = 0;
for (const source of databases) {
  const target = join(outDir, relative(args.state, source));
  mkdirSync(dirname(target), { recursive: true });
  try {
    // VACUUM INTO takes a read lock and writes a fresh, fully-checkpointed database. It refuses
    // rather than truncating if the target exists, which is why `target` is always new here.
    execFileSync("sqlite3", [source, `VACUUM INTO '${target.replace(/'/g, "''")}'`],
        { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    // Report and continue: one unreadable database should not cost the operator the other 78.
    console.error(`  FAILED ${relative(args.state, source)}: ${String(e.stderr ?? e).trim()}`);
    ++failed;
  }
}

// Non-SQLite files in the state tree (workerd writes a few) are copied as-is; they are small and
// not transactional, so a plain copy is honest for them.
for (const entry of readdirSync(args.state, { withFileTypes: true, recursive: true })) {
  if (entry.isDirectory()) continue;
  if (/\.sqlite(-wal|-shm)?$/.test(entry.name)) continue;
  const source = join(entry.parentPath ?? args.state, entry.name);
  const target = join(outDir, relative(args.state, source));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

const total = databases.length - failed;
writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify({
  createdAt: new Date().toISOString(),
  source: args.state,
  databases: total,
  failed,
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
console.log(`backed up ${total}/${databases.length} databases (${size.trim()}) -> ${outDir}`);
if (failed > 0) {
  console.error(`${failed} database(s) failed; the backup is INCOMPLETE`);
  process.exit(2);
}
console.log("restore: stop the stack, then replace .workerd/do-disk with this directory's contents");
