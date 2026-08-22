#!/bin/sh
# Generate config.capnp from the live environment, then hand the process to workerd.
#
# Config is generated here rather than baked into the image for two reasons, either of which alone
# would force it: config.capnp embeds instance state (ADMINS, the CA bundle, session ceilings), and
# it embeds absolute paths for do-disk and the frontend dist. A baked config would ship one
# customer's policy to another, and would carry the builder's paths into a container that mounts
# its volume somewhere else. Both fail silently -- the image boots and serves.
set -eu

STATE_DIR="${FIELDOS_STATE_DIR:-/var/lib/fieldos}"
# NOT plain ${FIELDOS_PORT:-8080}. Kubernetes injects legacy Docker-link service-discovery vars
# into every pod -- for a Service named `fieldos` that is `FIELDOS_PORT=tcp://10.30.11.195:80`,
# which collides with this variable by name. workerd then tried to bind port `NaN` and died with
# `DNS lookup failed; params.service = NaN`, an error naming neither the variable nor the Service.
#
# Only a real cluster can produce this: Docker performs no such injection, so container testing is
# structurally incapable of catching it. Accept only digits and fall back otherwise, rather than
# trusting a name we do not exclusively own.
case "${FIELDOS_PORT:-}" in
  "") PORT=8080 ;;
  *[!0-9]*)
    # Warned rather than silently ignored: a non-numeric value is either this collision (benign,
    # and common) or an operator typo (not benign). Saying which value was rejected is the only
    # thing that separates them at 3am.
    echo "entrypoint: ignoring non-numeric FIELDOS_PORT=${FIELDOS_PORT} (Kubernetes injects a" \
         "\$SERVICE_PORT var of this name); using 8080" >&2
    PORT=8080 ;;
  *) PORT="$FIELDOS_PORT" ;;
esac
# workerd blocks private IPs by default, and an on-prem deployment's inference server, MCP hosts
# and IdP are all on RFC1918 space. `public,private` is the blunt grant; narrow it per role with
# FIELDOS_INTERNAL_HOSTS (see docs/configuration.md), which the chart surfaces as a value.
ALLOW="${FIELDOS_ALLOW:-public,private}"

if [ ! -d "$STATE_DIR" ]; then
  echo "entrypoint: state directory $STATE_DIR does not exist" >&2
  echo "  Mount a volume there, or set FIELDOS_STATE_DIR." >&2
  exit 1
fi

if [ ! -w "$STATE_DIR" ]; then
  # Caught here because the alternative is workerd failing mid-boot on a DO write, far from the
  # cause. A volume mounted with the wrong ownership is the ordinary way this happens.
  echo "entrypoint: state directory $STATE_DIR is not writable by $(id -un) (uid $(id -u))" >&2
  ls -ld "$STATE_DIR" >&2
  exit 1
fi

# Generating the config also runs the keys.json guard in run-workerd.mjs: if do-disk/ holds state
# but keys.json is gone, it refuses rather than minting fresh uniqueKeys, which would orphan every
# existing workspace behind a boot that looks entirely healthy.
# FIELDOS_PUBLIC_URL is read by run-workerd.mjs straight from the environment (it needs no flag),
# and its absence is only a warning at startup rather than an error -- a deployment with no
# connectors configured genuinely does not need it.
echo "entrypoint: generating config (state=$STATE_DIR port=$PORT allow=$ALLOW${FIELDOS_PUBLIC_URL:+ origin=$FIELDOS_PUBLIC_URL})"
node /src/scripts/run-workerd.mjs \
  --build-only \
  --use-bundles \
  --out /src/.workerd \
  --state "$STATE_DIR" \
  --port "$PORT" \
  --allow "$ALLOW"

# `exec` so workerd is PID 1 and receives signals directly -- no shell swallowing SIGTERM, and no
# supervisor between the kubelet and the process it is trying to restart.
#
# Deliberately NOT run-workerd.mjs's supervisor/watchdog. Its health probe is `GET /` with
# `status < 500`, which returns 200 while the API is unreachable; the chart's liveness probe hits
# /healthz, which actually reaches the backend worker. One restart mechanism, owned by the kubelet,
# instead of two nested ones where it is unclear which acted.
#
# `--experimental` is not optional and not temporary: it gates the worker_loaders binding
# (workshop-backend/wrangler.jsonc:80) that every gadget executes through. Without it workerd
# rejects the config outright -- the deployment has no product rather than a degraded one.
echo "entrypoint: exec workerd (port $PORT)"
cd /src/.workerd
exec /src/node_modules/workerd/bin/workerd serve config.capnp --experimental
