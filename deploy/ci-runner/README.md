# The in-cluster deploy runner

`helm upgrade` from a GitHub-hosted runner cannot reach this cluster. Master Authorized Networks
allowlists only the operator's own CIDRs, and a hosted runner draws from a huge, shifting IP pool
that cannot be allowlisted meaningfully. `v0.1.0-alpha.6` failed exactly there, after gate, build
and push had all succeeded.

A pod inside the cluster reaches the API server through `kubernetes.default.svc` and never consults
that allowlist. Verified by execution 2026-08-22: in-cluster `/version` returned 200 while the
external endpoint `34.45.224.238` timed out.

## Shape

Only the *cluster* steps moved. `.github/workflows/deploy.yml` is three jobs:

| Job | Runs on | Why |
|---|---|---|
| `gate` | `ubuntu-latest` | lint, build, test — no cluster involved |
| `build` | `ubuntu-latest` | Docker + WIF already work here; this half never failed |
| `release` | `[self-hosted, fieldos-gke]` | the only part that needs the API server |

Because build stayed hosted, this image needs no Docker daemon: the pod is unprivileged, mounts no
socket, and carries `kubectl` and `helm` and nothing else.

The runner authenticates with its **pod ServiceAccount** — no `get-gke-credentials`, no gcloud, no
WIF in the release job. Fetching external credentials would reintroduce the allowlisted-source
dependency the job exists to avoid.

## Install / refresh

```sh
./deploy/ci-runner/install.sh
```

Builds, pushes, applies, and then **asserts the runner registered with GitHub** rather than
inferring it from a successful rollout — a runner that started but never registered is a pod that
looks perfectly healthy and silently never picks up a job.

Re-run it to refresh an expired registration token. Tokens are single-use and last ~60 minutes, so
they cannot be baked into a manifest; the script mints a fresh one with `gh` (needs repo admin) and
restarts the Deployment, because updating the Secret alone leaves the running pod holding the old
token.

## Ephemeral by design

`config.sh --ephemeral`: the runner takes one job, unregisters, and exits; the Deployment restarts
it clean. A long-lived runner would carry a stale checkout or a half-written kubeconfig into the
next release — the kind of failure nobody reproduces.

Consequence: **between releases there is normally no registered runner**, and that is expected. The
pod restarts and re-registers on its own. If a queued deploy sits waiting, check the pod is running
and the token has not expired.

## The secret exposure, stated deliberately

Helm stores release state as Secrets in `fieldos` and must `list` them to enumerate revisions. A
Kubernetes `list` returns every object's **full body including `data`**, and there is no way to
filter fields out of a list response. So the runner can read every secret in `fieldos`, including
`fieldos-site-gate` / `SITE_PASSWORD`.

`kubectl auth can-i get secret/fieldos-site-gate` answers **no** for this Role, and that answer is
misleading — verified by execution: a ServiceAccount holding only collection `list` received the
gate password in a 200 body. `resourceNames` cannot fix it, because helm must `create` the next
revision, whose name does not exist at admission time.

Accepted rather than engineered around: this is the same authority the operator's own kubectl holds,
and the gate is "a deployment gate, not an identity system". The real change is that **repo write
access now implies gate-password read.** If that becomes unacceptable, move `SITE_PASSWORD` to
Secret Manager via the CSI driver — do not try to express it as RBAC, which cannot.
