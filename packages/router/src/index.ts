// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  // Present in production (wrangler.jsonc assets stanza); absent in dev.
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    // Liveness, for an orchestrator that restarts a wedged deployment (a runaway gadget can stall
    // the process; see OZL-239). Deliberately NOT served from this worker alone: the failure this
    // has to catch is the API being unreachable while the asset service still answers, so a probe
    // that only proves the router is running reports healthy through exactly that outage --
    // which is what `GET /` does today, and why the watchdog's own check is weak.
    //
    // Reaching the backend proves both workers are executing. It stops there on purpose: it opens
    // no RPC session and touches no Durable Object, so it stays cheap enough to run every few
    // seconds and cannot fail the deployment over storage problems that a restart would not fix.
    if (url.pathname === "/healthz") {
      try {
        // A response from the binding means the backend's isolate ran, and it proves more than
        // that a function returned: `GET /api` comes out the far side of the format-blueprint
        // install (`ctx.waitUntil(ctx.exports.AdminSettings...)`), the optional CF Access JWT
        // verification, and `new PublicApiImpl(...)` before capnweb refuses it with 400
        // (server.ts:902-955). So a healthy answer proves module-scope state, `ctx.exports` and
        // constructor execution. Do not weaken this to something cheaper on the assumption that
        // it only checks reachability. Status is deliberately NOT checked for `ok`,
        // since the healthy answer is a 4xx; what is checked is that a Response came back through
        // the service binding rather than the binding throwing, which is the actual liveness
        // signal. (`GET`, not `POST`: a POST returns 500 from capnweb parsing an empty batch,
        // and a probe whose healthy answer is 500 will be misread by whoever reads it next.)
        const res = await env.WORKSHOP_BACKEND.fetch(new URL("/api", url).toString());
        return new Response(`ok (backend ${res.status})\n`,
            { headers: { "content-type": "text/plain" } });
      } catch (err) {
        return new Response(`backend unreachable: ${err}\n`, {
          status: 503, headers: { "content-type": "text/plain" },
        });
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return env.WORKSHOP_BACKEND.fetch(req);
  },
} satisfies ExportedHandler<Env>;
