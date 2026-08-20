// The entrypoint's FIELDOS_PORT parsing.
//
// This exists because of a bug only a real cluster could produce. Kubernetes injects legacy
// Docker-link service-discovery variables into every pod: for a Service named `fieldos` that is
// `FIELDOS_PORT=tcp://10.30.11.195:80`, which collides by name with the entrypoint's own port
// variable. workerd was handed `NaN` and died with `DNS lookup failed; params.service = NaN` --
// an error naming neither the variable nor the Service that produced it.
//
// Docker performs no such injection, so container testing was structurally incapable of catching
// it; the pod CrashLoopBackOff'd on the first real deploy. This pins the fix without needing a
// cluster, by running the same `case` the entrypoint runs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(ROOT, "docker-entrypoint.sh");

// Extract the real `case` block rather than restating it, so the test cannot drift from the shell
// it is meant to pin -- a copy would keep passing after someone edited the entrypoint.
function portLogic() {
  const source = readFileSync(ENTRYPOINT, "utf8");
  const match = /case "\$\{FIELDOS_PORT:-\}" in[\s\S]*?\nesac/.exec(source);
  assert.ok(match, "could not find the FIELDOS_PORT case block in docker-entrypoint.sh");
  return match[0];
}

function resolvePort(value) {
  return execFileSync("sh", ["-c", `${portLogic()}\necho "$PORT"`], {
    encoding: "utf8",
    env: value === undefined ? { PATH: process.env.PATH } : { PATH: process.env.PATH, FIELDOS_PORT: value },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("entrypoint FIELDOS_PORT", () => {
  it("uses a numeric value", () => {
    assert.equal(resolvePort("9090"), "9090");
  });

  it("defaults when unset or empty", () => {
    assert.equal(resolvePort(undefined), "8080");
    assert.equal(resolvePort(""), "8080");
  });

  it("ignores Kubernetes' injected $SERVICE_PORT value", () => {
    // The exact shape that crashed the first real deploy.
    assert.equal(resolvePort("tcp://10.30.11.195:80"), "8080");
  });

  it("ignores any other non-numeric value rather than passing it through", () => {
    for (const bad of ["abc", "80a", " 80", "80 ", "-1"]) {
      assert.equal(resolvePort(bad), "8080", `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});
