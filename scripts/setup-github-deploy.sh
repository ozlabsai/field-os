#!/usr/bin/env bash
# One-time GCP setup so GitHub Actions can deploy without a long-lived key.
#
# Creates a Workload Identity Federation pool + provider and a service account GitHub can
# impersonate. GitHub presents an OIDC token; GCP exchanges it for a short-lived access token. No
# JSON key is ever created, so there is nothing to leak, rotate, or find in a git history.
#
# Run once, as someone with project IAM admin. It is idempotent -- safe to re-run.
#
# Usage: scripts/setup-github-deploy.sh [--repo owner/name]
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ozla-476923}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-field-gke}"
REPO="${REPO:-ozlabsai/field-os}"
POOL="github-actions"
PROVIDER="github"
SA_NAME="fieldos-deployer"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

echo "Project ${PROJECT_ID} (${PROJECT_NUMBER}), repo ${REPO}"

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="${PROJECT_ID}" --quiet

gcloud iam workload-identity-pools describe "${POOL}" \
    --project="${PROJECT_ID}" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "${POOL}" \
    --project="${PROJECT_ID}" --location=global --display-name="GitHub Actions"

# `attribute-condition` is the security boundary, and it is not optional. Without it ANY GitHub
# repository in the world could mint a token for this provider and impersonate the service account.
# Restricting to this repository is what makes the trust one-way.
gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
    --project="${PROJECT_ID}" --location=global --workload-identity-pool="${POOL}" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --project="${PROJECT_ID}" --location=global --workload-identity-pool="${POOL}" \
    --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${REPO}'"

gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT_ID}" --display-name="FieldOS GitHub deployer"

# Least privilege, deliberately narrow:
#   artifactregistry.writer  push images (not admin -- cannot delete a repository)
#   container.developer      talk to the cluster's API (not container.admin -- cannot alter the
#                            cluster itself, resize node pools, or change IAM)
for role in roles/artifactregistry.writer roles/container.developer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" --role="${role}" --condition=None --quiet >/dev/null
done

# Only tokens carrying this repository's attribute may impersonate the account.
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

Done. Add these two GitHub repository secrets:

  GCP_WORKLOAD_IDENTITY_PROVIDER = ${PROVIDER_RESOURCE}
  GCP_SERVICE_ACCOUNT            = ${SA_EMAIL}

  gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "${REPO}" --body "${PROVIDER_RESOURCE}"
  gh secret set GCP_SERVICE_ACCOUNT --repo "${REPO}" --body "${SA_EMAIL}"

Then a tag deploys:  git tag v0.1.0-alpha.4 && git push origin v0.1.0-alpha.4

Neither value is a credential -- they are resource names, and useless without a GitHub OIDC token
from ${REPO}. They are secrets only to avoid advertising the project layout.
EOF
