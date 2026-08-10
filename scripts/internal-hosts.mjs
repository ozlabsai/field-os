// Parses and resolves FIELDOS_INTERNAL_HOSTS: the internal services a deployment depends on
// (inference server, MCP servers, OIDC provider, Home Assistant, ...), so run-workerd.mjs can
// turn them into `--allow` CIDR entries for workerd's address-based network allow list.

import dns from "node:dns";
import { isIP } from "node:net";

/** The roles a FIELDOS_INTERNAL_HOSTS entry may declare. Exported so callers can map roles to workers. */
export const INTERNAL_HOST_ROLES = Object.freeze(["inference", "mcp", "oidc", "homeassistant"]);

const ROLE_SET = new Set(INTERNAL_HOST_ROLES);

// Bracketed IPv6 literal, optionally with a port: "[2001:db8::1]" or "[2001:db8::1]:8000".
const IPV6_BRACKETED = /^\[([^\]]+)\](?::\d+)?$/;
// Bare IPv4 literal, optionally with a port: "10.42.7.9" or "10.42.7.9:8000".
const IPV4_HOST = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/;
// Already-CIDR form: "10.42.7.9/32", "2001:db8::1/128".
const CIDR = /\/\d+$/;

/**
 * Parses the FIELDOS_INTERNAL_HOSTS env var into role -> raw targets. Pure (no DNS lookups).
 *
 * Format: comma-separated `role=target` entries, e.g.
 *   "inference=vllm.corp.internal:8000,mcp=10.42.7.9,mcp=10.42.7.10,oidc=idp.corp.internal"
 * A role may repeat (e.g. multiple MCP servers); all its targets are collected.
 *
 * @param {string | undefined | null} raw - the env var value.
 * @returns {Map<string, string[]>} role -> raw targets (hostnames, IPs, or already-CIDR forms),
 *   ports still attached.
 * @throws {Error} if an entry is malformed (no `=`, empty role/target) or names an unknown role.
 */
export function parseInternalHosts(raw) {
  const result = new Map();
  if (!raw || !raw.trim()) return result;

  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`FIELDOS_INTERNAL_HOSTS: malformed entry ${JSON.stringify(entry)}, expected "role=target".`);
    }
    const role = entry.slice(0, eq).trim();
    const target = entry.slice(eq + 1).trim();
    if (!role || !target) {
      throw new Error(`FIELDOS_INTERNAL_HOSTS: malformed entry ${JSON.stringify(entry)}, expected "role=target".`);
    }
    if (!ROLE_SET.has(role)) {
      throw new Error(
          `FIELDOS_INTERNAL_HOSTS: unknown role ${JSON.stringify(role)} in ${JSON.stringify(entry)}. ` +
          `Valid roles: ${INTERNAL_HOST_ROLES.join(", ")}.`);
    }
    if (!result.has(role)) result.set(role, []);
    result.get(role).push(target);
  }
  return result;
}

// Strips a trailing ":port" from a bracketed-IPv6/hostname/IPv4 target, and unwraps IPv6 brackets.
// Returns the bare host (hostname or IP literal, no port, no brackets).
function stripPort(target) {
  const v6 = IPV6_BRACKETED.exec(target);
  if (v6) return v6[1];
  const v4 = IPV4_HOST.exec(target);
  if (v4) return v4[1];
  // Hostname, possibly with a port. A bare hostname has no colon; "host:port" does.
  const lastColon = target.lastIndexOf(":");
  if (lastColon === -1) return target;
  return target.slice(0, lastColon);
}

/**
 * Resolves parsed internal-host targets to CIDR strings for workerd's `allow` list, one `/32`
 * (IPv4) or `/128` (IPv6) per resolved address. A DNS name that resolves to multiple addresses
 * (e.g. a dual-stack host returning both A and AAAA records) emits a CIDR for *every* address,
 * deduplicated -- pinning only the first address would silently break such a host roughly half
 * the time.
 *
 * DNS failures (ENOTFOUND, etc.) do not throw: boot-time DNS is not request-time DNS, and a
 * transient resolver outage must not make a deployment unbootable. The failing role instead gets
 * an empty address list, and the failure is recorded for the caller to warn about.
 *
 * @param {Map<string, string[]>} parsed - output of parseInternalHosts.
 * @param {(host: string, opts: {all: true}) => Promise<{address: string, family: number}[]>} [lookup] -
 *   defaults to `node:dns` promises `lookup`; override in tests to avoid real DNS.
 * @returns {Promise<{addresses: Map<string, string[]>, failures: {role: string, target: string, code: string}[]}>}
 *   addresses: role -> deduplicated CIDR strings. failures: one entry per target whose DNS lookup failed.
 */
export async function resolveInternalHosts(parsed, lookup = dns.promises.lookup) {
  const addresses = new Map();
  const failures = [];

  for (const [role, targets] of parsed) {
    const cidrs = new Set();
    for (const target of targets) {
      if (CIDR.test(target)) {
        cidrs.add(target);
        continue;
      }
      const host = stripPort(target);
      const literalFamily = isIP(host);
      if (literalFamily) {
        // Already an IP literal (dns.lookup would just pass it through) -- skip DNS entirely.
        cidrs.add(literalFamily === 6 ? `${host}/128` : `${host}/32`);
        continue;
      }
      try {
        const results = await lookup(host, { all: true });
        for (const { address, family } of results) {
          cidrs.add(family === 6 ? `${address}/128` : `${address}/32`);
        }
      } catch (err) {
        failures.push({ role, target, code: err?.code ?? String(err) });
      }
    }
    addresses.set(role, [...cidrs]);
  }

  return { addresses, failures };
}
