#!/usr/bin/env node

// Drives the backup/restore rehearsal against a containerized deployment.
//
// `plans/fieldos.md:415` names a restore rehearsal as the mitigation for the top platform risk
// (localDisk is EXPERIMENTAL and every workerd bump is a migration event), and until now the
// restore half had never been executed -- the backup is proven valid, which is a different claim.
//
// Two deliberate choices about *how* it rehearses:
//
//  * It kills the stack with SIGKILL WHILE IT IS WRITING, not gracefully. The realistic disaster
//    is a pod dying mid-write and coming back, and a rehearsal that starts from a cleanly stopped
//    stack tests the easy half -- which is not the half that fails.
//
//  * It verifies by READING THE DATA BACK OVER THE REAL API, not by row counts or `quick_check`.
//    A torn WAL pair restores, opens, and passes structural checks while quietly missing its most
//    recent transactions; `quick_check` says `ok`. That is the exact failure backup-do-disk.mjs
//    exists to prevent, so a structural check cannot be what confirms it worked.
//
// Usage: node packages/integration-tests/restore-rehearsal.mjs [--url http://localhost:8090] [--container fieldos-reh]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";

const args = { url: "http://localhost:8090", container: "fieldos-reh", volume: "fieldos-rehearsal" };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i].replace(/^--/, "");
  if (!(flag in args)) throw new Error(`unknown argument: ${process.argv[i]}`);
  args[flag] = process.argv[i + 1];
}

const docker = (...a) => execFileSync("docker", a, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server stores and compares these bytes verbatim, so this skips the frontend's argon2id.
const passwordHashFor = (u) =>
    new Uint8Array(createHash("sha256").update(`integration-test:${u}`).digest());

function connect() {
  const ws = new URL("/api", args.url);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession(ws.toString());
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/healthz", args.url), { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.text();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`deployment did not become healthy within ${timeoutMs}ms`);
}

const step = (n, what) => console.log(`\n=== ${n}. ${what} ===`);
let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}` +
      (ok ? "" : ` (expected ${JSON.stringify(expected)})`));
}

// ---------------------------------------------------------------------------

step(1, "write real data through the real API");
await waitForHealth();

const username = `rehearsal${Date.now().toString(36)}`;
const displayName = `Restore Rehearsal ${new Date().toISOString()}`;
const WORKSPACE_TITLE = `survived-${Date.now().toString(36)}`;
let workspaceId;
{
  const api = connect();
  const token = await api.createAccount(username, displayName, passwordHashFor(username));
  if (!token) throw new Error(`could not create account ${username}`);
  const auth = await api.authenticate(token);

  // A workspace is the unit a user would notice losing, which is what makes it the right probe:
  // "does a workspace still open" is the question the rehearsal has to answer.
  const workspace = await auth.newGadget();
  workspaceId = await workspace.getMetadata().then((m) => m.id);

  // Give it a title, for two reasons. A bare newGadget() is *provisional* and deliberately hidden
  // from listGadgets(), so asserting on the listing without this measures the provisional filter
  // rather than the restore -- a check that fails for a reason unrelated to its subject is as
  // misleading as one that passes for one. And a title is real content: something a torn restore
  // could plausibly lose while leaving the workspace itself openable.
  await workspace.setTitle(WORKSPACE_TITLE);
  console.log(`  created user ${username} and workspace ${workspaceId} titled "${WORKSPACE_TITLE}"`);
  api[Symbol.dispose]?.();
}

step(2, "back up while the stack is LIVE");
// VACUUM INTO, consistent on a running database -- the whole reason backup-do-disk.mjs exists
// rather than `tar`, which can capture a torn .sqlite/-wal pair.
console.log(docker("exec", args.container, "node", "/src/scripts/backup-do-disk.mjs",
    "--state", "/var/lib/fieldos/do-disk", "--out", "/var/lib/fieldos/backup").trim());

// backup-do-disk.mjs copies the DO databases and NOTHING ELSE -- it has no notion of keys.json,
// which is the file naming the directories it just copied. A backup without it restores into a
// deployment that cannot address its own data. Copied here so the rehearsal reflects what an
// operator must actually do; see the note this rehearsal produced.
docker("exec", args.container, "sh", "-c",
    "cp /var/lib/fieldos/keys.json /var/lib/fieldos/backup/keys.json");
console.log("  (keys.json copied separately -- backup-do-disk.mjs does not include it)");

step(3, "SIGKILL mid-write (the realistic disaster, not a graceful stop)");
{
  // Generate writes, then kill without waiting for them: this is a pod dying under load, which is
  // what a graceful `docker stop` would not reproduce.
  const api = connect();
  const token = await api.createAccount(`${username}b`, "concurrent writer",
      passwordHashFor(`${username}b`));
  const auth = await api.authenticate(token);
  void auth.newGadget();
  void auth.newGadget();
  docker("kill", "--signal=KILL", args.container);
  console.log("  killed -9 with writes in flight");
  try { api[Symbol.dispose]?.(); } catch { /* session died with the container */ }
}

step(4, "destroy the live state, keeping only the backup");
docker("run", "--rm", "-v", `${args.volume}:/state`, "--entrypoint", "sh", "fieldos:dev", "-c",
    "rm -rf /state/do-disk /state/keys.json && ls /state");
console.log("  do-disk and keys.json deleted");

step(5, "restore from the backup");
docker("run", "--rm", "-v", `${args.volume}:/state`, "--entrypoint", "sh", "fieldos:dev", "-c",
    // `cp -r src/. dst/` rather than any glob form. `cp -r src/*/ dst/` is NOT portable: BSD cp
    // (macOS) copies each directory's CONTENTS, flattening 24 DO namespaces into one pile of
    // loose .sqlite files and destroying the structure the uniqueKeys address, while GNU cp
    // (Linux, and this container) copies the directories themselves. Measured both ways --
    // trailing-slash gives 0 dirs/2 loose on macOS and 24 dirs/0 loose here. An operator
    // restoring from a macOS workstation would silently get the broken layout, so depend on
    // neither: `src/.` means "the contents of src" identically in both.
    "mkdir -p /state/do-disk && cp -r /state/backup/. /state/do-disk/ && " +
    "rm -f /state/do-disk/MANIFEST.json /state/do-disk/keys.json && " +
    "cp /state/backup/keys.json /state/keys.json && ls /state/do-disk | wc -l");
console.log("  restored do-disk and keys.json");

step(6, "start, and read the data back over the API");
docker("start", args.container);
console.log(`  healthz: ${(await waitForHealth()).trim()}`);
{
  const api = connect();
  const token = await api.login(username, passwordHashFor(username));
  check("the pre-crash user can log in", token !== null, true);
  if (token === null) {
    // Stop here rather than letting authenticate(null) die inside capnweb with a type error --
    // the restore failed, and that should read as a failed restore, not as a client crash.
    console.log("\nREHEARSAL FAILED: the user did not survive the restore.\n");
    process.exit(1);
  }

  const auth = await api.authenticate(token);

  // Deliberately NOT asserting on listGadgets(). A workspace stays *provisional* until a chat's
  // changes are accepted, and listGadgets() hides provisional ones -- so the assertion measured
  // the provisional filter rather than the restore, and failed identically with no crash at all.
  // Making it meaningful would need an inference server and the full chat-accept flow, at which
  // point it tests the gadget lifecycle rather than data survival. The two checks below answer the
  // question this rehearsal exists to ask. (A check that fails for an unrelated reason is not a
  // stricter check; it teaches whoever runs this next to read past a red line.)

  // The point of the rehearsal: not that a row survived, but that the workspace OPENS. A torn
  // restore can list an id whose content is gone.
  const opened = await auth.openGadget(workspaceId);
  const metadata = await opened.getMetadata();
  check("the workspace opens", metadata.id, workspaceId);

  // The claim the rehearsal exists to make: content written before the crash is still there. A
  // torn WAL pair restores, opens, and passes quick_check while missing its last transactions --
  // so this reads back a value, rather than trusting a structural check.
  check("its title survived the crash and restore", metadata.title, WORKSPACE_TITLE);
  api[Symbol.dispose]?.();
}

console.log(failures === 0
    ? "\nREHEARSAL PASSED: data written before a SIGKILL survived backup and restore.\n"
    : `\nREHEARSAL FAILED: ${failures} check(s) did not pass.\n`);
process.exit(failures === 0 ? 0 : 1);
