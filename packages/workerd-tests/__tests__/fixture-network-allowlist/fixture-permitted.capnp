using Workerd = import "/workerd/workerd.capnp";

# `allow = ["public", "127.0.0.1/32"]`: carves out exactly one loopback address. 127.0.0.1 must be
# reachable; a different loopback address (127.0.0.2, still in 127.0.0.0/8 but not matching the
# /32) must still be blocked, proving the allow-list is address-specific and not a blanket loopback
# exception.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probeWorker),
    (name = "net", network = (allow = ["public", "127.0.0.1/32"])),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-02-02",
  globalOutbound = "net",
);
