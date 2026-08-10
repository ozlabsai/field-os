import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTERNAL_HOST_ROLES, parseInternalHosts, resolveInternalHosts } from "./internal-hosts.mjs";

describe("parseInternalHosts", () => {
  it("returns an empty map for undefined input", () => {
    assert.deepEqual(parseInternalHosts(undefined), new Map());
  });

  it("returns an empty map for empty input", () => {
    assert.deepEqual(parseInternalHosts(""), new Map());
  });

  it("parses a single entry", () => {
    assert.deepEqual(
        parseInternalHosts("inference=vllm.corp.internal:8000"),
        new Map([["inference", ["vllm.corp.internal:8000"]]]));
  });

  it("parses multiple roles", () => {
    assert.deepEqual(
        parseInternalHosts("inference=vllm.corp.internal:8000,oidc=idp.corp.internal"),
        new Map([
          ["inference", ["vllm.corp.internal:8000"]],
          ["oidc", ["idp.corp.internal"]],
        ]));
  });

  it("collects a repeated role's targets", () => {
    assert.deepEqual(
        parseInternalHosts("mcp=10.42.7.9,mcp=10.42.7.10"),
        new Map([["mcp", ["10.42.7.9", "10.42.7.10"]]]));
  });

  it("rejects a malformed entry with no =", () => {
    assert.throws(() => parseInternalHosts("inference"), /malformed entry "inference"/);
  });

  it("rejects an entry with an empty role", () => {
    assert.throws(() => parseInternalHosts("=vllm.corp.internal"), /malformed entry/);
  });

  it("rejects an entry with an empty target", () => {
    assert.throws(() => parseInternalHosts("inference="), /malformed entry/);
  });

  it("rejects an unknown role", () => {
    assert.throws(
        () => parseInternalHosts("bogus=10.42.7.9"),
        /unknown role "bogus".*inference, mcp, oidc, homeassistant/);
  });
});

describe("INTERNAL_HOST_ROLES", () => {
  it("is frozen", () => {
    assert.ok(Object.isFrozen(INTERNAL_HOST_ROLES));
  });

  it("lists exactly the four supported roles", () => {
    assert.deepEqual(INTERNAL_HOST_ROLES, ["inference", "mcp", "oidc", "homeassistant"]);
  });
});

describe("resolveInternalHosts", () => {
  it("returns empty addresses for an empty parsed map", async () => {
    const { addresses, failures } = await resolveInternalHosts(new Map());
    assert.deepEqual(addresses, new Map());
    assert.deepEqual(failures, []);
  });

  it("resolves an IPv4 literal to a /32 without calling lookup", async () => {
    const lookup = () => { throw new Error("should not be called for IP literals"); };
    const { addresses } = await resolveInternalHosts(new Map([["mcp", ["10.42.7.9"]]]), lookup);
    assert.deepEqual(addresses.get("mcp"), ["10.42.7.9/32"]);
  });

  it("strips the port before treating a target as an IPv4 literal", async () => {
    const lookup = () => { throw new Error("should not be called for IP literals"); };
    const { addresses } = await resolveInternalHosts(new Map([["mcp", ["10.42.7.9:8000"]]]), lookup);
    assert.deepEqual(addresses.get("mcp"), ["10.42.7.9/32"]);
  });

  it("resolves a bracketed IPv6 literal to a /128 without calling lookup", async () => {
    const lookup = () => { throw new Error("should not be called for IP literals"); };
    const { addresses } = await resolveInternalHosts(new Map([["oidc", ["[2001:db8::1]"]]]), lookup);
    assert.deepEqual(addresses.get("oidc"), ["2001:db8::1/128"]);
  });

  it("passes an already-CIDR target through unchanged", async () => {
    const lookup = () => { throw new Error("should not be called for CIDR literals"); };
    const { addresses } = await resolveInternalHosts(new Map([["mcp", ["10.42.7.0/24"]]]), lookup);
    assert.deepEqual(addresses.get("mcp"), ["10.42.7.0/24"]);
  });

  it("strips the port from a hostname before resolving", async () => {
    let seen;
    const lookup = async (host) => { seen = host; return [{ address: "10.0.0.1", family: 4 }]; };
    await resolveInternalHosts(new Map([["inference", ["vllm.corp.internal:8000"]]]), lookup);
    assert.equal(seen, "vllm.corp.internal");
  });

  it("emits a CIDR per resolved address for a dual-stack host, deduplicated", async () => {
    const lookup = async () => [
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.2", family: 4 },
      { address: "2001:db8::1", family: 6 },
      { address: "2001:db8::2", family: 6 },
      { address: "192.0.2.1", family: 4 }, // duplicate, should collapse
    ];
    const { addresses } = await resolveInternalHosts(new Map([["inference", ["vllm.corp.internal"]]]), lookup);
    assert.deepEqual(addresses.get("inference"), [
      "192.0.2.1/32",
      "192.0.2.2/32",
      "2001:db8::1/128",
      "2001:db8::2/128",
    ]);
  });

  it("records a DNS failure without throwing, leaving the role's address list empty", async () => {
    const lookup = async () => { const err = new Error("not found"); err.code = "ENOTFOUND"; throw err; };
    const { addresses, failures } = await resolveInternalHosts(
        new Map([["oidc", ["idp.corp.internal"]]]), lookup);
    assert.deepEqual(addresses.get("oidc"), []);
    assert.deepEqual(failures, [{ role: "oidc", target: "idp.corp.internal", code: "ENOTFOUND" }]);
  });

  it("resolves multiple targets for a repeated role independently", async () => {
    const lookup = async (host) =>
      host === "mcp-a.corp.internal"
        ? [{ address: "10.0.0.1", family: 4 }]
        : [{ address: "10.0.0.2", family: 4 }];
    const { addresses } = await resolveInternalHosts(
        new Map([["mcp", ["mcp-a.corp.internal", "mcp-b.corp.internal"]]]), lookup);
    assert.deepEqual(addresses.get("mcp"), ["10.0.0.1/32", "10.0.0.2/32"]);
  });
});
