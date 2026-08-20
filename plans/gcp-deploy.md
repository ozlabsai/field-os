# GCP deployment — Alpha

Written 2026-08-20. Plan for taking `v0.1.0-alpha.1` from "runs on a developer's laptop under
`run-workerd.mjs`" to "installable in a customer's GCP project".

Read [`handoff.md`](./handoff.md) first. This plan follows its verification posture: every claim
below is marked **VERIFIED** (executed, with the command) or **INFERRED**. Two claims the previous
session recorded as fact turned out to be inference; the same discipline applies here.

## The decision

**GKE Standard, StatefulSet with one replica, PD volume bound `ReadWriteOncePod`, deployed by
Helm.**

Two reasons, in order:

1. **It is the only option that can *enforce* single-writer.** Every durable byte lives in SQLite
   files on a local disk (`localDisk` DO storage). `ReadWriteOncePod` — GA since Kubernetes 1.29,
   supported on GKE via the PD CSI driver — restricts a volume to "a single Pod only", cluster-wide.
   Plain `ReadWriteOnce` is a *per-node* guarantee, so two pods co-scheduled on one node can both
   mount it read-write, which is exactly what a careless rolling update produces.
2. **It is a customer-run deployment, not a service we host.** GKE runs in the customer's project,
   their VPC, their private registry, with no public egress. That is the shape an airgapped or
   regulated buyer can accept, and it ports to on-prem Kubernetes later with the same chart.

**Cloud Run is disqualified, not merely worse.** Its persistent volume options are Cloud Storage
FUSE and NFS. Google's own documentation states GCS FUSE "does not provide concurrency control for
multiple writes (file locking) to the same file... the last write wins." SQLite over a filesystem
without working locks corrupts. That is a hard blocker, not a tuning problem.
[VERIFIED — [Cloud Storage volume mounts](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)]

**Runner-up: a single GCE VM running the container.** Fewer moving parts than Kubernetes and the
single-writer property is trivial (one VM, one disk). It flips to first place if the customer has no
Kubernetes and no appetite to acquire it — a realistic outcome worth keeping cheap. The chart and the
image are separable precisely so this stays a packaging choice rather than a rebuild.

| | GKE + RWOP | Cloud Run | GCE VM / MIG=1 | GKE Autopilot |
|---|---|---|---|---|
| Single-writer | **enforced by CSI** | no file locking | trivial (one VM) | enforced |
| Durable block storage | PD, snapshottable | FUSE/NFS only | PD, snapshottable | PD |
| WebSocket (long-lived) | unlimited | request-timeout capped | unlimited | unlimited |
| Customer-run / airgap | yes | yes | yes | restricts some pod config |
| Ops complexity | medium | low | **low** | medium |

*Autopilot is not chosen: it constrains pod-level settings and gives nothing here, since we run
exactly one pod. INFERRED — I did not enumerate its current restrictions against our pod spec.*

## What the architecture forces

Four facts drive every design choice below. All VERIFIED by reading and running the code.

**All state is local SQLite.** `run-workerd.mjs:557,587,601` emit
`durableObjectStorage = (localDisk = "do-disk")`. There is no external database.

**`keys.json` is state, not build output.** `run-workerd.mjs:312-318`: absent, `uniqueKeyFor()` mints
fresh UUIDs, workerd creates new empty DO directories, and **the stack boots healthy while every
existing user's data becomes unaddressable on the same volume**. No migration mechanism exists. This
is the single most dangerous property in the containerization: total data loss presenting as a
successful fresh install.

**`--out` conflates four different lifetimes.** Bundles (`:269`), `keys.json` (`:312`), `do-disk`
(`:657`), `config.capnp` (`:753`). Two belong in the image, two on the volume.

**The generated config mixes absolute and `--out`-relative paths, so `--out` is not freely
relocatable.** Two different schemes in one file:
- `do-disk` and the frontend `dist` are embedded **absolute** (`config.capnp:268-269`) — these break
  if the runtime directory differs from the build directory.
- The `fieldos-runtime` modules are embedded **relative to `--out`** (`:582,596,611` use
  `relative(args.out, ...)`) — these break if `--out` is far from the repo.

VERIFIED the hard way: `--out /tmp/hz-probe` generated a config that wrote fine, exited 0, and then
failed at boot with `Couldn't read file for embed: ../../Users/.../fieldos-runtime/src/kv.js`. The
handoff's predicted shape exactly — late, and naming a file rather than the flag that caused it.

Two consequences for the image: config must be generated **at boot inside the container** (which
also solves the freezing problem below), and the image layout must keep `--out` beside the repo
rather than scattering directories.

## Corrections to assumptions (read before starting)

**One image serves every customer. Do not set `VITE_BACKEND_HOST`.**
VERIFIED: built with `env -u VITE_BACKEND_HOST` and grepped the output. No backend host is baked;
the only `localhost:8787` is the literal inside `main.tsx:67`'s ternary, guarded by
`hostname === 'localhost'`. On any real hostname `getBackendHost()` returns `window.location.host`.
The router serves the SPA, `/api` and the gatekeepers on one origin (`router/src/index.ts`), so
same-origin is the actual topology. **The documented trap is caused by *setting* the variable** —
correct for a localhost stack, wrong for a deployment. (Now fixed in handoff.md by PR #116.)

**`--build-only` bakes configuration into the image.** It writes `config.capnp` at `:753` and exits
at `:812` — *after*. Baking with it freezes that container's `ADMINS`, CA bundle and session ceilings
into a layer. Needs a new `--bundle-only` stopping before `:753`.
VERIFIED: every `process.env` read is at `:196,214,215,245,484,494,509` — all config-generation;
bundling is `:262-304`. The split is clean.

**The image build works with no internet.** VERIFIED: `wrangler deploy --dry-run --outdir` completed
with `HTTP_PROXY`/`HTTPS_PROXY` blackholed to a dead port, producing real bundle output. Matters
because a customer's CI may be as isolated as their runtime.

**`--experimental` is permanent and is the sandbox.** It gates the `worker_loaders` binding
(`workshop-backend/wrangler.jsonc:80`), which is how gadgets execute at all. Without it workerd
rejects the config outright — the deployment has no product, it does not degrade. Ship it forever.
Good news: the closed-beta gate on Worker Loaders is Cloudflare's *platform*, not the runtime, so
self-hosting sidesteps an entitlement.

**"Two writers corrupts" is INFERRED.** Nobody has run two workerd processes against one do-disk.
Design for it anyway — the cost asymmetry is total data loss versus a stuck pod — but do not cite it
as established.

## Prerequisites (code changes before any YAML)

Small, and each earns its place. Kernel discipline applies: `workshop-backend` and `workshop-shared`
diffs stay minimal.

**P1 — `--bundle-only` flag** (`run-workerd.mjs`, ~5 lines). Stops after bundling, before config
generation, so an image can bake bundles without baking configuration.

**P2 — separate state from build output** (`run-workerd.mjs`, ~15 lines). A `--state <dir>` flag
placing `do-disk/` and `keys.json` on the volume while `bundles/` and `config.capnp` stay in the
image/ephemeral. Today `--out` cannot express this.

**P3 — `/healthz` on the router** (~10 lines). There is **no health endpoint** — VERIFIED, grep for
`healthz|/health|readiness` across router and backend returns nothing. The watchdog's `probeHealthy()`
(`:844`) fetches `GET /` and accepts `status < 500`, which is precisely the check that returns 200
while the API is unreachable. A k8s liveness probe on `/` would keep a pod with a dead API alive
indefinitely — strictly worse than the watchdog, which is at least documented as weak. `/healthz`
must prove the *backend worker* answers, not just the asset service.

**P4 — assert, never mint, `keys.json` when a volume is attached.** Guard against the silent
data-loss path above: if the state directory exists but `keys.json` does not, refuse to start rather
than generating new keys. Fail loudly on the one path whose failure is otherwise invisible.

## Deliverables

**D1 — `Dockerfile`, multi-stage.**
Build stage: full pnpm workspace + wrangler, runs `pnpm build` then `--bundle-only`.
Runtime stage: workerd binary, bundles, `fieldos-runtime/src/*.js` (embedded by path at config-gen,
so needed at *runtime*), frontend `dist`, node for config generation. `linux/amd64`, workerd pinned
to `1.20260801.1` — never `latest`, per the top platform risk.

**D2 — entrypoint.** Generates `config.capnp` from live env + mounted state, then `exec`s workerd as
PID 1. No in-process watchdog (`--no-watchdog`); the kubelet owns restarts. One restart mechanism,
not two nested.

**D3 — Helm chart.** StatefulSet, `replicas: 1`, `ReadWriteOncePod` PVC, `podManagementPolicy` and
update strategy chosen so no two pods ever overlap. Liveness/readiness on `/healthz`. Low
`terminationGracePeriodSeconds` — SIGTERM is ignored by a wedged workerd (VERIFIED in `respawn()`,
`:860`), so SIGKILL is the normal path, not an escalation. Values for `ADMINS`,
`FIELDOS_INTERNAL_HOSTS`, CA bundle, session bounds, org separation. Secrets as `Secret`, not
`values.yaml`.

**D4 — restore rehearsal — DONE, 2026-08-20. PASSED.**
Executed against a container and a real volume: write data → back up live → `kill -9` mid-write →
wipe → restore → read back over the API. The pre-crash user logs in, their workspace opens, its
title reads back intact. `packages/integration-tests/restore-rehearsal.mjs`.

Three things it produced beyond the pass:

- **The first PASS was worthless.** A negative control (skip the restore; it must fail) *passed* —
  because the volume name was hardcoded while `--container` was a flag, so the control wiped one
  volume and measured another. Fixed; skipping the restore now fails cleanly. Without the control
  this would have shipped as a green rehearsal proving nothing.
- **`backup-do-disk.mjs` does not back up `keys.json`** (`grep` returns nothing). It copies the DO
  databases but not the file that *names their directories*, so a restore from it alone yields a
  deployment that cannot address its own data. The rehearsal copies it separately; fixing the
  backup script is a follow-up and is adjacent to OZL-229.
- **A `listGadgets()` assertion was dropped, not fixed.** A bare `newGadget()` is *provisional* and
  hidden from the listing, so it measured the provisional filter rather than the restore and failed
  identically with no crash at all.

**Superseded — the original plan text:** `fieldos.md:415` already names restore rehearsal as the
mitigation for the top platform risk, so this closes a gap the design opened. Backup → fresh volume
→ restore → **open a workspace in the UI**. Row counts are not sufficient: a torn WAL pair restores,
opens, passes `quick_check`, and is quietly missing its most recent commits — which is the exact
failure `backup-do-disk.mjs` exists to prevent. Doing it in a container against a fresh volume tests
what customers will actually do; a rehearsal on the dev box, with `.workerd` sitting there at correct
paths and ownership, would prove something misleadingly easier.

**D5 — `docs/deployment-gcp.md`.** Install, upgrade (stop → back up → swap image → start; never a
rolling update), backup/restore, and the two experimental-surface risks stated plainly as one bet.

## Sequence

1. P1–P4 (code), each with a test. Send diffs to the engineering session for review — kernel rules.
2. D1+D2, verified by running the container locally against a scratch volume.
3. ~~D4 restore rehearsal before the chart.~~ **Done** — and it earned its place in the order:
   it surfaced the `keys.json` backup gap while the design could still absorb it.
4. D3 chart, verified on a real GKE cluster.
5. D5 docs.

## Traps this work hit

- **A fresh `git worktree` has no `node_modules` AND no gitignored generated sources.** Tests fail
  with `ERR_MODULE_NOT_FOUND: jsonc-parser`, which reads as a code error; the real cause is that
  `packages/workshop-backend/src/generated/format-blueprints.ts` is produced by `pnpm build`. Run
  `pnpm install && pnpm build` in any new worktree. Cost two wrong guesses before reading the error.
- **`--build-only` re-bundles.** The bundling loop rebuilds unconditionally before config
  generation, so the split is at *two* points, not one — hence `--use-bundles`. A container that
  only skipped config generation would still need the full build toolchain.
- **pnpm's layout defeats hand-picked `COPY`s, and two workerd versions are present.**
  `node_modules/workerd` is a symlink into `.pnpm/`; the tree carries both `1.20260722.1`
  (transitive) and the pinned `1.20260801.1`. Copy `node_modules` wholesale and let
  `import.meta.resolve` pick — a glob could silently select the version the KV/R2 protocols are
  not valid for.
- **The `VITE_BACKEND_HOST` warning is a false positive in the container.** The check greps for the
  literal without asking whether it is reachable, so it warns on a *correctly* built image. Being
  fixed in `run-workerd.mjs` separately.

## Answered on the live cluster (2026-08-20)

Reaching `gke_ozla-476923_us-central1_field-gke` (v1.35.6) settled three things:

- **`ReadWriteOncePod` is accepted by this cluster's API server.** The guarantee the platform choice
  rests on, now checked on the target rather than inferred from docs. PD CSI driver present.
- **TLS: GCE ingress + a GKE `ManagedCertificate`.** No `IngressClass` is registered, but
  `ManagedCertificate` and `FrontendConfig` are — so Google terminates TLS, and there is no nginx.
- **Which meant the chart's WebSocket keepalive was inert.** The nginx `proxy-read-timeout`
  annotation does nothing on a GCE ingress; the load balancer applies a default 30s backend timeout
  and drops the workspace WebSocket. Now shipped as a `BackendConfig` (`spec.timeoutSec`), which
  also points the LB health check at `/healthz` rather than letting it probe `/`.

**`config.publicUrl` stays a warning, not a hard requirement.** A deployment with no connectors
genuinely does not need it, and the chart derives it from `ingress.host` in the case that matters,
so requiring it would block the one configuration where it is redundant. The mitigation is
visibility rather than enforcement: the origin is printed at startup and flagged as a default when
unset, which is the same treatment as outbound reach and TLS trust.

## Open questions

- **Ingress and TLS.** GKE Ingress vs. a Service of type LoadBalancer; who terminates TLS. Needs a
  customer answer, but does not block D1–D2.
- **Registry.** Artifact Registry in the customer's project is the assumption; an airgapped customer
  may need an image tarball instead. Cheap either way.
- **Does the gadget watchdog behavior change under k8s?** A runaway gadget wedges the process
  (OZL-239); the kubelet will now restart the pod. That is the same containment as today, but the
  blast radius statement in the docs should be re-checked rather than assumed to carry over.
- **Node maintenance.** GKE node upgrades evict pods. With one replica that is a restart, which is
  acceptable — but the eviction must not overlap the replacement. `ReadWriteOncePod` makes overlap
  fail rather than corrupt; worth confirming the failure is a pending pod and not a wedged mount.
