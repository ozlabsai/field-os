// Reusable standalone-workerd boot harness, generalized from
// packages/fieldos-runtime/__tests__/workerd.test.js. Each tier-1 fixture in this package gets
// its own directory and capnp config, but all of them boot the same way.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve the pinned binary rather than whatever `workerd` resolves to — two versions are in the
 * pnpm store (this repo pins fieldos-runtime and the root devDependency separately), and the
 * protocol framings are only valid for the one this package actually depends on. */
const WORKERD = fileURLToPath(import.meta.resolve("workerd/bin/workerd"));

/**
 * Boot the pinned workerd binary against a fixture's capnp config and resolve once it reports
 * the port it bound.
 *
 * Binds `--socket-addr=http=127.0.0.1:0` (port 0) so the OS assigns a free port — a fixed port
 * makes the suite flake under a parallel CI job or a leftover process from a manual run.
 * `--control-fd=3` makes workerd write a JSON `listen` event naming the bound port once it's
 * ready, removing the need to poll for readiness.
 *
 * workerd refuses to boot if a Durable Object's local-disk storage directory doesn't already
 * exist, so callers whose fixture uses `durableObjectStorage` must create it (and clean it up)
 * themselves — this harness doesn't assume every fixture has one.
 *
 * @param {object} options
 * @param {string} options.fixtureDir - Absolute path to the directory containing the config file
 *   (and any files it embeds). workerd runs with this as its cwd.
 * @param {string} [options.configFile] - capnp config file name, resolved relative to
 *   `fixtureDir`. Defaults to `"fixture.capnp"`.
 * @param {string[]} [options.extraArgs] - Additional workerd CLI args, e.g. `["--experimental"]`
 *   for configs that use worker loaders.
 * @returns {Promise<{base: string, ports: Record<string, number>,
 *                    proc: import("node:child_process").ChildProcess, stop: () => void}>}
 *   `base` is the `http://127.0.0.1:<port>` origin the fixture's socket is listening on.
 *   `ports` maps socket name to bound port for configs declaring more than one (it fills in as
 *   each socket reports, so a second socket's entry appears shortly after this resolves).
 *   `stop()` SIGKILLs the process — a wedged workerd does not honor SIGTERM (see
 *   plans/handoff.md's traps), so a graceful signal here would just make cleanup unreliable.
 */
export async function startWorkerd({ fixtureDir, configFile = "fixture.capnp", extraArgs = [] }) {
  const proc = spawn(
    WORKERD,
    ["serve", configFile, "--socket-addr=http=127.0.0.1:0", "--control-fd=3", ...extraArgs],
    { cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  proc.stderr?.on("data", (b) => process.env.DEBUG_WORKERD && console.error(String(b)));

  // Every socket in the config reports its own `listen` event, keyed by socket name. Most fixtures
  // declare one and only care about its port; a config with a second socket (e.g. --interceptor's
  // readback socket) gets them all through `ports`. Resolving on the FIRST event is what makes
  // this work without knowing how many are coming -- a config's first socket is the one callers
  // mean by `base`, and later events keep arriving into the same map afterwards.
  /** @type {Record<string, number>} */
  const ports = {};
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("workerd did not report a port")), 20_000);
    proc.stdio[3]?.on("data", (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.event === "listen" && event.port) {
          if (event.socket) ports[event.socket] = event.port;
          clearTimeout(timer);
          resolve(event.port);
        }
      }
    });
    proc.on("exit", (code) => reject(new Error(`workerd exited early with code ${code}`)));
  });

  return {
    ports,
    base: `http://127.0.0.1:${port}`,
    proc,
    stop() {
      proc.kill("SIGKILL");
    },
  };
}

/** Create a Durable Object local-disk storage directory, removing any stale contents first.
 * workerd fails to boot with `Directory named "<name>" not found` if this doesn't already exist.
 * @param {string} dir */
export function resetDoStorage(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
