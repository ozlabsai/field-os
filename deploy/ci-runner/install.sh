#!/usr/bin/env bash
# Build, push and install the in-cluster deploy runner. Safe to re-run: this is also how you
# refresh a runner whose registration token has expired.
#
#   ./deploy/ci-runner/install.sh
#
# Requires: gcloud + kubectl authenticated against the cluster (from an allowlisted address), and
# `gh` with admin on the repo, since minting a runner registration token needs it.
set -euo pipefail

PROJECT="${PROJECT:-ozla-476923}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-ozlabsai/field-os}"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/field/ci-runner}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> building ${IMAGE}:${TAG}"
# amd64 explicitly: the nodes are amd64 and a developer machine may not be. Without this the pod
# fails with `exec format error`, which names nothing about the architecture that caused it.
docker build --platform linux/amd64 -t "${IMAGE}:${TAG}" "${HERE}"
docker push "${IMAGE}:${TAG}"

echo "==> minting a registration token (single-use, expires in ~60 minutes)"
TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" -q .token)"
[ -n "${TOKEN}" ] || { echo "ERROR: no registration token; is gh authenticated with admin?" >&2; exit 1; }

echo "==> applying manifests"
sed "s|IMAGE_PLACEHOLDER|${IMAGE}:${TAG}|" "${HERE}/runner.yaml" | kubectl apply -f -

# Created after the namespace exists, and rewritten on every run because the previous token is
# both single-use and expired. `apply` via dry-run so a re-run updates rather than conflicts.
kubectl create secret generic runner-registration \
  --namespace fieldos-ci \
  --from-literal=token="${TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

# The Secret changed but the Deployment did not, so nothing would restart on its own -- and a
# running pod holds the OLD token. Same class of trap as `helm upgrade` not replacing fieldos-0.
kubectl rollout restart deployment/deploy-runner -n fieldos-ci
kubectl rollout status  deployment/deploy-runner -n fieldos-ci --timeout=180s

echo "==> confirming the runner actually registered with GitHub"
# Rollout success only proves the container is UP. A runner that started but failed to register is
# a pod that looks perfectly healthy and will never pick up a job -- silence indistinguishable
# from "no jobs queued". Assert the registration, do not infer it.
for _ in $(seq 1 20); do
  if gh api "repos/${REPO}/actions/runners" \
      -q '.runners[] | select(.name|startswith("deploy-runner")) | "\(.name) \(.status) labels=\([.labels[].name]|join(","))"' \
      2>/dev/null | grep -q online; then
    gh api "repos/${REPO}/actions/runners" \
      -q '.runners[] | "  registered: \(.name) \(.status) labels=\([.labels[].name]|join(","))"'
    echo "==> runner is online"
    exit 0
  fi
  sleep 5
done

echo "ERROR: runner never came online. Logs:" >&2
kubectl logs -n fieldos-ci deployment/deploy-runner --tail=40 >&2
exit 1
