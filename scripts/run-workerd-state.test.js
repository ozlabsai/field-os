// `--state` and `--bundle-only`: the two flags that let a container image hold the bundles while a
// mounted volume holds the durable state.
//
// The guard under test is the one whose failure is otherwise invisible. `keys.json` holds the DO
// uniqueKeys that NAME the on-disk directories; if it goes missing beside a populated `do-disk/`,
// `uniqueKeyFor()` mints fresh UUIDs, workerd creates new empty directories, and the deployment
// boots healthy while every existing workspace sits unreachable on the same volume. There is no
// migration mechanism. So this asserts a *refusal*, and the negative controls below matter as much
// as the positive one: a guard that fired on a fresh install would make first boot impossible.
//
// Like workerd-only.test.js, this drives the real script and reads back what it produced rather
// than importing internals (run-workerd.mjs executes on import).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];
after(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

// Bundling all nine workers is slow, so every case here uses the smallest legal subset. The core
// two are never subsettable, which is what makes `--only ""` the floor rather than an empty stack.
const SUBSET = ["--only", ""];

function run(args) {
  return execFileSync("node", [join(ROOT, "scripts/run-workerd.mjs"), ...args],
      { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
}

describe("--bundle-only", () => {
  it("writes bundles but not config.capnp", () => {
    const out = tmp("rw-bundle-");
    run(["--bundle-only", "--out", out, ...SUBSET]);

    assert.ok(readFileSync(join(out, "bundles", "router", "index.js"), "utf8").length > 0,
        "expected router bundle to exist");
    assert.throws(() => readFileSync(join(out, "config.capnp"), "utf8"), /ENOENT/,
        "config.capnp must NOT be written -- baking it into an image would freeze instance " +
        "state (ADMINS, CA bundle, session ceilings) and the builder's absolute paths");
  });
});

describe("--use-bundles", () => {
  it("generates config from existing bundles without rebuilding", () => {
    const out = tmp("rw-reuse-");
    run(["--bundle-only", "--out", out, ...SUBSET]);

    // The second pass must not re-bundle: that is the whole point of the split, since a runtime
    // container carries no wrangler and no pnpm workspace to bundle with.
    const log = run(["--build-only", "--use-bundles", "--out", out, ...SUBSET]);
    assert.match(log, /using existing bundle for router/);
    assert.doesNotMatch(log, /^bundling /m,
        "--use-bundles must read the bundles, not rebuild them");
    assert.ok(readFileSync(join(out, "config.capnp"), "utf8").includes("workshop-backend"));
  });

  it("refuses with a usable message when a bundle is absent", () => {
    // Otherwise the failure surfaces far downstream as a config referencing modules that were
    // never written -- fatal at boot, and naming a file rather than the missing build step.
    const out = tmp("rw-nobundle-");
    assert.throws(
        () => run(["--build-only", "--use-bundles", "--out", out, ...SUBSET]),
        (err) => /no bundle for .*Run --bundle-only first/s.test(String(err.stderr)));
  });
});

describe("--state", () => {
  it("puts do-disk and keys.json under --state, leaving bundles under --out", () => {
    const out = tmp("rw-out-");
    const state = tmp("rw-state-");
    const config = (run(["--build-only", "--out", out, "--state", state, ...SUBSET]),
        readFileSync(join(out, "config.capnp"), "utf8"));

    assert.match(config, new RegExp(`do-disk", disk = \\(path = "${state}/do-disk"`),
        "the config's do-disk service must point into --state, not --out");
    assert.ok(readFileSync(join(state, "keys.json"), "utf8").includes("UserDurableObject"),
        "keys.json belongs with the state it names");
    assert.throws(() => readFileSync(join(out, "keys.json"), "utf8"), /ENOENT/,
        "keys.json must not also be left in --out, where an image build would bake it");
  });

  it("defaults to --out when omitted, so an ordinary local run is unchanged", () => {
    const out = tmp("rw-default-");
    run(["--build-only", "--out", out, ...SUBSET]);
    assert.ok(readFileSync(join(out, "keys.json"), "utf8").includes("UserDurableObject"));
  });
});

describe("FIELDOS_PUBLIC_URL", () => {
  // Without this, a container hands every gatekeeper a localhost callback base, so an OAuth flow
  // redirects the user's browser to their own machine -- failing at the END of a connect flow,
  // where it looks like a broken gatekeeper rather than a misconfigured origin.
  function buildWith(env, extra = []) {
    const out = tmp("rw-origin-");
    execFileSync("node", [join(ROOT, "scripts/run-workerd.mjs"), "--build-only", "--out", out,
      ...extra, ...(extra.length ? [] : SUBSET)],
        { cwd: ROOT, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });
    return readFileSync(join(out, "config.capnp"), "utf8");
  }

  it("defaults to localhost, and the override reaches both binding shapes", () => {
    assert.match(buildWith({}), /"PUBLIC_BASE_URL", text = "http:\/\/localhost:8080"/);

    const config = buildWith({ FIELDOS_PUBLIC_URL: "https://fieldos.example.com" },
        ["--only", "gatekeeper-oidc"]);
    assert.match(config, /"PUBLIC_BASE_URL", text = "https:\/\/fieldos.example.com"/);
    // The gatekeeper gets the origin PLUS its own path segment, not the bare origin.
    assert.match(config,
        /"BASE_URL", text = "https:\/\/fieldos.example.com\/gatekeeper\/oidc"/);
  });

  it("refuses a malformed origin rather than baking it in", () => {
    // Both of these would otherwise surface as a provider-side redirect_uri mismatch, far from
    // the config that caused them.
    assert.throws(() => buildWith({ FIELDOS_PUBLIC_URL: "not a url" }),
        (err) => /is not a valid URL/.test(String(err.stderr)));
    assert.throws(() => buildWith({ FIELDOS_PUBLIC_URL: "https://host/app" }),
        (err) => /expected an origin with no path/.test(String(err.stderr)));
  });
});

describe("keys.json guard", () => {
  it("refuses to boot when do-disk holds state but keys.json is missing", () => {
    const out = tmp("rw-guard-");
    const state = tmp("rw-guard-state-");

    // A volume that has been used: DO directories present, keys.json lost (a partial restore, or
    // a keys.json baked into an image that a fresh container did not carry).
    mkdirSync(join(state, "do-disk", "60cb07c3-ee38-4fde-8a5a-0519554310e3"), { recursive: true });
    writeFileSync(join(state, "do-disk", "60cb07c3-ee38-4fde-8a5a-0519554310e3", "db.sqlite"), "");

    assert.throws(
        () => run(["--build-only", "--out", out, "--state", state, ...SUBSET]),
        (err) => /holds Durable Object state but/.test(String(err.stderr)),
        "expected a refusal naming the orphaning risk");
  });

  // The two cases the guard must NOT fire on. Without these, a guard that simply always threw
  // would pass the test above while making every first boot impossible.
  it("allows a fresh install (no do-disk at all)", () => {
    const out = tmp("rw-fresh-");
    const state = tmp("rw-fresh-state-");
    run(["--build-only", "--out", out, "--state", state, ...SUBSET]);
    assert.ok(readFileSync(join(state, "keys.json"), "utf8").includes("UserDurableObject"));
  });

  it("allows an empty do-disk (created by a previous boot that stored nothing)", () => {
    const out = tmp("rw-empty-");
    const state = tmp("rw-empty-state-");
    mkdirSync(join(state, "do-disk"), { recursive: true });
    run(["--build-only", "--out", out, "--state", state, ...SUBSET]);
    assert.ok(readFileSync(join(state, "keys.json"), "utf8").includes("UserDurableObject"));
  });
});
