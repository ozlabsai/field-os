# Deploying FieldOS on GCP

For an operator installing FieldOS into their own GCP project. The design reasoning is in
[`plans/gcp-deploy.md`](../plans/gcp-deploy.md); this is the procedure.

## The one thing to understand first

**FieldOS is single-writer.** Every durable byte — accounts, workspaces, gadget state, context
collections — is SQLite on a local disk, through workerd's `localDisk` Durable Object storage.
There is no external database and the storage backend does not lock.

So this is not a horizontally-scaled service. It is one process, one volume, one replica, forever.
Everything below follows from that:

- `replicas: 1` is hardcoded in the chart, not exposed as a value.
- The volume binds `ReadWriteOncePod`, so Kubernetes refuses a second writer cluster-wide.
- The update strategy is `OnDelete`, because a rolling update would briefly run two pods.

Scaling up means a bigger node, not more pods.

## Requirements

- **GKE Standard, Kubernetes 1.29+.** 1.29 is when `ReadWriteOncePod` reached GA; the chart's
  `kubeVersion` refuses to install below it rather than silently falling back to a weaker guarantee.
- The Compute Engine persistent disk CSI driver (enabled by default on GKE).
- A container registry the cluster can pull from — Artifact Registry in the same project is the
  normal choice.
- An OpenAI-compatible inference server (vLLM, TGI, Ollama) reachable from the cluster. FieldOS
  does not ship a model and does not call a hosted API.

## Build and push the image

```sh
docker build --platform linux/amd64 -t <region>-docker.pkg.dev/<project>/<repo>/fieldos:0.1.0-alpha.1 .
docker push <region>-docker.pkg.dev/<project>/<repo>/fieldos:0.1.0-alpha.1
```

One image serves every deployment. **Do not set `VITE_BACKEND_HOST`** — unset, the frontend derives
its API origin from `window.location`, so the same artifact works on any hostname. Setting it bakes
a hostname into the bundle and is the single most repeated deployment mistake in this project's
history.

The build needs no internet beyond fetching dependencies: the bundling step (`wrangler --dry-run`)
completes with egress blocked, so an isolated CI can build from a warm pnpm store.

## Install

```sh
helm install fieldos ./charts/fieldos \
  --set image.repository=<region>-docker.pkg.dev/<project>/<repo>/fieldos \
  --set config.admins='["alice","bob"]' \
  --set config.internalHosts="inference=vllm.internal:8000" \
  --set persistence.size=50Gi \
  --set persistence.storageClassName=premium-rwo
```

`config.admins` is a JSON array of usernames. **An empty list means nobody can administer the
deployment** — there is no bootstrap flow that grants it later.

`config.internalHosts` grants each worker only the internal addresses for the roles it depends on
(`inference`, `mcp`, `oidc`, `homeassistant`). Prefer it over widening `config.allow`, which opens
every RFC1918 address to every worker with any internal dependency. Note hostnames are resolved
**at pod start**, because workerd filters on the resolved address and never sees the name — a
service that changes address is unreachable until the pod restarts.

For an internal HTTPS service behind a private CA:

```sh
kubectl create secret generic fieldos-ca --from-file=ca.pem=/path/to/ca.pem
helm upgrade fieldos ./charts/fieldos --reuse-values \
  --set caBundle.existingSecret=fieldos-ca --set caBundle.trustSystem=false
```

`trustSystem=false` trusts *only* that CA, so a public CA cannot vouch for an internal name.

## Upgrading

The update strategy is `OnDelete`, so a `helm upgrade` does **not** restart the pod. That is
deliberate — it makes replacing the running process an explicit act, with a backup before it.

```sh
# 1. Back up. Consistent on a live database; no need to stop first.
kubectl exec fieldos-0 -- node /src/scripts/backup-do-disk.mjs \
  --state /var/lib/fieldos --out /var/lib/fieldos/backup-$(date +%Y%m%d)

# 2. Point the release at the new image.
helm upgrade fieldos ./charts/fieldos --reuse-values --set image.tag=<new>

# 3. Replace the pod. It comes back on the new image, against the same volume.
kubectl delete pod fieldos-0
```

**A workerd version change is a migration event, not an upgrade.** `localDisk` is marked
EXPERIMENTAL and SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE, and FieldOS re-implements KV and R2
against workerd-internal wire protocols valid for the pinned version exactly. Never float the
workerd version; rehearse a restore before adopting a new one.

## Backup and restore

**A complete backup is `do-disk/` *and* `keys.json`.** `keys.json` holds the Durable Object
`uniqueKey` values that *name* the directories inside `do-disk/`. Without it the databases are
present but unaddressable — and there is no migration mechanism to re-derive them.

FieldOS refuses to start if `do-disk/` holds state while `keys.json` is missing, rather than
minting fresh keys, because minting would orphan every workspace behind a boot that looks entirely
healthy.

To restore: stop the pod, replace the state, start it.

```sh
kubectl scale statefulset fieldos --replicas=0     # stop the writer FIRST
kubectl exec ... -- sh -c 'cp -r /var/lib/fieldos/backup-<date>/. /var/lib/fieldos/do-disk/'
kubectl scale statefulset fieldos --replicas=1
```

Use `cp -r src/. dst/`, **not** `cp -r src/*/ dst/`. The glob form is not portable: BSD `cp`
(macOS) copies each directory's *contents*, flattening every DO namespace into one pile of loose
`.sqlite` files, while GNU `cp` (Linux) copies the directories. Measured both ways. `src/.` means
the same thing in both.

**Verify a restore by opening a workspace in the UI, not by `quick_check` or row counts.** A torn
WAL pair restores, opens, and passes structural checks while quietly missing its most recent
transactions — `quick_check` will say `ok`. `packages/integration-tests/restore-rehearsal.mjs`
automates the full drill (write → back up → `kill -9` mid-write → wipe → restore → read back) and
has been executed against a container: it passes, with a negative control confirming it can fail.

## Health and restarts

The liveness probe targets `/healthz`, which reaches the **backend worker**. Do not repoint it at
`/`: that is served by the asset service and returns 200 while the API is unreachable, so a probe
there keeps a dead deployment alive indefinitely.

`/healthz` also fires the format-blueprint install once per isolate, so on a fresh deployment the
kubelet's first probe is what provisions it.

A runaway gadget can still wedge the whole process (OZL-239) — the sandbox prevents it reaching
anything it should not, but not from refusing to stop. The kubelet restarts the pod when
`/healthz` fails. `terminationGracePeriodSeconds` is deliberately low: a wedged workerd ignores
SIGTERM, so SIGKILL is the normal path rather than an escalation.

## Known limitations

- **No PDF export** — needs a `BROWSER` binding that does not exist off-platform. Degrades cleanly.
- **`webFetch` document conversion** falls back to plain text.
- **Blueprints are fetchable unauthenticated by id**, bypassing org separation (OZL-223).
- **Admin revocation targets a named user**; there is no user directory.
- **The deployment runs workerd with `--experimental`**, permanently. It gates the Worker Loaders
  binding that every gadget executes through — it is the sandbox, not an unfinished feature, and
  without it workerd refuses to start at all. Paired with `localDisk`'s experimental status, this
  is the platform bet the pinned version exists to manage.
