using Workerd = import "/workerd/workerd.capnp";

# A single Durable Object namespace backed by local-disk storage, generalizing what
# packages/fieldos-runtime/__tests__/workerd.test.js already does for KV/R2/assets into a focused
# DO-only durability check.
#
# `uniqueKey` is a fixed string literal here rather than generated per run -- this is the whole
# point. scripts/run-workerd.mjs persists its generated uniqueKey to .workerd/keys.json precisely
# because a *different* uniqueKey on restart makes workerd address a different (empty) DO, so a
# durability test that regenerated it would read back nothing, fail to notice, and pass vacuously.
# A fixture file doesn't have that failure mode: the same fixture.capnp is reused verbatim across
# both boots in the test, so uniqueKey never changes.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .storeWorker),
    (name = "dodisk", disk = (path = "dodata", writable = true)),
  ],
  sockets = [ (name = "http", address = "*:8813", http = (), service = "main") ],
);

const storeWorker :Workerd.Worker = (
  modules = [ (name = "store.js", esModule = embed "store.js") ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
    (className = "Counter", uniqueKey = "workerd-tests-do-durability", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "COUNTER", durableObjectNamespace = "Counter") ],
);
