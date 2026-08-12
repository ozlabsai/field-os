using Workerd = import "/workerd/workerd.capnp";

# PROBE fixture for OZL-239 facet storage locality. A "Parent" DO namespace (with real disk
# storage) creates a facet named "child" via ctx.facets.get(), backed by a durableObjectClass
# binding to "Child" (per workerd.capnp:380-382: "A Durable Object class binding, without an
# actual storage namespace. This can be used to implement a facet."). We write distinct values
# into ctx.storage inside the parent and inside the facet, then inspect what lands on disk.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "dodisk", disk = (path = "dodata", writable = true)),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

# durableObjectClass (workerd.capnp:380) is a ServiceDesignator -- it names a *service*, with an
# optional `entrypoint` naming a specific export on that service's worker. Both Parent and Child
# are exported from the same store.js module here, so we declare that module as one worker but
# expose it under two service names, and point CHILD_CLASS at the "main" service's "Child" export.
const mainWorker :Workerd.Worker = (
  modules = [ (name = "store.js", esModule = embed "store.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
    (className = "Parent", uniqueKey = "ozl239-probe-parent", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [
    (name = "PARENT", durableObjectNamespace = "Parent"),
    # Facet class binding: no storage namespace of its own, per the capnp doc comment. Points at
    # the "Child" named export on this same worker (service "main").
    (name = "CHILD_CLASS", durableObjectClass = (name = "main", entrypoint = "Child")),
  ],
);
