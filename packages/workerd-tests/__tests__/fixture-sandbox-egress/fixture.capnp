using Workerd = import "/workerd/workerd.capnp";

# Exercises the same worker-loader shape overseer.ts uses to run gadget code
# (packages/workshop-backend/src/overseer.ts, loadGadgetWorker): a dynamic worker is loaded with
# `globalOutbound: null`, so it has no route to the network at all. This is the largest untested
# surface in the fork — a regression here would silently let gadget code reach the internet.
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
