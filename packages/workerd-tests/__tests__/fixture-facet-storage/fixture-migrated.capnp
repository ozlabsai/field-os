using Workerd = import "/workerd/workerd.capnp";

# The "after migration" config for facet-storage.test.js. Same uniqueKey as fixture.capnp, but an
# ORDINARY Durable Object namespace -- no facets, no durableObjectClass binding -- reading from
# `dodata-migrated`, where the test copies a facet's raw sqlite file under the filename a normal
# DO expects. Proves a facet's storage file needs no conversion to be adopted by a plain DO.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "dodisk", disk = (path = "dodata-migrated", writable = true)),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "migrated.js", esModule = embed "migrated.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
    # Same uniqueKey as fixture.capnp's Parent: the on-disk directory name is derived from it, so
    # a different key here would address a different (empty) tree and the read would prove nothing.
    (className = "Reader", uniqueKey = "ozl239-probe-parent", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "READER", durableObjectNamespace = "Reader") ],
);
