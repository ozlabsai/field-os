# The deploy pipeline's in-cluster runner: kubectl and helm, and deliberately nothing else.
#
# Only the *cluster* steps of .github/workflows/deploy.yml run here. Build and push stay on a
# GitHub-hosted runner, where Docker and Workload Identity Federation already work and always did
# -- the pipeline never failed there. Keeping the split means this image needs no Docker daemon,
# so the pod is unprivileged, mounts no socket, and is a ~100MB tool image instead of a builder.
FROM ghcr.io/actions/actions-runner:2.336.0

# Pinned by digest-bearing version, not `latest`: a runner that silently changes tool versions
# under a deployment is the kind of drift nobody notices until a release behaves differently.
ARG KUBECTL_VERSION=v1.35.6
ARG HELM_VERSION=v3.19.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp linux-amd64/helm \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/linux-amd64 /var/lib/apt/lists/* \
 && apt-get purge -y curl && apt-get autoremove -y

# Fail the build rather than the first deploy if either tool is missing or non-executable. A tool
# image whose tools are absent looks perfectly healthy until a release needs one.
RUN kubectl version --client=true >/dev/null && helm version >/dev/null \
 && echo "tools present: kubectl ${KUBECTL_VERSION}, helm ${HELM_VERSION}"

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
