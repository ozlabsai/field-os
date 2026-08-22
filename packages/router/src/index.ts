// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

import { constantTimeEqual } from "@gadgets/backend-utils/constant-time";

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  // Present in production (wrangler.jsonc assets stanza); absent in dev.
  ASSETS?: Fetcher;
  // Optional shared-secret gate in front of the whole deployment, as `user:password`. Unset means
  // no gate, which is the right default for an airgapped install where the network is the boundary.
  //
  // On a Kubernetes deployment, treat this as known to anyone with repo write access. Helm needs
  // `list` on secrets, and a Kubernetes list returns full object bodies including `data` -- so a
  // deploy runner reads every secret in the namespace whether or not it was granted `get`.
  // Measured on the live cluster, not inferred: `kubectl auth can-i get secret/...` answered "no"
  // while a collection list returned the value in a 200 body. RBAC cannot express the difference;
  // an external secret store (Secret Manager via CSI) is the only fix if it ever matters.
  //
  // It does not matter today, because this is a deployment gate rather than an authentication
  // system (see below) -- but do not build anything on the assumption that the value is held
  // tightly.
  SITE_PASSWORD?: string;
  [key: string]: unknown;
}

// Shared-secret gate for a deployment reachable from the public internet before it is ready for
// one -- an Alpha on a real hostname, where the signup page would otherwise be open to strangers.
//
// This is a DEPLOYMENT gate, not an authentication system, and it is deliberately shallow: it does
// not identify anyone, and every FieldOS account check still applies behind it. What it buys is
// that a stranger who finds the hostname sees a password prompt instead of a signup form.
//
// Basic auth specifically because it needs no cookie, no session store and no login page, and every
// browser and `curl -u` speaks it. Over plain HTTP the credential is on the wire in base64, which
// is why the deployment should be HTTPS -- but a gate on HTTP is still strictly better than none.
function gateResponse(req: Request, expected: string): Response | null {
  const header = req.headers.get("Authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() === "basic" && encoded) {
    let supplied: string;
    try {
      supplied = atob(encoded);
    } catch {
      supplied = "";               // malformed base64 -- fall through to the challenge
    }
    if (constantTimeEqual(supplied, expected)) return null;
  }
  return new Response("Authentication required.\n", {
    status: 401,
    headers: {
      // The realm is what the browser shows in its prompt.
      "WWW-Authenticate": 'Basic realm="FieldOS", charset="UTF-8"',
      "content-type": "text/plain",
      // A 401 must never be cached, or a browser can pin the failure past a password change.
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Before everything, including the asset service -- a gate that let the SPA load would still
    // hand a stranger the signup page.
    //
    // Two exemptions, both for callers that CANNOT present credentials and whose failure is worse
    // than the exposure:
    //
    //   /healthz                   the kubelet and the GCE load balancer probe it. Gating it takes
    //                              the deployment down rather than protecting it, and it returns
    //                              no user data -- only whether the backend worker answers.
    //   /.well-known/acme-challenge  HTTP-01 certificate validation (GKE ManagedCertificate,
    //                              Let's Encrypt, cert-manager). Gating it silently prevents TLS
    //                              from ever being issued.
    //
    // The second was learned the hard way: with it gated, a managed certificate sat in
    // FAILED_NOT_VISIBLE indefinitely, which is the SAME status a certificate shows while it is
    // simply still provisioning. The gate produced a symptom indistinguishable from ordinary
    // waiting, on a deployment that was otherwise entirely healthy.
    //
    // `/.well-known/` more broadly is reserved for exactly this class of well-known unauthenticated
    // lookup (RFC 8615), so exempting the whole prefix is both simpler and less likely to need
    // revisiting than enumerating one challenge type.
    const exempt = url.pathname === "/healthz" || url.pathname.startsWith("/.well-known/");
    if (env.SITE_PASSWORD && !exempt) {
      const challenge = gateResponse(req, env.SITE_PASSWORD);
      if (challenge) return challenge;
    }

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
    // Reaching the backend proves both workers are executing. It stops there on purpose: no RPC
    // session and no Durable Object storage read on the hot path, so it is cheap enough to run
    // every few seconds and cannot fail the deployment over storage problems a restart would not
    // fix.
    //
    // Not quite free, and the exception is load-bearing. `GET /api` fires the format-blueprint
    // install (`server.ts:907-923`) once per isolate, guarded by module scope -- so after an
    // isolate recycle the next probe pays a DO wake, and on a FRESH DEPLOYMENT the probe is what
    // provisions it. That trigger is hung off first API traffic precisely because the AdminSettings
    // DO does not wake on deploy, and in a container the kubelet's probe is the first visitor.
    // Anyone "optimizing" this to a cheaper endpoint would silently move provisioning back to the
    // first human visit.
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
