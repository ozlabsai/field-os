// `--only`: the subset stack the tier-2 suite boots.
//
// Bundling is linear in worker count (docs/testing.md), so a tier-2 test that booted all nine
// workers would cost Tier-3 money on every run. `--only` narrows the set. The risk it carries is
// *silent* incoherence: the backend and router emit a service binding per included gatekeeper, so
// a subset that dropped a worker without dropping its bindings would produce a config referencing
// services that were never generated -- fatal at boot, and only discoverable by booting.
//
// Like workerd-outbound.test.js, this builds real configs and reads them back rather than
// importing the generator's internals (it is a script that runs on import). What matters is the
// capnp workerd is actually handed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "workerd-only-"));
after(() => rmSync(out, { recursive: true, force: true }));

function build(extraArgs) {
  execFileSync(
      "node", [join(ROOT, "scripts/run-workerd.mjs"), "--build-only", "--out", out, ...extraArgs],
      { cwd: ROOT, stdio: "pipe" });
  return readFileSync(join(out, "config.capnp"), "utf8");
}

/** Top-level service names, i.e. `(name = "x", ...)` entries in the `services` list. */
function serviceNames(capnp) {
  return [...capnp.matchAll(/^ {4}\(name = "([a-z0-9-]+)"/gm)].map((m) => m[1]);
}

/** Every `GATEKEEPER_*` binding name the config references. */
function gatekeeperBindings(capnp) {
  return [...new Set([...capnp.matchAll(/name = "(GATEKEEPER_[A-Z_]+)"/g)].map((m) => m[1]))];
}

describe("--only", () => {
  // The headline property. Everything else here guards this one from regressing quietly.
  it("emits no binding to a service it did not generate", () => {
    const capnp = build(["--only", "workshop-backend,router,gatekeeper-context"]);
    const services = new Set(serviceNames(capnp));

    // Every `service = "name"` and `service = (name = "name", ...)` must resolve.
    const referenced = [
      ...[...capnp.matchAll(/service = "([a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...capnp.matchAll(/service = \(name = "([a-z0-9-]+)"/g)].map((m) => m[1]),
    ];
    const dangling = [...new Set(referenced)].filter((name) => !services.has(name));
    assert.deepEqual(dangling, [], `bindings point at undefined services: ${dangling.join(", ")}`);
  });

  it("includes only the gatekeepers named", () => {
    const capnp = build(["--only", "workshop-backend,router,gatekeeper-context"]);
    assert.deepEqual(
        serviceNames(capnp).filter((n) => n.startsWith("gatekeeper-")), ["gatekeeper-context"]);
    assert.deepEqual(gatekeeperBindings(capnp), ["GATEKEEPER_CONTEXT"]);
  });

  // The cheapest tier-2 stack: the gadget sandbox binds no gatekeeper, so it needs none bound.
  // Verified separately by booting this config -- it serves `/` and routes `/api` to the backend.
  it("accepts a core-only stack with no gatekeepers at all", () => {
    const capnp = build(["--only", "workshop-backend,router"]);
    assert.deepEqual(serviceNames(capnp).filter((n) => n.startsWith("gatekeeper-")), []);
    assert.deepEqual(gatekeeperBindings(capnp), []);
    // The socket's target must still exist, or the config is unbootable.
    assert.ok(serviceNames(capnp).includes("router"), "router must always be included");
    assert.ok(serviceNames(capnp).includes("workshop-backend"), "backend must always be included");
  });

  // A typo must not quietly produce a smaller stack: a tier-2 test would then pass against a
  // deployment missing the very worker it meant to exercise, which is indistinguishable from a
  // real pass. Fatal, and the message names the offending value.
  it("refuses an unknown package name", () => {
    assert.throws(
        () => build(["--only", "workshop-backend,router,gatekeeper-typo"]),
        (err) => String(err.stderr).includes("gatekeeper-typo")
            && String(err.stderr).includes("--only"),
        "an unknown --only entry should be fatal and name itself");
  });

  it("leaves the default (no --only) stack at every gatekeeper", () => {
    const capnp = build([]);
    assert.equal(serviceNames(capnp).filter((n) => n.startsWith("gatekeeper-")).length, 7);
    assert.equal(gatekeeperBindings(capnp).length, 7);
  });
});
