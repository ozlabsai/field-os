// Every worker's outbound reach, asserted against the config workerd is actually given.
//
// The generator is a script that runs on import, so rather than importing its internals this
// builds a real config and reads it back. That also makes the test independent of how the policy
// happens to be expressed -- what matters is the capnp workerd ends up enforcing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "workerd-outbound-"));
after(() => rmSync(out, { recursive: true, force: true }));

// A deliberately permissive `--allow`, so a worker that reaches the internal network only because
// it shares one service with everyone would show up as a failure here rather than passing by
// virtue of the deployment having granted nothing.
execFileSync("node", [
  join(ROOT, "scripts/run-workerd.mjs"),
  "--build-only", "--out", out, "--allow", "public,10.9.8.0/24",
], { cwd: ROOT, stdio: "pipe" });

const capnp = readFileSync(join(out, "config.capnp"), "utf8");

// "const gatekeeperMcpWorker :Workerd.Worker = (" ... `globalOutbound = "…"` -> { worker: service }
function outboundByWorker() {
  const found = {};
  let current = null;
  for (const line of capnp.split("\n")) {
    const decl = /^const (\w+) :Workerd\.Worker = \(/.exec(line);
    if (decl) { current = decl[1]; continue; }
    const outbound = /^\s*globalOutbound = "([^"]+)",/.exec(line);
    if (outbound && current) { found[current] = outbound[1]; current = null; }
  }
  return found;
}

describe("per-worker outbound reach", () => {
  const outbound = outboundByWorker();

  it("emits a public-only service alongside the deployment's own", () => {
    assert.match(capnp, /\(name = "internet", network = \(allow = \["public", "10\.9\.8\.0\/24"\]\)\)/);
    assert.match(capnp, /\(name = "internet-public", network = \(allow = \["public"\]\)\)/);
  });

  // Each of these contacts a host the operator chose, which on an isolated network is internal by
  // definition -- inference, an on-prem MCP server, a Home Assistant instance, an IdP issuer.
  it("grants internal reach only to the workers that need it", () => {
    for (const worker of [
      "workshopBackendWorker", "gatekeeperMcpWorker", "gatekeeperMcpPortalWorker",
      "gatekeeperHomeassistantWorker", "gatekeeperOidcWorker",
    ]) {
      assert.equal(outbound[worker], "internet", `${worker} should reach the internal network`);
    }
  });

  // The point of the split: a bug in one of these must not inherit the MCP connector's reach.
  it("pins every other worker to public-only", () => {
    for (const worker of [
      "gatekeeperContextWorker", "gatekeeperSchedulerWorker", "gatekeeperGithubWorker",
      "routerWorker", "assetsWorker",
    ]) {
      assert.equal(outbound[worker], "internet-public", `${worker} should not reach the internal network`);
    }
  });

  it("covers every worker that declares an outbound service", () => {
    // Guards the assertions above against a worker being added and silently going unchecked.
    const checked = new Set([
      "workshopBackendWorker", "gatekeeperMcpWorker", "gatekeeperMcpPortalWorker",
      "gatekeeperContextWorker", "gatekeeperSchedulerWorker", "gatekeeperGithubWorker",
      "gatekeeperHomeassistantWorker", "gatekeeperOidcWorker", "routerWorker", "assetsWorker",
    ]);
    const unchecked = Object.keys(outbound).filter((w) => !checked.has(w));
    assert.deepEqual(unchecked, [], `unchecked workers: ${unchecked.join(", ")}`);
  });
});
