using Workerd = import "/workerd/workerd.capnp";

# Does a DurableObjectId created by idFromName() carry `.name` back to the caller?
#
# `#isAdmin()` in workshop-backend reads `this.user.id.name` and compares it against ADMINS, so if
# workerd drops that property the admin check silently denies everyone -- indistinguishable from a
# correctly-configured deployment with no admins. Four other call sites read it too.

const config :Workerd.Config = (
  services = [ (name = "main", worker = .probeWorker) ],
  sockets = [ (name = "http", address = "*:8817", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
    (className = "Probe", uniqueKey = "workerd-tests-do-id-name", enableSql = true),
  ],
  durableObjectStorage = (inMemory = void),
  bindings = [ (name = "PROBE", durableObjectNamespace = "Probe") ],
);
