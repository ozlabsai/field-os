# Handoff — the GCP deployment

Written 2026-08-22. What is deployed, what is proven, and what is not.

Sibling to [`handoff.md`](./handoff.md), which covers the airgap port itself. That file is the
orientation layer for the *product*; this one is for the *deployment*. Read that one first if you
are new — nothing here makes sense without knowing FieldOS runs on standalone workerd.

The operator-facing procedure is [`docs/deployment-gcp.md`](../docs/deployment-gcp.md); the design
reasoning is [`gcp-deploy.md`](./gcp-deploy.md). This file is what neither of those says: what was
learned, what is unverified, and what to do next.

## Where things stand

**FieldOS is live at https://os.ozlabs.ai**, on GKE, with TLS, behind a shared-secret gate. A git
tag now builds, tests, pushes **and deploys** — the cluster-reachability block is fixed by an
in-cluster runner (`deploy/ci-runner/`, PR #128, 2026-08-22). Every row
below was verified by execution, not inference:

| | |
|---|---|
| HTTPS | Google Trust Services cert, valid to 2026-11-19; HTTP 301s to it |
| Site gate | HTTP Basic; 401 without credentials, on `/` **and** `/api` |
| WebSocket | `wss://os.ozlabs.ai/api` handshakes 101 through the gate and the load balancer |
| Signup | driven in a real browser: account created, argon2id ran, landed in onboarding |
| Storage | 20Gi PD bound `ReadWriteOncePod`, provisioned by the PD CSI driver |
| Restart | pod deleted, new UID, `keys.json` byte-identical, 24 DO dirs intact |
| Restore | write → back up → `kill -9` mid-write → wipe → restore → read back over the API |
| CI | `pnpm lint`, `pnpm build`, `pnpm test` green on the merged branch |

Merged as **#120** (`222a296`, deployment) and **#123** (`d38098f`, model providers).

## The five things most worth knowing

**1. The deployment is single-writer, and that is not a tuning choice.** Every durable byte is
SQLite on a local disk via workerd's `localDisk`, which does not lock. `replicas: 1` is hardcoded
in the chart rather than templated; the PVC binds `ReadWriteOncePod` so the platform refuses a
second writer cluster-wide; the update strategy is `OnDelete` so no rolling update can overlap two
pods. Scaling up means a bigger node.

Note "two writers corrupts" is **inferred** — nobody has reproduced it. Design for it anyway (the
cost asymmetry is total data loss versus a stuck pod), but do not cite it as established.

**2. `keys.json` is state, not build output, and losing it is silent.** It holds the DO `uniqueKey`
values that *name* the directories under `do-disk/`. Absent, `run-workerd.mjs` would mint fresh
UUIDs, workerd would create new empty directories, and the deployment would boot **healthy** while
every existing workspace sat unreachable on the same volume. There is no migration mechanism. A
guard now refuses to start in that case rather than starting a second life.

**3. `helm upgrade` restarts nothing.** `OnDelete` means it changes the template and stops.
`kubectl delete pod fieldos-0` is what applies a release — and because `config.capnp` is generated
at pod start, an un-replaced pod runs the old image *and* the old config. The CI workflow does the
delete explicitly and waits on a **new pod UID**, because readiness alone cannot distinguish "the
new pod is ready" from "the old pod was always ready".

**4. Three bugs were found by deploying for real, and none was findable locally.** A Kubernetes
service-discovery variable collided with the entrypoint's own (`FIELDOS_PORT`); the chart's nginx
WebSocket annotations were inert on GKE's GCE ingress; and the site gate blocked ACME validation so
TLS could never issue. Details under Traps.

**5. The image is ~2.4GB and `pnpm --prod` would break it.** `workerd` is itself a devDependency and
the root manifest has **no `dependencies` block at all**, so a prod prune removes the binary the
container exists to run. If size matters, prune by name (`wrangler`, `typescript`, `vite`,
`vitest`, `oxlint`). Left alone deliberately for Alpha.

## What is done

| | |
|---|---|
| `Dockerfile` + `docker-entrypoint.sh` | multi-stage; bundles at build, generates config at boot |
| `charts/fieldos/` | StatefulSet(1), RWOP PVC, BackendConfig, ManagedCertificate, FrontendConfig |
| `/healthz` on the router | reaches the **backend worker**, closing the 200-while-dead gap |
| Site gate | optional HTTP Basic, `SITE_PASSWORD` as `user:password`, off by default |
| `.github/workflows/deploy.yml` | tag → gate → build → push → upgrade → replace → verify |
| `scripts/setup-github-deploy.sh` | one-time WIF setup; no service-account key ever created |
| `restore-rehearsal.mjs` | the drill `fieldos.md:415` asks for, executed |
| `docs/deployment-gcp.md` | install, upgrade, backup/restore, limitations |
| `deploy/ci-runner/` | in-cluster GitHub Actions runner; unblocks tag-to-deploy (#128) |
| Admin model providers (#123) | `AdminConfig.disabledModelProviders`, enforced in `addModel` |

`run-workerd.mjs` gained `--bundle-only`, `--use-bundles`, `--state <dir>`, `FIELDOS_PUBLIC_URL`,
and the `keys.json` guard.

## What to pick up next

**Nothing is blocked.** The pipeline's one failure is fixed (see below). In rough order of value:

0. ~~**Give the deploy job a runner inside the VPC.**~~ **Done 2026-08-22**, PR #128 —
   `deploy/ci-runner/`. A pod in the cluster bypasses Master Authorized Networks entirely.

1. **Use the product.** The largest gap by far. Signup and the RPC transport are browser-verified;
   *building a gadget*, the walkthrough, and a real workspace are not. This is the difference
   between "the deployment works" and "the software is worth deploying", and it needs a human.
2. **Click the admin panel** (`/admin` as `guy`). #123's "AI model providers" section is confirmed
   present in the running container — both the panel bundle and the server-side enforcement — but
   the toggle itself is unexercised. Server-side enforcement is what actually governs, so the risk
   is a UI defect, not a security one.
3. **Decide whether `os.ozlabs.ai` should model the airgap.** It currently runs
   `--allow public,private`, so workers can reach the whole internet and the hosted model providers
   genuinely work. Intended for a demo; wrong for a deployment meant to demonstrate the airgapped
   product. `FIELDOS_INTERNAL_HOSTS` narrows it per role.
4. **Rehearse restore against the live volume.** The rehearsal ran against a scratch volume. The
   procedure in `docs/deployment-gcp.md` has not been executed against real user data.
5. **Image size**, if cold-node pull time becomes a complaint. See point 5 above for why
   `pnpm --prod` is the wrong lever.

## The pipeline's one failure, and the fix that shipped

`v0.1.0-alpha.6` ran the full workflow on 2026-08-22. **Gate, WIF authentication, image build and
image push all succeeded** — `alpha.6` is in Artifact Registry, pushed by CI. It failed at
`Helm upgrade`:

```
Error: UPGRADE FAILED: Kubernetes cluster unreachable:
  Get "https://34.45.224.238/version": dial tcp 34.45.224.238:443: i/o timeout
```

**Cause: the cluster has Master Authorized Networks enabled**, allowlisting three CIDRs
(`147.235.195.247/32`, `2.54.0.0/16`, `79.177.0.0/16` — the operator's own addresses). A
GitHub-hosted runner draws from a huge, shifting IP pool and can never be allowlisted meaningfully.

That control is doing its job, and the workflow is not wrong. No amount of review would have found
this: it is a property of the cluster, not of the YAML, and only running it surfaced it.

**The failure was clean.** `Replace the pod`, `Wait for the new pod` and `Verify the deployment` all
**skipped** rather than running, so the live deployment was never touched — same pod UID, same
image, uninterrupted. The step ordering (upgrade before any pod mutation) is what made a failed
deploy a no-op instead of a half-applied one.

**Fixed 2026-08-22 by an in-cluster runner** (`deploy/ci-runner/`, PR #128). The important
discovery, which narrowed the work considerably: **a pod in the cluster reaches the API server
through `kubernetes.default.svc` and never consults Master Authorized Networks at all** — no VM, no
NAT, no allowlist change, no service-account key. Verified by execution with both halves measured:
in-cluster `/version` returned **200** via the ServiceAccount token, while the external endpoint
`34.45.224.238` **timed out** from the same probe.

Only the *cluster* steps moved. `build` stays on `ubuntu-latest`, where Docker and WIF work and
always did — that half never failed. Because build stayed hosted, the runner needs no Docker
daemon: unprivileged, no socket mount, `kubectl` and `helm` and nothing else, and it authenticates
with its pod ServiceAccount rather than fetching external credentials (which would reintroduce the
allowlisted-source dependency the job exists to avoid).

Rejected alternatives, with the reasons that still stand:

- *Allowlist GitHub's published ranges* — a large, shared, frequently-changing set; it would
  effectively open the control plane to anyone running a GitHub Action.
- *Cloud Build / Cloud Run job* — viable, keeps `git tag` as the trigger, but moves the deploy out
  of the workflow and needs its own network configuration.
- *Drop the cluster steps and deploy by hand* — the fallback if the runner had not been worth it.
- *A GCE VM in the VPC* — a conventional self-hosted runner, independent of cluster health, but an
  always-on VM to patch and own. Unnecessary once the in-cluster path was measured.

The three manual commands in `docs/deployment-gcp.md` still work and remain the fallback if the
runner is down.

## Traps that have already cost time

**`kubectl auth can-i` will tell you a secret is protected when it is not.** Helm stores release
state as Secrets and must `list` them to enumerate revisions. A Kubernetes **`list` returns every
object's full body, including `data`** — there is no way to filter fields out of a list response.
So a Role with collection `list` on secrets grants read of *every* secret in the namespace, while
`kubectl auth can-i get secret/fieldos-site-gate` still answers **no**. Measured, not reasoned: a
ServiceAccount holding only `list` received `SITE_PASSWORD` in a 200 body. `resourceNames` cannot
close it either, because helm must `create` the next revision, whose name does not exist at
admission time. The consequence for this deployment is deliberate and documented at the RBAC rule
in `deploy/ci-runner/runner.yaml`: **repo write access now implies gate-password read.** The fix, if
that ever becomes unacceptable, is Secret Manager via the CSI driver — not RBAC, which cannot
express it.

**An unknown step output in GitHub Actions expands to the empty string, not an error.** Splitting
the deploy job left `env: VERSION: ${{ steps.version.outputs.version }}` in a job that no longer had
that step. It does not fail: it silently becomes `""`, so `helm upgrade --set image.tag=` would set
an empty tag and `Verify` would fail two steps *after* the pod had already been replaced. Caught by
reading the split output rather than by any tooling. A job-level `env` from `needs.<job>.outputs` is
the fix, but the step-level one has to be *removed* — a step-level `env` wins over job-level.

**Kubernetes injects a variable named after your Service.** A Service named `fieldos` produces
`FIELDOS_PORT=tcp://10.30.11.195:80` in every pod in the namespace, which collided with the
entrypoint's own `FIELDOS_PORT`. workerd tried to bind port `NaN` and died with
`DNS lookup failed; params.service = NaN` — naming neither the variable nor the Service. **Docker
performs no such injection**, so container testing was structurally incapable of catching it. Fixed
in the entrypoint (rejects non-numeric, warns with the value) rather than by renaming the Service,
which would only move the collision to the next operator. The kubelet owns the `<SERVICE_NAME>_*`
namespace; do not name a config variable after your Service.

**On GKE the Ingress's nginx annotations do nothing.** The cluster has no `IngressClass` — it uses
GKE's GCE ingress controller, which reads backend behaviour from a `BackendConfig` CRD. The chart's
`proxy-read-timeout` was inert, so the load balancer would have applied its **default 30s** backend
timeout and dropped workspace WebSockets. Because the frontend reconnects with backoff, the symptom
is *periodic disconnects*, not a timeout anyone configured. Now shipped as a CRD and verified as
`TIMEOUT_SEC: 3600` **in GCP**, not merely as a CRD in Kubernetes.

**An edge auth gate blocks certificate issuance, and the status field cannot tell you.** The site
gate returned 401 on `/.well-known/acme-challenge/*`, so GKE's ManagedCertificate validator could
never fetch its challenge — TLS could not issue at all. A blocked challenge and a *not-yet-retried*
one both show `FAILED_NOT_VISIBLE`, so it read as "still provisioning" for over an hour. Now exempts
the whole `/.well-known/` prefix (RFC 8615), covering Let's Encrypt and cert-manager too.

The reasoning error generalizes: `/healthz` was exempted by listing *probes I already knew about*
rather than asking **which callers cannot present credentials**. When adding auth in front of
anything, enumerate those first — health probes, ACME validation, webhooks, OAuth callbacks. And
when a managed certificate is stuck, `curl` the challenge path rather than reading the status field.

**`--out` is only relocatable near the repo.** The generated config mixes two path schemes:
`do-disk` and the frontend `dist` are embedded **absolute**, while the `fieldos-runtime` modules are
embedded **relative to `--out`**. An `--out` under `/tmp` writes a config that exits 0 and then dies
at boot with `Couldn't read file for embed: ../../…`, naming a file rather than the flag.

**`cp` glob semantics differ between BSD and GNU, and the restore instructions run on a laptop.**
`cp -r src/*/ dst/` copies each directory's *contents* on macOS (flattening every DO namespace into
loose `.sqlite` files) and copies the directories on Linux. Measured both ways. The restore command
uses `backup/*-*` — no trailing slash, and not `backup/.` either, since that would copy `keys.json`
*into* `do-disk/` where it looks like the real one while the startup guard checks the parent.

**A fresh `git worktree` has no `node_modules` and no generated sources.** Tests fail with
`ERR_MODULE_NOT_FOUND: jsonc-parser`, which reads as a code error; the real cause is that
`src/generated/format-blueprints.ts` is produced by `pnpm build`. Run `pnpm install && pnpm build`
in any new worktree.

**`CLAUDE.md` is gitignored.** The tracked file is `AGENTS.md` (renamed upstream in `87e0163`). An
edit to `CLAUDE.md` reaches nobody but you.

## Deliberate limitations, stated so they are not rediscovered

- **Nothing about the *product* has been exercised beyond signup.** See "what to pick up next".
- **The restore procedure has not been run against the live volume**, only a scratch one.
- **`config.publicUrl` is a warning, not a requirement.** A deployment with no connectors genuinely
  does not need it, and the chart derives it from `ingress.host` in the case that matters. The
  mitigation is visibility: the resolved origin prints at startup, flagged as a default when unset.
- **`--allow public,private` on `os.ozlabs.ai` is deliberate but not airgap-representative.**
- **The gate is a deployment gate, not an identity system.** It names nobody, and every FieldOS
  account check still applies behind it. Rotating it requires updating the Secret **and** restarting
  the pod, since env vars are read at pod start.
- **Sessions expire after 60 minutes idle / 12 hours absolute** by default
  (`auth/session-policy.ts:20-21`); the deployment leaves both unset. Until #126 lands, expiry
  surfaces as several "invalid session token" console errors rather than a redirect (#125).
