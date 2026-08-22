#!/usr/bin/env bash
# Register with GitHub, run exactly one job, unregister, exit.
#
# The official ghcr.io/actions/actions-runner image ships the runner binaries with Cmd=/bin/bash
# and no entrypoint -- it does NOT auto-register. (The RUNNER_TOKEN/RUNNER_REPOSITORY_URL env
# convention belongs to the third-party myoung34/github-runner image, which this is not.)
# Verified by reading the image config, 2026-08-22.
set -euo pipefail

: "${GITHUB_REPO_URL:?GITHUB_REPO_URL is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
RUNNER_NAME="${RUNNER_NAME:-fieldos-gke-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-fieldos-gke}"

# NOT --ephemeral, and that was originally a mistake. An ephemeral runner unregisters after each
# job, so the pod restarts and must re-register -- but a registration token lives ~60 minutes and
# is consumed at startup, so the pipeline was armed only for the hour after each install.sh run.
# After that the pod sat in CrashLoopBackOff with a 404 and a tagged release simply queued forever.
# Found the hard way while cutting alpha.9.
#
# The two reasons given for --ephemeral do not survive checking:
#   - "a stale checkout": `actions/checkout` defaults to `clean: true`, so the workspace is wiped
#     before every checkout regardless.
#   - "a half-written kubeconfig": the release job writes none. It authenticates with the pod's
#     ServiceAccount in place, which is the whole reason this runner exists.
#
# --replace lets the pod re-register under the same name after a node drain or an image change.
./config.sh \
  --unattended \
  --replace \
  --url  "${GITHUB_REPO_URL}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work   "${RUNNER_WORKDIR:-/home/runner/_work}"

# No unregister-on-exit trap. `config.sh remove` needs a *removal* token, and RUNNER_TOKEN is a
# registration token already consumed at startup -- so the obvious trap fails silently and the
# `|| true` hides it. Minting a removal token would mean storing GitHub API credentials in the pod.
#
# The stable RUNNER_NAME in runner.yaml solves it without any of that: `--replace` above makes each
# new pod take over the previous registration of the same name, so a replaced pod cannot leave a
# phantom behind. install.sh additionally prunes any `offline` registrations left by earlier
# versions of this deployment.

./run.sh
