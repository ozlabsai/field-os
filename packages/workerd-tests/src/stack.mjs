// Tier 2: boot a real, subset FieldOS stack on standalone workerd.
//
// Tier 1 hand-writes a capnp fixture per case, which is what makes it fast and focused. That is
// also its ceiling: a fixture supplies its own `env`, so it can never catch the parent worker's
// bindings leaking into a dynamically-loaded gadget. Tier 2 exists for the properties that only
// hold once the *real* workshop-backend is the thing loading the gadget.
//
// The stack is produced by the deployment's own generator (scripts/run-workerd.mjs --only), not by
// a test-only config. That is deliberate: a bespoke capnp here would drift from what actually
// ships, and the translation step is itself part of what tier 2 is meant to cover.
//
// COST. Bundling is linear in worker count and there is no incremental caching, so the build is
// the expensive part -- measured at ~12s for two workers, dominated by workshop-backend's
// capnweb-validate custom build. Call startStack() ONCE PER TEST FILE (beforeAll), never per test.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startWorkerd } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

// Build inside the repo rather than the OS temp dir. The generator embeds modules by a path
// *relative to --out* (run-workerd.mjs's `relative(args.out, ...)`), and on macOS the temp dir is
// reached through a symlink -- `/var/...` where the real path is `/private/var/...` -- so a
// relative chain computed from it comes out one level short and every `embed` fails to resolve.
// Keeping the build under a known-real path inside the repo sidesteps that entirely.
// Gitignored as .workerd-tier2/ alongside the existing .workerd/.
const BUILD_ROOT = join(ROOT, ".workerd-tier2");

/**
 * The cheapest stack that can run a gadget: the backend that owns the Worker Loader, and the
 * router that fronts it. No gatekeeper is bound -- verified that this boots and serves, and the
 * sandbox cases bind no gatekeeper, so paying to bundle one would buy nothing.
 */
export const CORE_STACK = ["workshop-backend", "router"];

/**
 * Build a subset config with the real generator, boot workerd on it, and return the origin.
 *
 * `--allow public` rather than the default `public,private`: nothing here should reach the
 * internal network, and a test runner's real egress is exactly how an escape passes silently.
 *
 * @param {object} [options]
 * @param {string[]} [options.only] - Packages to include; defaults to {@link CORE_STACK}.
 *   workshop-backend and router are always included by the generator regardless.
 * @param {string[]} [options.allow] - `--allow` entries. Defaults to `["public"]`.
 * @param {string} [options.inferenceHost] - `host:port` of a stub inference server (see
 *   stub-inference.mjs), e.g. `"127.0.0.1:1234"`. Passed to the generator as
 *   `FIELDOS_INTERNAL_HOSTS=inference=<host>`, which is read at BUILD time -- so the stub must
 *   already be listening before `startStack()` is called, not merely before workerd boots.
 *   Omitting it leaves the existing default behavior (no internal hosts declared) unchanged.
 * @returns {Promise<{base: string, url: URL, outDir: string, stop: () => void}>}
 *   `base` is the origin workerd bound; `url` is the same as a URL, for rpc-client's `connect()`.
 *   `stop()` kills workerd and removes the build directory.
 */
export async function startStack(
    { only = CORE_STACK, allow = ["public"], inferenceHost } = {}) {
  mkdirSync(BUILD_ROOT, { recursive: true });
  const outDir = mkdtempSync(join(BUILD_ROOT, "stack-"));

  // Fail loudly and with the generator's own stderr: a config that did not build is not a test
  // failure to debug from a boot timeout twenty seconds later.
  try {
    execFileSync("node", [
      join(ROOT, "scripts/run-workerd.mjs"),
      "--build-only", "--out", outDir,
      "--only", only.join(","),
      "--allow", allow.join(","),
    ], {
      cwd: ROOT,
      stdio: "pipe",
      env: inferenceHost
          ? { ...process.env, FIELDOS_INTERNAL_HOSTS: `inference=${inferenceHost}` }
          : process.env,
    });
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    // execFileSync attaches the child's stderr to the thrown error; it is the only place the
    // generator's own message (an unknown --only name, a bad --allow entry) survives.
    const detail = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
    throw new Error(
        `tier-2 stack failed to build (--only ${only.join(",")}):\n${detail}`, { cause: err });
  }

  // --experimental is required for the LOADER binding, which is the whole point of the suite.
  // The generated config lives at <outDir>/config.capnp and embeds bundles by relative path, so
  // workerd must run with outDir as its cwd -- startWorkerd does that.
  const workerd = await startWorkerd({
    fixtureDir: outDir,
    configFile: "config.capnp", // what run-workerd.mjs writes; startWorkerd defaults to fixture.capnp
    extraArgs: ["--experimental"],
  });

  return {
    base: workerd.base,
    url: new URL(workerd.base),
    outDir,
    stop() {
      workerd.stop();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
