using Workerd = import "/workerd/workerd.capnp";

# Exercises the same worker-loader shape overseer.ts#loadGadgetWorker uses: a dynamic worker is
# loaded from env.LOADER.get(key, factory). This fixture's host worker doesn't care what the key
# means -- the test drives identity/caching semantics from the JS side by passing whatever key it
# wants per request.
#
# Worker loaders require --experimental (passed by the test harness, not baked in here since it's
# a CLI flag rather than config).

const config :Workerd.Config = (
  services = [ (name = "main", worker = .hostWorker) ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const hostWorker :Workerd.Worker = (
  modules = [ (name = "host.js", esModule = embed "host.js") ],
  compatibilityDate = "2026-02-02",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [ (name = "LOADER", workerLoader = ()) ],
);
