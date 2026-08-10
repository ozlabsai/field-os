using Workerd = import "/workerd/workerd.capnp";

# Same flag set as fixture-accepted.capnp, plus `enable_ctx_exports` -- the flag
# scripts/run-workerd.mjs:277-280 (compatibilityFlags()) strips from every worker's config because
# it is a FATAL config error at compatibilityDate = "2026-02-02" for the pinned workerd binary.
# This fixture pins that reason: if a future workerd bump ever accepted the flag at this date, this
# fixture would start booting and the corresponding test would go red, which is the signal that the
# strip in run-workerd.mjs can be removed (or must be updated for a different date).

const config :Workerd.Config = (
  services = [ (name = "main", worker = .probeWorker) ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-02-02",
  compatibilityFlags = [
    "allow_irrevocable_stub_storage",
    "enhanced_error_serialization",
    "global_fetch_strictly_public",
    "nodejs_compat",
    "nodejs_als",
    "enable_ctx_exports",
  ],
);
