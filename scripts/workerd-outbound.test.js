// Every worker's outbound reach, asserted against the config workerd is actually given.
//
// The generator is a script that runs on import, so rather than importing its internals this
// builds a real config and reads it back. That also makes the test independent of how the policy
// happens to be expressed -- what matters is the capnp workerd ends up enforcing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "workerd-outbound-"));
after(() => rmSync(out, { recursive: true, force: true }));

// A deliberately permissive `--allow`, so a worker that reaches the internal network only because
// it shares one service with everyone would show up as a failure here rather than passing by
// virtue of the deployment having granted nothing. Declaring one host per role additionally proves
// the roles stay separated -- an address given for inference must not appear in the MCP connector's
// service, and vice versa.
execFileSync("node", [
  join(ROOT, "scripts/run-workerd.mjs"),
  "--build-only", "--out", out, "--allow", "public,10.9.8.0/24",
], {
  cwd: ROOT,
  stdio: "pipe",
  env: { ...process.env, FIELDOS_INTERNAL_HOSTS: "inference=10.1.1.1,mcp=10.2.2.2" },
});

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

  // Matched up to the allow list's closing bracket rather than the closing paren: `network` also
  // carries `tlsOptions` (OZL-295), and anchoring on the paren made these assertions fail the
  // moment a second field was added. What is being asserted is the allow list, not the field order.
  it("emits a public-only service, and one per worker with internal reach", () => {
    assert.match(capnp, /\(name = "internet-public", network = \(allow = \["public"\]/);
    assert.match(capnp, /\(name = "net-workshop-backend", network = \(allow = \[[^\]]*\]/);
  });

  // Every network service must carry a TLS context. Without it workerd has no `tlsNetwork` and
  // every https:// fetch fails before a connection is attempted -- which reads as a network
  // refusal rather than a missing capability, so it is worth pinning rather than rediscovering.
  it("gives every network service a TLS context", () => {
    const services = [...capnp.matchAll(/\(name = "([\w-]+)", network = \(([^)]*\)[^)]*)\)/g)];
    assert.ok(services.length >= 2, "expected at least the public service and one per-worker one");
    for (const [, name, body] of services) {
      assert.match(body, /tlsOptions = \(trustBrowserCas = true\)/,
          `service ${name} must have a TLS context, or https:// fetches fail from it`);
    }
  });

  // Each of these contacts a host the operator chose, which on an isolated network is internal by
  // definition -- inference, an on-prem MCP server, a Home Assistant instance, an IdP issuer.
  it("grants internal reach only to the workers that need it", () => {
    const expected = {
      workshopBackendWorker: "net-workshop-backend",
      gatekeeperMcpWorker: "net-gatekeeper-mcp",
      gatekeeperMcpPortalWorker: "net-gatekeeper-mcp-portal",
      gatekeeperHomeassistantWorker: "net-gatekeeper-homeassistant",
      gatekeeperOidcWorker: "net-gatekeeper-oidc",
    };
    for (const [worker, service] of Object.entries(expected)) {
      assert.equal(outbound[worker], service, `${worker} should reach the internal network`);
    }
  });

  // The point of keying declared hosts by role: an address given for one role must not widen an
  // unrelated worker. Without this, declaring an inference server would also expose it to the MCP
  // connector, which is the pooling OZL-250 removed one layer up.
  it("keeps one role's addresses out of another role's service", () => {
    // Stops at the allow list's closing bracket, not the service's closing paren, so an added
    // field (tlsOptions) cannot make this silently return undefined. That failure mode is worse
    // than a wrong answer: the `.includes()` below then throws a TypeError instead of asserting,
    // so the role-separation property stops being checked while still looking like a red test.
    const serviceAllow = (name) => {
      const match = new RegExp(`\\(name = "${name}", network = \\(allow = \\[([^\\]]*)\\]`).exec(capnp);
      assert.ok(match, `no network service named ${name} in the generated config`);
      return match[1];
    };

    const backend = serviceAllow("net-workshop-backend");
    const mcp = serviceAllow("net-gatekeeper-mcp");
    assert.ok(backend.includes('"10.1.1.1/32"'), "backend should reach the inference host");
    assert.ok(!backend.includes("10.2.2.2"), "backend must not reach the MCP host");
    assert.ok(mcp.includes('"10.2.2.2/32"'), "MCP connector should reach the MCP host");
    assert.ok(!mcp.includes("10.1.1.1"), "MCP connector must not reach the inference host");
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

  // FIELDOS_INTERNAL_HOSTS and --allow are two paths into the same allow list. Validating only the
  // one the check was written for let `mcp=0.0.0.0/0` reach a service ungated, so both are checked
  // where they converge.
  it("refuses an over-broad range declared through FIELDOS_INTERNAL_HOSTS", () => {
    for (const hosts of ["mcp=0.0.0.0/0", "mcp=::/0", "mcp=10.42.0.0/16"]) {
      assert.throws(
        () => execFileSync("node", [
          join(ROOT, "scripts/run-workerd.mjs"), "--build-only", "--out", out, "--allow", "public",
        ], { cwd: ROOT, stdio: "pipe", env: { ...process.env, FIELDOS_INTERNAL_HOSTS: hosts } }),
        (err) => String(err.stderr).includes("FIELDOS_INTERNAL_HOSTS"),
        `${hosts} should be refused, naming the config it came from`);
    }
  });

  // TLS trust (OZL-300). The private-CA handshake itself was verified by execution against a real
  // HTTPS origin; what is pinned here is that the CA reaches *every* network service rather than
  // only the public one, since a bundle applied to some of them fails exactly where an internal
  // service lives. The build-and-read-back shape is deliberate: an operator's CA that never
  // reaches the config would otherwise look identical to one that did.
  describe("TLS trust", () => {
    const caPath = join(out, "test-ca.pem");
    // Not a real certificate -- loadCaBundle checks for the PEM envelope and leaves X.509
    // validation to workerd, so this exercises the emission path without a fixture keypair.
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n");

    function buildWith(env) {
      const dir = mkdtempSync(join(tmpdir(), "workerd-tls-"));
      after(() => rmSync(dir, { recursive: true, force: true }));
      execFileSync("node", [
        join(ROOT, "scripts/run-workerd.mjs"), "--build-only", "--out", dir,
        "--only", "gatekeeper-oidc",
      ], { cwd: ROOT, stdio: "pipe", env: { ...process.env, ...env } });
      return readFileSync(join(dir, "config.capnp"), "utf8");
    }

    it("trusts only the system bundle when no CA is configured", () => {
      const tls = buildWith({ FIELDOS_CA_BUNDLE: "" }).match(/tlsOptions = \([^)]*\)/g);
      assert.ok(tls.length > 0, "expected at least one network service");
      for (const opts of tls) {
        assert.match(opts, /trustBrowserCas = true/);
        assert.doesNotMatch(opts, /trustedCertificates/);
      }
    });

    it("applies an operator CA to every network service, on one line", () => {
      const capnpWithCa = buildWith({ FIELDOS_CA_BUNDLE: caPath });
      const tls = capnpWithCa.match(/tlsOptions = \([^)]*\)/g);
      for (const opts of tls) assert.match(opts, /trustedCertificates = \["/);
      // A raw newline inside a capnp string literal is a parse error at boot, long after this
      // script exits 0 -- so the PEM must arrive escaped. Caught this way originally.
      assert.doesNotMatch(capnpWithCa, /trustedCertificates = \["[^"]*\n/);
    });

    it("drops the system bundle when asked, so only the private CA is trusted", () => {
      const tls = buildWith({ FIELDOS_CA_BUNDLE: caPath, FIELDOS_CA_TRUST_SYSTEM: "false" })
          .match(/tlsOptions = \([^)]*\)/g);
      for (const opts of tls) {
        assert.match(opts, /trustBrowserCas = false/);
        assert.match(opts, /trustedCertificates = \["/);
      }
    });

    // Each of these fails at first https:// request otherwise, reported as an untrusted peer --
    // never as the misconfiguration it is.
    it("refuses a bundle that is missing, unreadable, or not a certificate", () => {
      for (const [env, expected] of [
        [{ FIELDOS_CA_BUNDLE: join(out, "nope.pem") }, "cannot read"],
        [{ FIELDOS_CA_BUNDLE: join(ROOT, "package.json") }, "no PEM certificate"],
        [{ FIELDOS_CA_TRUST_SYSTEM: "false" }, "requires FIELDOS_CA_BUNDLE"],
      ]) {
        assert.throws(() => buildWith(env),
          (err) => String(err.stderr).includes(expected),
          `expected failure naming ${expected}`);
      }
    });
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
