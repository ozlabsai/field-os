using Workerd = import "/workerd/workerd.capnp";

# The union of every compatibility flag used by a real deployment worker, taken verbatim from the
# committed wrangler.jsonc files (not invented here):
#   workshop-backend:      allow_irrevocable_stub_storage, enhanced_error_serialization,
#                           global_fetch_strictly_public, nodejs_compat
#   gatekeeper-mcp(-portal): allow_irrevocable_stub_storage, global_fetch_strictly_public
#   gatekeeper-context:     nodejs_compat, allow_irrevocable_stub_storage
#   gatekeeper-github/-oidc/-scheduler: allow_irrevocable_stub_storage, nodejs_als
#   gatekeeper-homeassistant: allow_irrevocable_stub_storage
# At compatibilityDate = "2026-02-02" (the date every wrangler.jsonc pins), the pinned workerd
# binary must accept all of these together, or the airgapped deployment (scripts/run-workerd.mjs)
# fails to boot on the next flag addition. This fixture is the positive control for
# fixture-rejected.capnp's negative case.

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
  ],
);
