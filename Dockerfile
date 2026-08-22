# FieldOS on standalone workerd, for a customer-run Kubernetes or VM deployment.
#
# Two stages, split at the point where configuration enters. The builder bundles the nine workers
# with wrangler (`--bundle-only`); the runtime image generates `config.capnp` from the live
# environment at container start and execs workerd on it.
#
# Generating config at boot rather than baking it is not a preference -- two independent reasons
# force it. `config.capnp` embeds instance state (ADMINS, the CA bundle, session ceilings), so a
# baked config would ship one customer's policy to another. And it embeds absolute paths for
# `do-disk` and the frontend `dist`, so a baked config would carry the builder's paths into a
# container that mounts its volume elsewhere. Both failures are silent: the image builds, boots,
# and serves.
#
# Build:  docker build --platform linux/amd64 -t fieldos:dev .
# Run:    docker run -p 8080:8080 -v fieldos-state:/var/lib/fieldos fieldos:dev

# The pinned workerd (1.20260801.1) is the deployment's compatibility contract, not a floor:
# `localDisk` DO storage is marked EXPERIMENTAL / SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE, and
# fieldos-runtime re-implements KV and R2 against workerd-internal wire protocols valid for that
# version exactly. Never float this to `latest` -- a bump is a migration event with a restore
# rehearsal (plans/fieldos.md:415).
FROM node:22-bookworm-slim AS builder

# git: some workspace tooling shells out to it. ca-certificates: for the dependency fetch only --
# the bundling step itself needs no network (verified: `wrangler deploy --dry-run` completes with
# HTTP_PROXY/HTTPS_PROXY blackholed), so a fully offline build works from a warm pnpm store.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /src

# Dependencies first, so a source-only change does not refetch 1.2 GB of node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile

COPY . .

# The frontend is built with VITE_BACKEND_HOST deliberately UNSET. Unset, `getBackendHost()`
# derives the API origin from `window.location` (main.tsx:61-68), so ONE image serves every
# customer hostname. Setting it bakes a constant into the bundle and is the deployment trap
# documented in plans/handoff.md -- correct for a localhost dev stack, wrong here.
RUN env -u VITE_BACKEND_HOST pnpm build

# Bundle the workers WITHOUT generating config. `--build-only` would also write config.capnp,
# freezing this build's environment into the layer.
RUN node scripts/run-workerd.mjs --bundle-only --out /src/.workerd


FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# `--out` is only relocatable near the repo: the config embeds the fieldos-runtime modules as paths
# RELATIVE to --out (run-workerd.mjs:582,596,611) while embedding do-disk and dist as ABSOLUTE
# paths. Keeping the same layout as the builder is what makes both schemes resolve. Verified the
# hard way -- an --out under /tmp writes a config that exits 0 and then dies at boot with
# `Couldn't read file for embed: ../../...`, naming a file rather than the flag that caused it.
# The bundles, plus (below) packages/ in full -- which carries the frontend `dist` the asset
# service serves and the fieldos-runtime `src/*.js` that the config embeds BY PATH at generation
# time, making those runtime files rather than build output.
COPY --from=builder /src/.workerd/bundles /src/.workerd/bundles
# Config generation re-reads each worker's wrangler.jsonc for its bindings and DO class names, and
# `findDeployablePackages` walks packages/ to discover them. Copied wholesale rather than by glob:
# `COPY packages/*/wrangler.jsonc packages/` would flatten nine files onto one name.
COPY --from=builder /src/packages /src/packages
COPY --from=builder /src/scripts /src/scripts
COPY --from=builder /src/package.json /src/pnpm-workspace.yaml /src/

# The whole resolved dependency tree, rather than hand-picked packages.
#
# pnpm stores real files in a content-addressed `node_modules/.pnpm/` and makes the top-level names
# symlinks into it, so `COPY node_modules/workerd` copies a dangling link. Copying individual
# packages means reconstructing that graph by hand, which is both fragile and actively unsafe here:
# the tree carries TWO workerd versions (1.20260722.1 via transitive deps, and the pinned
# 1.20260801.1), and fieldos-runtime's KV/R2 implementations are valid for the pinned one *exactly*.
# A hardcoded path or glob could silently select the wrong binary.
#
# So let `require.resolve` keep doing what it already does correctly -- run-workerd.mjs resolves the
# binary via `import.meta.resolve("workerd/bin/workerd")` (:802), which lands on the pinned version.
# It costs image size, which is the cheap resource here.
COPY --from=builder /src/node_modules /src/node_modules

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Durable state: the DO SQLite databases and the uniqueKeys that name their directories. These two
# are inseparable -- keys.json is state, not build output. If it is lost beside a populated
# do-disk/, run-workerd.mjs refuses to start rather than minting fresh keys, because minting would
# orphan every existing workspace behind a boot that looks entirely healthy.
ENV FIELDOS_STATE_DIR=/var/lib/fieldos
RUN mkdir -p /var/lib/fieldos
VOLUME /var/lib/fieldos

# Unprivileged: the workers are sandboxed by workerd, but a gadget escape should not land as root.
RUN chown -R node:node /src /var/lib/fieldos
USER node

EXPOSE 8080

# No HEALTHCHECK: under Kubernetes the kubelet owns liveness via the /healthz probe in the chart,
# and a second restart mechanism nested inside the first only obscures which one acted.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
