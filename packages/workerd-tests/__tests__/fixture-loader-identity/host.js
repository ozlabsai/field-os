// Loads a dynamic worker via the LOADER binding keyed by `?key=`, mirroring
// overseer.ts#loadGadgetWorker's `env.LOADER.get(key, factory)` shape. The sandboxed worker
// captures a module-scope counter that increments per request; the test asserts on isolate
// identity through it: same key across requests -> the counter keeps advancing (the isolate was
// reused), different key -> the counter restarts at 1 (a new isolate was created).
//
// module scope can't do I/O or generate randomness (workerd rejects fetch/setTimeout/crypto.* at
// top level -- "Disallowed operation called within global scope"), so this can't use
// crypto.randomUUID() to mint an identity; a plain incrementing counter is both legal at module
// scope and sufficient to distinguish isolates.

const SANDBOXED_WORKER_CODE = `
  let requestCount = 0;
  export default {
    async fetch(req) {
      requestCount++;
      return Response.json({ requestCount });
    }
  }
`;

export default {
  /** @param {Request} req @param {{LOADER: import("@cloudflare/workers-types/experimental").WorkerLoader}} env */
  async fetch(req, env) {
    const key = new URL(req.url).searchParams.get("key");
    if (!key) return Response.json({ error: "missing ?key=" }, { status: 400 });

    const stub = env.LOADER.get(key, () => ({
      compatibilityDate: "2026-02-02",
      mainModule: "sandbox.js",
      modules: { "sandbox.js": SANDBOXED_WORKER_CODE },
    }));

    return stub.getEntrypoint().fetch("http://sandbox/");
  },
};
