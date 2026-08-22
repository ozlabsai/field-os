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

# --ephemeral makes GitHub drop the registration after one job, and run.sh exits when that job
# finishes. The Deployment then restarts the pod, install.sh's Secret supplies a fresh token, and
# the next release gets a clean runner. A long-lived runner would carry a stale checkout and a
# half-written kubeconfig into the next deploy.
./config.sh \
  --unattended \
  --ephemeral \
  --replace \
  --url  "${GITHUB_REPO_URL}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work   "${RUNNER_WORKDIR:-/home/runner/_work}"

# Unregister on SIGTERM so a `kubectl delete pod` does not leave a phantom offline runner behind
# that GitHub will still try to schedule onto.
cleanup() { ./config.sh remove --token "${RUNNER_TOKEN}" || true; }
trap cleanup EXIT INT TERM

./run.sh
