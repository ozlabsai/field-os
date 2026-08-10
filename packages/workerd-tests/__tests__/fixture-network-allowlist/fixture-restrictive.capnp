using Workerd = import "/workerd/workerd.capnp";

# `allow = ["public"]` only: loopback (127.0.0.0/8) is not publicly routable, so any 127.x address
# must be blocked, even one with a live local listener.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probeWorker),
    (name = "net", network = (allow = ["public"])),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-02-02",
  globalOutbound = "net",
);
