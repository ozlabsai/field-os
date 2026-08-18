#!/usr/bin/env node

// Builds the release twice and asserts the two manifests are byte-identical.
//
// This exists because of a failure mode CI is structurally unable to see. CI checks out clean, so
// it only ever exercises a cold build; a developer's machine has whatever the last build left
// behind. Those fail in opposite directions. On 2026-08-17 `pnpm build` failed locally on
// gatekeeper-oidc with three TS2345 errors while CI was green on the same commit — the cause was a
// stale gitignored `.wrangler/validate/` tree, and deleting it fixed everything. Nothing automated
// could have caught that, because every automated check ran on a clean tree.
//
// The manifest is content-addressed (see hash-lib.mjs), so comparing manifests compares the actual
// module bytes: if a rebuild is not byte-identical, the release id names something ambiguous and
// the content-addressed store is not trustworthy. That makes this both a staleness check and a
// precondition for releasing at all.
//
// The second build deliberately runs over the first one's leftovers rather than from clean. Doing
// two cold builds would compare a cold build to a cold build and reproduce CI's blind spot exactly.
//
// Usage: node scripts/release/verify-reproducible.mjs [--keep <dir>]
// Exit: 0 identical, 1 drift (diff printed), 2 a build failed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(ROOT, "scripts", "release", "build-release.mjs");

// A fixed id for both builds. The default id embeds a timestamp (`dev-<base36 seconds>`), which
// would differ between runs and produce a guaranteed false positive on the very field we compare.
const RELEASE_ID = "reproducibility-check";

function build(outDir, label) {
  process.stdout.write(`building (${label}) -> ${outDir}\n`);
  try {
    execFileSync(process.execPath, [BUILD, "--out", outDir, "--release-id", RELEASE_ID],
        { cwd: ROOT, stdio: "inherit" });
  } catch (e) {
    console.error(`\nbuild failed (${label}): ${e.message}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
}

// What gets compared: everything the release IS, minus how it was stamped.
//
// `createdAt` is `new Date().toISOString()` (build-release.mjs:154), so two builds can never be
// byte-identical. Comparing whole manifests would fail every single run -- and a check that always
// fails is worse than no check, because it gets muted. `releaseId` is pinned to a constant above
// but is stripped too, so this stays correct if a caller passes its own id.
//
// Everything retained is content-addressed (hash-lib.mjs), so this compares actual module and
// asset bytes rather than metadata.
function comparable(m) {
  const { createdAt, releaseId, ...rest } = m;
  return rest;
}

// Report drift per worker rather than dumping two manifests. A whole-file diff of a
// content-addressed manifest is unreadable -- every hash changes when one module does -- and the
// useful question is always "which worker drifted", not "what are the hashes now".
//
// `workers` is an object keyed by package name (manifest-lib.mjs:258), not an array -- the doc
// comment at manifest-lib.mjs:252 shows array syntax and is misleading.
function describeDrift(a, b) {
  const lines = [];
  const [wa, wb] = [a.workers ?? {}, b.workers ?? {}];
  for (const name of new Set([...Object.keys(wa), ...Object.keys(wb)])) {
    const [x, y] = [wa[name], wb[name]];
    if (!x) { lines.push(`  + ${name} (only in second build)`); continue; }
    if (!y) { lines.push(`  - ${name} (only in first build)`); continue; }
    if (JSON.stringify(x) !== JSON.stringify(y)) lines.push(`  ~ ${name} differs between builds`);
  }
  if (JSON.stringify(a.assets) !== JSON.stringify(b.assets)) {
    lines.push("  ~ frontend assets differ between builds");
  }
  // Drift outside workers/assets (manifest shape, wrangler version) would otherwise report as
  // "identical" with a failing overall comparison, which reads as a bug in this script.
  if (lines.length === 0) lines.push("  (workers and assets identical; drift is elsewhere)");
  return lines.join("\n");
}

const keepIdx = process.argv.indexOf("--keep");
const baseDir = keepIdx !== -1
    ? process.argv[keepIdx + 1]
    : mkdtempSync(join(tmpdir(), "fieldos-repro-"));

const first = build(join(baseDir, "build-1"), "cold");
// Second build into the SAME tree as the first: the point is to exercise reuse of whatever the
// previous build left behind, which is what a developer's machine actually looks like.
const second = build(join(baseDir, "build-1"), "warm, over the first build's output");

const [sa, sb] = [JSON.stringify(comparable(first)), JSON.stringify(comparable(second))];
if (sa === sb) {
  console.log(`\nreproducible: both builds produced an identical manifest ` +
      `(${Object.keys(first.workers ?? {}).length} workers)`);
  if (keepIdx === -1) rmSync(baseDir, { recursive: true, force: true });
  process.exit(0);
}

console.error(`\nNOT REPRODUCIBLE — the same commit built two different releases.\n`);
console.error(describeDrift(first, second));
console.error(`\nArtifacts kept at ${baseDir}`);
process.exit(1);
