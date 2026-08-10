// Loads a dynamic worker via the LOADER binding (a workerLoader), mirroring
// overseer.ts#loadGadgetWorker's shape, then asks it to attempt an outbound fetch and reports
// whether that fetch succeeded.
//
// `?permissive=1` omits `globalOutbound` instead of setting it to `null`, which restores workerd's
// normal default (route through "internet") — used only by the deliberate red-check the test
// suite runs, to prove the assertion can actually fail.

const SANDBOXED_WORKER_CODE = `
  export default {
    async fetch(req) {
      try {
        await fetch("http://example.com");
        return new Response("egress-succeeded");
      } catch (err) {
        return new Response("egress-blocked: " + err);
      }
    }
  }
`;

export default {
  /** @param {Request} req @param {{LOADER: import("@cloudflare/workers-types/experimental").WorkerLoader}} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    const permissive = url.searchParams.get("permissive") === "1";

    // Cache key includes the mode so the two test paths (blocked vs. deliberately permissive)
    // never share a loaded worker instance.
    const stub = env.LOADER.get(`sandbox-egress-probe-${permissive}`, () => ({
      compatibilityDate: "2026-02-02",
      mainModule: "sandbox.js",
      modules: { "sandbox.js": SANDBOXED_WORKER_CODE },
      ...(permissive ? {} : { globalOutbound: null }),
    }));

    const result = await (await stub.getEntrypoint().fetch("http://sandbox/")).text();
    return Response.json({ egressSucceeded: result === "egress-succeeded", detail: result });
  },
};
