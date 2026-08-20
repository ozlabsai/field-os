#!/usr/bin/env node

// Runs FieldOS on standalone workerd, with no Cloudflare account: bundles every worker with
// `wrangler deploy --dry-run`, emits a workerd `config.capnp` wiring the bundles together, and
// (unless --build-only) spawns `workerd serve` on it.
//
// Usage: node scripts/run-workerd.mjs [--out .workerd] [--port 8080] [--allow public,private]
//                                      [--build-only] [--no-watchdog] [--only <pkg,...>]
//                                      [--interceptor]
//                                      [--watchdog-interval 5000] [--watchdog-failures 3]
//
// Environment: FIELDOS_CA_BUNDLE=/path/ca.pem[,/path/other.pem] trusts an operator's private CA
// for internal HTTPS services (OZL-300); FIELDOS_CA_TRUST_SYSTEM=false additionally drops the
// system bundle, so only that private CA is trusted.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectModules } from "./release/hash-lib.mjs";
import {
  findDeployablePackages, prebuildGeneratedUi, readWranglerConfig,
} from "./release/manifest-lib.mjs";
import { parseInternalHosts, resolveInternalHosts } from "./internal-hosts.mjs";
import { withBuildLock } from "./build-lock.mjs";

// Backend instance state a real deployment gets from the deploy service at PUT time. Forwarded
// from the process environment so a local stack can exercise admin-gated and policy-gated paths;
// unset means "as a fresh deployment", which is the default and what most runs want.
const INSTANCE_VARS = [
  "ADMINS",
  "ENABLE_ORG_SEPARATION",
  "ALLOW_CROSS_ORG_SHARING",
  "SESSION_MAX_LIFETIME_HOURS",
  "SESSION_MAX_IDLE_MINUTES",
  "DISABLE_PASSWORD_AUTH",
  "AUTH_GATEKEEPERS",
];

// Instance vars a GATEKEEPER reads from its own env as well as the backend. A gatekeeper is a
// separate worker sharing no code with the backend, so `org-scoping.ts` reads ENABLE_ORG_SEPARATION
// itself; docs/configuration.md states the operator sets one value and both must receive it.
//
// Forwarding it to only the backend would produce the worst possible test result: the backend
// enforces the boundary while the Context gatekeeper does not, so a cross-org public collection
// stays visible and the boundary *looks* like it works.
const GATEKEEPER_INSTANCE_VARS = ["ENABLE_ORG_SEPARATION"];

// Per-gatekeeper credentials, read from `<VENDOR>_<NAME>` in the environment and emitted as
// `<NAME>` in that gatekeeper's bindings. Deliberately a fixed list rather than a prefix sweep:
// forwarding whatever happens to match would put arbitrary environment content into a worker.
const GATEKEEPER_SECRET_VARS = ["CLIENT_ID", "CLIENT_SECRET"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const FRONTEND_DIST = join(PACKAGES_DIR, "workshop-frontend", "dist");

// The only packages this deployment shape includes today: the core two plus the seven
// gatekeepers that are actually maintained (the other ten in packages/ are delete-candidate
// connectors, per the task brief — skip them here rather than reading them out of some registry
// that doesn't exist yet).
const ALL_GATEKEEPERS = [
  "gatekeeper-mcp", "gatekeeper-mcp-portal", "gatekeeper-context", "gatekeeper-scheduler",
  "gatekeeper-homeassistant", "gatekeeper-oidc", "gatekeeper-github",
];

// The two workers every deployment shape needs: the router is the socket's target, and the
// backend is what it forwards /api to. Neither is ever subsettable by --only.
const CORE_PACKAGES = ["workshop-backend", "router"];

// Service name for `--interceptor`'s recording stand-in for the network. Hyphenated to match the
// other generated service names (`internet-public`, `net-<pkg>`).
const INTERCEPTOR_SERVICE = "test-interceptor";

// workerd's `network` allow list accepts these alongside CIDR blocks (workerd.capnp:826-832).
const ALLOW_KEYWORDS = new Set(["public", "private", "local", "network", "unix", "unix-abstract"]);

// Rejects an `--allow` entry workerd would accept but an operator almost certainly did not mean.
//
// This runs at config generation because it is the last point where a mistake can be reported
// usefully. Once workerd is running, a refused connection reaches the calling code as a bare
// `Error` whose message is an opaque reference token -- indistinguishable from a DNS failure or a
// crash, and never naming the address -- so an unreachable host is undiagnosable at runtime. The
// error text below is the only chance to name the entry and say what is wrong with it.
function validateAllow(allow, source = "--allow") {
  for (const entry of allow) {
    if (ALLOW_KEYWORDS.has(entry)) continue;

    const match = /^([0-9a-fA-F.:]+)\/(\d{1,3})$/.exec(entry);
    if (!match) {
      throw new Error(
          `${source}: ${JSON.stringify(entry)} is neither a CIDR block nor one of ` +
          `${[...ALLOW_KEYWORDS].join(", ")}.\n` +
          `  Give a range like 10.42.7.9/32, or a bare host address with /32.`);
    }

    const prefix = Number(match[2]);
    const isIpv6 = match[1].includes(":");
    const width = isIpv6 ? 128 : 32;
    if (prefix > width) {
      throw new Error(`${source}: ${JSON.stringify(entry)} has a prefix wider than /${width}.`);
    }

    // A range this large is a whole corporate network, not a service. workerd's own schema shows
    // `allow = ["public", "private"]` as its cautionary example; an operator reaching for a /8
    // usually wants the handful of hosts inside it. Refused rather than warned, since a warning
    // scrolls past and the resulting over-grant is invisible afterwards.
    const minPrefix = isIpv6 ? 64 : 24;
    if (prefix < minPrefix) {
      const addresses = isIpv6 ? "a very large range" : `${2 ** (32 - prefix)} addresses`;
      throw new Error(
          `${source}: ${JSON.stringify(entry)} covers ${addresses}.\n` +
          `  Ranges wider than /${minPrefix} are refused -- list the servers you need ` +
          `individually (e.g. 10.42.7.9/32), or narrow the range.\n` +
          `  Use "private" if you genuinely intend to reach the whole internal network.`);
    }
  }
}

// The operator's private CA, for internal services fronted by a customer PKI (OZL-300).
//
// Read and validated here rather than handed to workerd as a path, for two reasons: a missing or
// empty bundle otherwise surfaces as a TLS failure at first request -- far from its cause, and
// indistinguishable from a genuinely untrusted peer -- and inlining the PEM keeps the generated
// config independent of the directory it is served from.
//
// Deliberately not parsed beyond the PEM envelope. Whether a certificate is a usable CA is
// workerd's call, and a hand-rolled X.509 check here would be a second, weaker opinion.
function loadCaBundle(paths, trustSystemRaw) {
  const trustSystem = trustSystemRaw === undefined ? true : trustSystemRaw !== "false";
  const pems = [];
  for (const path of paths) {
    let pem;
    try {
      pem = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(
          `FIELDOS_CA_BUNDLE: cannot read ${JSON.stringify(path)} (${e.code ?? e.message}).`,
          { cause: e });
    }
    if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
      throw new Error(
          `FIELDOS_CA_BUNDLE: ${JSON.stringify(path)} contains no PEM certificate.\n` +
          `  Expected a "-----BEGIN CERTIFICATE-----" block; a DER/.crt file needs converting ` +
          `first (openssl x509 -inform der -in ca.crt -out ca.pem).`);
    }
    pems.push(pem);
  }
  // Refused rather than warned: this combination trusts no CA at all, so every https:// fetch
  // fails, and the resulting error names an untrusted peer rather than the empty configuration.
  if (!trustSystem && pems.length === 0) {
    throw new Error(
        `FIELDOS_CA_TRUST_SYSTEM=false requires FIELDOS_CA_BUNDLE.\n` +
        `  Together they would trust no certificate authority at all, failing every ` +
        `https:// request.`);
  }
  return { pems, trustSystem };
}

function parseArgs(argv) {
  const args = {
    out: join(ROOT, ".workerd"), port: 8080, allow: ["public", "private"], buildOnly: false,
    watchdog: true, watchdogInterval: 5000, watchdogFailures: 3, only: undefined,
    interceptor: false,
  };
  for (let i = 0; i < argv.length; i++) {
    // Accept both `--flag value` and `--flag=value`.
    let a = argv[i];
    let inlineValue;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1) {
      inlineValue = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const nextValue = () => (inlineValue !== undefined ? inlineValue : argv[++i]);

    if (a === "--out") args.out = resolve(nextValue());
    else if (a === "--port") args.port = Number.parseInt(nextValue(), 10);
    else if (a === "--allow") {
      const raw = nextValue();
      args.allow = raw === "none" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--only") {
      args.only = nextValue().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--interceptor") args.interceptor = true;
    else if (a === "--build-only") args.buildOnly = true;
    else if (a === "--no-watchdog") args.watchdog = false;
    else if (a === "--watchdog-interval") args.watchdogInterval = Number.parseInt(nextValue(), 10);
    else if (a === "--watchdog-failures") args.watchdogFailures = Number.parseInt(nextValue(), 10);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// Load `.env.local` if present, before anything reads process.env.
//
// Instance state a real deployment gets from the deploy service (ADMINS, ENABLE_ORG_SEPARATION,
// ...) has to be supplied by hand locally, and passing it inline on every run means one forgotten
// prefix silently changes behaviour -- an omitted ADMINS does not error, it just stops the operator
// being an admin, with nothing anywhere saying why (OZL-310).
//
// A real environment variable still wins: the file is a default for the repeated case, not an
// override of a deliberate one-off. `process.loadEnvFile` is stdlib (Node 20.12+), so this needs no
// dependency, and `.env.local` is already gitignored.
if (existsSync(join(ROOT, ".env.local"))) {
  process.loadEnvFile(join(ROOT, ".env.local"));
  console.log("loaded .env.local");
}

const args = parseArgs(process.argv.slice(2));
validateAllow(args.allow);
const caBundle = loadCaBundle(
    (process.env.FIELDOS_CA_BUNDLE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    process.env.FIELDOS_CA_TRUST_SYSTEM);

// The gatekeepers this run includes. `--only` narrows the set for a cheap subset stack (tier-2
// tests boot 3 workers rather than 9; bundling is linear in worker count). This one Set is the
// single source for both the bundle filter and the backend/router service-binding loops below, so
// a subset stays self-consistent -- nothing emits a binding to a service that was not generated.
//
// An unknown name is fatal rather than ignored: a typo that silently produced a smaller stack
// would leave a test passing against a deployment missing the very worker it meant to exercise.
const INCLUDED_GATEKEEPERS = new Set(ALL_GATEKEEPERS);
if (args.only) {
  const unknown = args.only.filter(
      (name) => !ALL_GATEKEEPERS.includes(name) && !CORE_PACKAGES.includes(name));
  if (unknown.length > 0) {
    throw new Error(
        `--only: unknown package(s) ${unknown.map((n) => JSON.stringify(n)).join(", ")}.\n` +
        `  Known gatekeepers: ${ALL_GATEKEEPERS.join(", ")}\n` +
        `  (${CORE_PACKAGES.join(" and ")} are always included and need not be listed.)`);
  }
  INCLUDED_GATEKEEPERS.clear();
  for (const name of args.only) {
    if (!CORE_PACKAGES.includes(name)) INCLUDED_GATEKEEPERS.add(name);
  }
}

// The internal services this deployment depends on, resolved to addresses now because workerd
// filters on the resolved address and never sees the hostname. Pinning at config generation is
// what makes a name usable at all here; the cost is that a host which later changes address stops
// being reachable until the next restart, which regenerates this.
const internalHosts = await resolveInternalHosts(
    parseInternalHosts(process.env.FIELDOS_INTERNAL_HOSTS));

// A name that did not resolve is reported, not fatal. Boot-time DNS is not request-time DNS, and a
// resolver hiccup during a restart must not leave a deployment unbootable -- but silence here would
// surface much later as an opaque connection failure, which is the trap this whole area exists to
// avoid (OZL-251).
for (const { role, target, code } of internalHosts.failures) {
  console.warn(
      `warning: FIELDOS_INTERNAL_HOSTS ${role}=${target} did not resolve (${code}).\n` +
      `         Requests to it will fail at runtime. Check the name, or give an address.`);
}

// The origin the browser reaches this deployment on. Baked into the config rather than discovered,
// because the workers need it to build absolute callback URLs.
const publicBaseUrl = `http://localhost:${args.port}`;

// ---------------------------------------------------------------------------
// 1. Discover + bundle each worker with `wrangler deploy --dry-run --outdir`.
// ---------------------------------------------------------------------------

const ALL_DEPLOYABLE = findDeployablePackages(PACKAGES_DIR);
const included = ALL_DEPLOYABLE.filter(
    (p) => CORE_PACKAGES.includes(p.name) || INCLUDED_GATEKEEPERS.has(p.name));

const bundlesDir = join(args.out, "bundles");
mkdirSync(bundlesDir, { recursive: true });

const workers = []; // { pkgName, config, mainModule, modules, outDir }
for (const pkg of included) {
  console.log(`\nbundling ${pkg.name}...`);

  const outDir = join(bundlesDir, pkg.name);
  // Custom build commands (capnweb-validate) resolve their bin via `pnpm exec`, which requires
  // cwd to be inside the package so pnpm finds its node_modules/.bin.
  //
  // Locked because `--outdir` relocates the *output* but not the *input*: wrangler.jsonc's `main`
  // and its build command share one fixed `.wrangler/validate/` per package, and that tree is
  // emptied before it is rewritten. Two concurrent generators in one package read it torn --
  // OZL-256, see build-lock.mjs. prebuildGeneratedUi is inside the lock because it writes the
  // same package's src/generated/.
  withBuildLock(pkg.dir, () => {
    prebuildGeneratedUi(pkg, ROOT);
    execFileSync(
        "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
        { stdio: "inherit", cwd: pkg.dir },
    );
  });

  const config = readWranglerConfig(pkg.dir);
  const { mainModule, modules } = collectModules(outDir);

  // Remove the generated `.wrangler/validate/` tree the dry-run left behind. `collectModules`
  // reads the relocated `--outdir`, so nothing below needs it.
  //
  // It must not outlive this build: the tree is generated for wrangler's bundler, not for the
  // package's own tsconfig, so a later `tsc`/`types:check` compiles it and fails with TS2345 on
  // `targetKind`. Because `pnpm test` reaches this code, a test run used to leave eight packages
  // in that state and the *next* `pnpm build` failed -- green CI (clean checkout, no leftovers),
  // red locally, on the same commit. `build-release.mjs` cleans up for the same reason.
  rmSync(join(pkg.dir, ".wrangler", "validate"), { recursive: true, force: true });
  workers.push({ pkgName: pkg.name, config, mainModule, modules, outDir });
}

// ---------------------------------------------------------------------------
// 2. uniqueKey persistence: generated once, reused across runs (it names the on-disk DO dir).
// ---------------------------------------------------------------------------

const keysPath = join(args.out, "keys.json");
const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};

function uniqueKeyFor(id) {
  if (!keys[id]) keys[id] = crypto.randomUUID();
  return keys[id];
}

// ---------------------------------------------------------------------------
// 3. Emit config.capnp.
// ---------------------------------------------------------------------------

// capnp string literal escaping: backslash, double-quote, and newlines.
//
// Newlines matter because a capnp string literal cannot span lines: an unescaped one is a parse
// error at *boot*, long after this script exits successfully. Most values here are single-line
// paths and names, but two are not -- a PEM CA bundle (FIELDOS_CA_BUNDLE) is inherently multi-line,
// and instance vars forwarded from the environment are arbitrary operator text. Escaped here, in
// the one helper every emitted string already passes through, rather than at those two call sites.
function capnpString(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function serviceName(pkgName) {
  return pkgName; // wrangler.jsonc's `name` field is already a valid capnp identifier-safe string.
}

// The workers permitted to reach whatever `--allow` grants beyond the public internet. Everything
// else is pinned to public-only.
//
// Deliberately one list here rather than a field in each package's wrangler.jsonc: this is a
// security boundary, and a reviewer must be able to answer "who can reach the internal network?"
// by reading one place. A per-package field would also let a package grant *itself* internal
// reach, which is the network analogue of a gatekeeper asserting its own ambience.
//
// Membership is by dependency, not by trust -- each entry contacts a host the operator chose, and
// on an isolated network that host is internal by definition:
//   workshop-backend        self-hosted inference (ai-models.ts, `config.apiUrl`)
//   gatekeeper-mcp/-portal  on-prem MCP servers (OZL-249)
//   gatekeeper-homeassistant  the pasted instance URL (homeassistant-api.ts) -- this is the
//                           on-prem template; a public Home Assistant is the unusual case
//   gatekeeper-oidc         the issuer's discovery document (identity.ts discoverEndpoints); the
//                           README's own examples are Keycloak, Authentik and ADFS, which are
//                           normally on-prem
//
// Everything absent from this list has no operator-configured endpoint to reach: gatekeeper-context
// and gatekeeper-scheduler own their state in Durable Objects, gatekeeper-github talks to GitHub
// (public, or an operator's GHES once OZL-220 lands -- which will need adding here), and the router
// reaches other workers through service bindings rather than the network.
// Each worker reaches the roles it depends on and no others, so declaring an inference server does
// not also make it reachable from the MCP connector. Keyed by role rather than by worker because
// that is how the operator declares them (FIELDOS_INTERNAL_HOSTS="inference=...,mcp=...").
// Known limitation: an MCP server's OAuth chain follows a `WWW-Authenticate` header and then an
// issuer, both chosen by the far side rather than configured (see gatekeeper-mcp-portal's
// wrangler.jsonc). So an internal MCP server whose issuer lives on a *different* internal address
// than the server itself needs that address declared as another `mcp=` entry. Granting the MCP
// workers the `oidc` role instead would be wrong: that role is the deployment's sign-in issuer,
// which is unrelated to whatever an MCP server nominates.
const INTERNAL_REACH = new Map([
  ["workshop-backend", ["inference"]],
  ["gatekeeper-mcp", ["mcp"]],
  ["gatekeeper-mcp-portal", ["mcp"]],
  ["gatekeeper-homeassistant", ["homeassistant"]],
  ["gatekeeper-oidc", ["oidc"]],
]);

// The outbound service a worker gets. Public-only is the default, so a newly added package is
// safe until someone deliberately lists it above.
//
// A worker with an internal role always gets its own service, whether or not any host was
// declared for that role: `--allow` is the deployment-wide grant and must keep working on its own,
// as it did before FIELDOS_INTERNAL_HOSTS existed. Declaring hosts *adds* that role's addresses on
// top -- the narrowing it buys is that other workers do not get them, not that this one gets less.
function outboundServiceFor(pkgName) {
  // --interceptor overrides everything: every worker's global fetch() goes to one recording
  // worker instead of any network service. That is the point -- it must be impossible for a
  // worker to reach the network by being on some list, so this deliberately ignores
  // INTERNAL_REACH rather than composing with it.
  if (args.interceptor) return INTERCEPTOR_SERVICE;
  return INTERNAL_REACH.has(pkgName) ? outboundServiceName(pkgName) : "internet-public";
}

// One service per worker that has internal reach. Named after the worker so the generated capnp
// says who each grant is for -- `net-gatekeeper-mcp` rather than a shared `internet`.
function outboundServiceName(pkgName) {
  return `net-${pkgName}`;
}

function bindingNameFor(gatekeeperPkgName) {
  return gatekeeperPkgName.toUpperCase().replaceAll("-", "_");
}

// capnp const names must be camelCase with no underscores (workerd only warns, but the fix is
// one-line, so just emit it clean): "gatekeeper-mcp-portal" -> "gatekeeperMcpPortalWorker";
// "kv-blueprint_content" -> "kvBlueprintContentWorker".
function constName(id, suffix = "Worker") {
  const camel = id.replace(/[-_]([a-z0-9])/gi, (_, c) => c.toUpperCase());
  return camel + suffix;
}

const workerLines = [];
const serviceEntries = []; // top-level `services` list entries (name = ..., worker = .x / disk = ... / network = ...)

// `enable_ctx_exports` is a fatal config error at compatibility date 2026-02-02; strip it if a
// wrangler.jsonc ever grows it rather than fail the whole translation.
function compatibilityFlags(config) {
  return (config.compatibility_flags ?? []).filter((f) => f !== "enable_ctx_exports");
}

// Renders one `durableObjectNamespaces` entry + registers the sibling uniqueKey.
function renderDoNamespace(className, keyId) {
  return `      (className = ${capnpString(className)}, uniqueKey = ${capnpString(uniqueKeyFor(keyId))}, enableSql = true),`;
}

for (const w of workers) {
  const { pkgName, config, mainModule, modules, outDir } = w;
  const svc = serviceName(pkgName);

  // workerd picks the main module by *position* (the first `modules` entry), not by matching it
  // against anything else — verified by reproduction: with the ESM module listed after a `.txt`
  // sibling (collectModules sorts alphabetically, so a lexically-earlier .txt often lands first),
  // workerd fails to boot with "Main module must be an ES module" even though the file it
  // actually meant is a perfectly valid ES module. So the main module goes first, unconditionally.
  const moduleLines = [`      (name = ${capnpString(mainModule)}, esModule = embed ${capnpString(relative(args.out, join(outDir, mainModule)))}),`];
  for (const m of modules) {
    if (m.name === mainModule) continue;
    const embedPath = capnpString(relative(args.out, join(outDir, m.name)));
    if (m.type === "text") moduleLines.push(`      (name = ${capnpString(m.name)}, text = embed ${embedPath}),`);
    else throw new Error(`${pkgName}: don't know how to embed module ${m.name} (type ${m.type})`);
  }

  const doNamespaceLines = [];
  const migrations = config.migrations ?? [];
  const allNewSqliteClasses = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
  for (const className of allNewSqliteClasses) {
    doNamespaceLines.push(renderDoNamespace(className, `${pkgName}/${className}`));
  }

  const bindingLines = [];
  for (const kv of config.kv_namespaces ?? []) {
    bindingLines.push(`      (name = ${capnpString(kv.binding)}, kvNamespace = ${capnpString(`kv-${kv.binding.toLowerCase()}`)}),`);
  }
  for (const r2 of config.r2_buckets ?? []) {
    bindingLines.push(`      (name = ${capnpString(r2.binding)}, r2Bucket = ${capnpString(`r2-${r2.binding.toLowerCase()}`)}),`);
  }
  for (const loader of config.worker_loaders ?? []) {
    bindingLines.push(`      (name = ${capnpString(loader.binding)}, workerLoader = ()),`);
  }
  // `browser` has no capnp equivalent; omit entirely (both call sites guard and degrade cleanly).
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    if (typeof value === "string") bindingLines.push(`      (name = ${capnpString(name)}, text = ${capnpString(value)}),`);
    else bindingLines.push(`      (name = ${capnpString(name)}, json = ${capnpString(JSON.stringify(value))}),`);
  }

  // The public origin. On a real deploy these are injected at PUT time, not read from any
  // wrangler.jsonc, so nothing above supplies them and the defaults baked into the workers point
  // at localhost:8787. Without this, an OAuth/connect flow hands the browser a dead link on any
  // port but 8787 — it fails at the *end* of a connect flow rather than at boot, so it looks like
  // the gatekeeper is broken. Mirrors the release manifest's contract (manifest-lib.mjs:187,208):
  // PUBLIC_BASE_URL on the backend, per-gatekeeper BASE_URL under the shared origin.
  if (pkgName === "workshop-backend") {
    bindingLines.push(`      (name = "PUBLIC_BASE_URL", text = ${capnpString(publicBaseUrl)}),`);
    // Instance state the deploy service injects at PUT time on a real deployment, and which no
    // wrangler.jsonc carries (see manifest-lib.mjs). Without a way to set these locally, several
    // controls are simply unreachable on the only stack we can run: `#isAdmin()` compares against
    // ADMINS, so with it unset every user is a non-admin and the admin panel cannot be exercised
    // at all -- which is why OZL-226's verification kept being deferred rather than done.
    //
    // Read from the process environment rather than a flag per variable, so a new instance var
    // needs no change here. Values pass through verbatim; ADMINS is JSON (a string array), which
    // the backend parses itself.
    for (const name of INSTANCE_VARS) {
      const value = process.env[name];
      if (value !== undefined) {
        bindingLines.push(`      (name = ${capnpString(name)}, text = ${capnpString(value)}),`);
      }
    }
  } else if (pkgName.startsWith("gatekeeper-")) {
    const shortName = pkgName.slice("gatekeeper-".length);
    bindingLines.push(
        `      (name = "BASE_URL", text = ${capnpString(`${publicBaseUrl}/gatekeeper/${shortName}`)}),`);
    for (const name of GATEKEEPER_INSTANCE_VARS) {
      const value = process.env[name];
      if (value !== undefined) {
        bindingLines.push(`      (name = ${capnpString(name)}, text = ${capnpString(value)}),`);
      }
    }

    // Per-gatekeeper OAuth credentials, namespaced in the environment so one `.env.local` can hold
    // several gatekeepers' apps without collision: GITHUB_CLIENT_ID here becomes CLIENT_ID inside
    // gatekeeper-github, which is the name the worker reads (`github.ts:367`).
    //
    // A real deployment gets these from the deploy wizard as secrets (see each package's
    // deploy-inputs.json). Locally there was no path at all, so a bound gatekeeper could only ever
    // answer "not configured" -- an honest error with nothing the operator could do about it.
    const envPrefix = shortName.toUpperCase().replace(/-/g, "_");
    for (const name of GATEKEEPER_SECRET_VARS) {
      const value = process.env[`${envPrefix}_${name}`];
      if (value !== undefined) {
        bindingLines.push(`      (name = ${capnpString(name)}, text = ${capnpString(value)}),`);
      }
    }
  }

  // Service bindings the package declares for itself, e.g. the router's WORKSHOP_BACKEND. These
  // are ordinary worker-to-worker bindings and must be translated verbatim — the gatekeeper
  // bindings below are *injected* at deploy time and so are not listed in any wrangler.jsonc.
  // Missing this is not a loud failure: the router falls through to
  // `env.WORKSHOP_BACKEND.fetch(req)` and every /api request dies with
  // "Cannot read properties of undefined (reading 'fetch')".
  for (const declared of config.services ?? []) {
    const target = serviceName(declared.service);
    bindingLines.push(declared.entrypoint
        ? `      (name = ${capnpString(declared.binding)}, service = (name = ${capnpString(target)}, entrypoint = ${capnpString(declared.entrypoint)})),`
        : `      (name = ${capnpString(declared.binding)}, service = ${capnpString(target)}),`);
  }

  if (pkgName === "workshop-backend") {
    // The backend calls gatekeepers through their GatekeeperVendor entrypoint (vendor RPC), not
    // the default entrypoint the router uses (whole-HTTP-request forwarding) — these two differ.
    for (const gkPkgName of INCLUDED_GATEKEEPERS) {
      bindingLines.push(
          `      (name = ${capnpString(bindingNameFor(gkPkgName))}, service = (name = ${capnpString(serviceName(gkPkgName))}, entrypoint = "GatekeeperVendor")),`);
    }
  } else if (pkgName === "router") {
    // The router forwards whole HTTP requests to each gatekeeper's default entrypoint.
    for (const gkPkgName of INCLUDED_GATEKEEPERS) {
      bindingLines.push(`      (name = ${capnpString(bindingNameFor(gkPkgName))}, service = ${capnpString(serviceName(gkPkgName))}),`);
    }
    // Static assets: bind ASSETS to a worker service running fieldos-runtime's assets.js, itself
    // bound to a `disk` service over the built frontend.
    bindingLines.push(`      (name = "ASSETS", service = "assets"),`);
  }

  workerLines.push(`
const ${constName(pkgName)} :Workerd.Worker = (
  modules = [
${moduleLines.join("\n")}
  ],
  compatibilityDate = ${capnpString(config.compatibility_date)},
  compatibilityFlags = [${compatibilityFlags(config).map(capnpString).join(", ")}],
  globalOutbound = ${capnpString(outboundServiceFor(pkgName))},${doNamespaceLines.length > 0 ? `
  durableObjectNamespaces = [
${doNamespaceLines.join("\n")}
  ],
  durableObjectStorage = (localDisk = "do-disk"),` : ""}${bindingLines.length > 0 ? `
  bindings = [
${bindingLines.join("\n")}
  ],` : ""}
);`);
  serviceEntries.push(`    (name = ${capnpString(svc)}, worker = .${constName(pkgName)}),`);
}

// KV/R2 backing worker services (fieldos-runtime), one pair per binding across all workers.
const kvBindings = new Map(); // "kv-<binding>" -> className/keyId
const r2Bindings = new Map();
for (const w of workers) {
  for (const kv of w.config.kv_namespaces ?? []) {
    kvBindings.set(`kv-${kv.binding.toLowerCase()}`, `${w.pkgName}/${kv.binding}`);
  }
  for (const r2 of w.config.r2_buckets ?? []) {
    r2Bindings.set(`r2-${r2.binding.toLowerCase()}`, `${w.pkgName}/${r2.binding}`);
  }
}

const runtimeSrc = join(PACKAGES_DIR, "fieldos-runtime", "src");
for (const [svcName, keyId] of kvBindings) {
  const c = constName(svcName);
  workerLines.push(`
const ${c} :Workerd.Worker = (
  modules = [ (name = "kv.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "kv.js")))}) ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
${renderDoNamespace("KvStore", `kv/${keyId}`)}
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "KvStore") ],
);`);
  serviceEntries.push(`    (name = ${capnpString(svcName)}, worker = .${c}),`);
}
for (const [svcName, keyId] of r2Bindings) {
  const c = constName(svcName);
  workerLines.push(`
const ${c} :Workerd.Worker = (
  modules = [ (name = "r2.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "r2.js")))}) ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
${renderDoNamespace("R2Store", `r2/${keyId}`)}
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "R2Store") ],
);`);
  serviceEntries.push(`    (name = ${capnpString(svcName)}, worker = .${c}),`);
}

// Static assets (router only): an assets worker fronting a disk service over the built frontend.
if (included.some((p) => p.name === "router")) {
  workerLines.push(`
const assetsWorker :Workerd.Worker = (
  modules = [ (name = "assets.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "assets.js")))}) ],
  compatibilityDate = "2026-02-02",
  globalOutbound = ${capnpString(outboundServiceFor("assets"))},
  bindings = [ (name = "DIST", service = "dist") ],
);`);
  serviceEntries.push(`    (name = "assets", worker = .assetsWorker),`);
  // allowDotfiles stays at its default (false): assets.js's own header comment documents this as
  // load-bearing (verified against traversal probes), not an oversight to "fix".
  serviceEntries.push(`    (name = "dist", disk = (path = ${capnpString(FRONTEND_DIST)}, writable = false)),`);

  // The frontend bakes its backend host in at BUILD time. `getBackendHost()` (main.tsx) falls back
  // to `localhost:8787` -- the wrangler dev backend -- for ANY localhost origin unless
  // VITE_BACKEND_HOST was set, but this stack serves the SPA and the API from the same origin on
  // :8080. A dist/ built for `pnpm dev` therefore loads, renders, and then sits forever on "Can't
  // reach the server", with the only evidence in the browser console. Nothing else here can catch
  // it: the stack itself is healthy, and every RPC-level check connects to :8080 directly and
  // passes. So warn from the artifact rather than trust it -- checked, not assumed.
  warnIfFrontendBuiltForOtherHost();
}

// Reads the built bundle and warns when it will dial a host this stack does not serve. A warning,
// not a fatal error: a deployment fronted by a reverse proxy may legitimately bake in another host,
// and refusing to boot over a heuristic would be worse than the bug it guards.
function warnIfFrontendBuiltForOtherHost() {
  let assetsDir = join(FRONTEND_DIST, "assets");
  if (!existsSync(assetsDir)) {
    console.warn(`WARNING: no built frontend at ${FRONTEND_DIST}. Run \`pnpm build\` in ` +
        `packages/workshop-frontend with VITE_BACKEND_HOST=localhost:${args.port}.`);
    return;
  }
  let expected = `localhost:${args.port}`;
  for (let file of readdirSync(assetsDir)) {
    if (!file.startsWith("index-") || !file.endsWith(".js")) continue;
    let source = readFileSync(join(assetsDir, file), "utf8");
    if (!source.includes("localhost:8787")) continue;      // not the dev fallback build at all
    if (source.includes(expected)) continue;               // VITE_BACKEND_HOST was set correctly
    // A build made with VITE_BACKEND_HOST *unset* also contains the string -- as the inert dev
    // literal inside getBackendHost()'s `hostname === "localhost"` ternary, which never fires on a
    // real hostname. That build is CORRECT for a deployment (same-origin via window.location.host,
    // one image for every customer), so warning about it teaches operators to "fix" a good image.
    // The two are distinguishable in the minified output. Setting the variable emits
    //   const e="localhost:8080".trim();return e||(window.location.hostname===...
    // while leaving it unset emits the ternary directly with no `.trim();return` prefix. Match on
    // that shape rather than the bare literal. Verified against both real builds.
    if (!/\.trim\(\);\s*return [^(]*\(?window\.location\.hostname/.test(source)) continue;
    console.warn(
        `WARNING: ${file} was built for the Vite dev backend (localhost:8787), but this stack ` +
        `serves the API on ${expected}. The UI will load and then fail to connect.\n` +
        `         Rebuild with: VITE_BACKEND_HOST=${expected} pnpm --filter workshop-frontend build`);
    return;
  }
}

// The DO storage directory. workerd fails at startup with `Directory named "do-disk" not found`
// if this isn't created before boot.
const doDiskPath = join(args.out, "do-disk");
mkdirSync(doDiskPath, { recursive: true });
serviceEntries.push(`    (name = "do-disk", disk = (path = ${capnpString(doDiskPath)}, writable = true)),`);

// --interceptor: one worker service that records and refuses every outbound request, named as
// every worker's globalOutbound (see outboundServiceFor). The network services below are still
// emitted -- nothing references them in this mode, and leaving them keeps the two paths' configs
// diffable.
//
// This is test scaffolding, not a control: it makes the deployment unable to reach anything.
// Its value is that it sits BELOW the isolate, so no worker (including a dynamically-loaded
// gadget, which inherits its parent's globalOutbound unless it sets its own) can bypass it the
// way it could a patched globalThis.fetch.
if (args.interceptor) {
  workerLines.push(`
const ${constName(INTERCEPTOR_SERVICE)} :Workerd.Worker = (
  modules = [ (name = "interceptor.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "interceptor.js")))}) ],
  compatibilityDate = "2026-02-02",
);`);
  serviceEntries.push(
      `    (name = ${capnpString(INTERCEPTOR_SERVICE)}, worker = .${constName(INTERCEPTOR_SERVICE)}),`);
}

// Outbound network. NEVER emit `deny = ["public"]` — that's a fatal config error. An empty allow
// list (--allow=none) is expressed as `allow = []`, not a `deny`.
//
// Two services, not one. `--allow` describes what the *deployment* may reach -- typically the
// internal inference server, and later the operator's declared MCP hosts -- and only the workers
// that actually have such a dependency get it. Everything else is pinned to public-only, so a bug
// or a compromised dependency in (say) the scheduler cannot reach RFC1918 space just because the
// MCP connector legitimately must. See INTERNAL_REACH below for who is which.
// `tlsOptions` is not optional in practice: without it workerd has no TLS context for outbound
// connections and every https:// fetch fails with `expected tlsNetwork != nullptr; this HttpClient
// doesn't support HTTPS` -- before any connection is attempted, so it does not look like a network
// failure. It went unnoticed because every service verified on this stack so far (Ollama, the stub
// inference server, on-prem MCP) speaks plain HTTP; a corporate HTTPS endpoint hits it at once.
// `trustBrowserCas` uses the system CA bundle, which is what a deployment reaching a normally-
// certificated internal service needs. It grants no additional reach: `allow` still governs that.
//
// FIELDOS_CA_BUNDLE names PEM file(s) holding the customer's own CA, for an internal service whose
// certificate chains to a private PKI -- the airgapped default, since such a network usually cannot
// obtain a publicly-trusted certificate. Verified by execution on workerd 1.20260801.1: the private
// CA alone completes the handshake, and with it removed the *same* request fails
// `unable to get local issuer certificate`, so it is the bundle doing the work and not ambient
// trust. `trustedCertificates` is additive rather than replacing, also verified -- which is why
// FIELDOS_CA_TRUST_SYSTEM exists: an airgapped deployment can set it to `false` to trust the
// private CA *only*, so a public CA cannot vouch for an internal name.
const TLS_OPTIONS = `tlsOptions = (trustBrowserCas = ${caBundle.trustSystem}` +
    (caBundle.pems.length
      ? `, trustedCertificates = [${caBundle.pems.map(capnpString).join(", ")}]`
      : "") +
    `)`;

serviceEntries.push(
    `    (name = "internet-public", network = (allow = ["public"], ${TLS_OPTIONS})),`);

// One service per worker that has internal reach, carrying only the addresses for the roles that
// worker depends on. `--allow` still applies on top: it is the deployment-wide grant, and a role's
// addresses are added to it rather than replacing it.
for (const [pkgName, roles] of INTERNAL_REACH) {
  if (!included.some((p) => p.name === pkgName)) continue;
  const addresses = roles.flatMap((role) => internalHosts.addresses.get(role) ?? []);
  const allow = [...new Set([...args.allow, ...addresses])];
  // Validated here rather than at each source: `--allow` and FIELDOS_INTERNAL_HOSTS are two paths
  // into the same allow list, and checking only the one it was written for is how `mcp=0.0.0.0/0`
  // reached a service ungated. This is where they converge, so a third path would be covered too.
  validateAllow(allow, `FIELDOS_INTERNAL_HOSTS (${roles.join("/")})`);
  serviceEntries.push(
      `    (name = ${capnpString(outboundServiceName(pkgName))}, ` +
      `network = (allow = [${allow.map(capnpString).join(", ")}], ${TLS_OPTIONS})),`);
}

// The socket below points `service = "router"`, which resolves to the "router" entry the worker
// loop already pushed — no separate alias entry needed (Service has no `service` field of its
// own; a bare-name ServiceDesignator just looks up an existing service by name).
const capnp = `using Workerd = import "/workerd/workerd.capnp";

# Generated by scripts/run-workerd.mjs — do not edit by hand, rerun the script instead.
${workerLines.join("\n")}

const config :Workerd.Config = (
  services = [
${serviceEntries.join("\n")}
  ],
  sockets = [
    (name = "http", address = "*:${args.port}", http = (), service = "router"),${args.interceptor ? `
    # --interceptor only: a second socket straight onto the interceptor, so a test can read back
    # what was attempted (GET /__fieldos_intercepted). Port 0 lets the OS assign one, which
    # workerd reports through --control-fd; a fixed port would collide with a parallel run.
    (name = "interceptor", address = "127.0.0.1:0", http = (), service = ${capnpString(INTERCEPTOR_SERVICE)}),` : ""}
  ],
);
`;

mkdirSync(args.out, { recursive: true });
writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
const configPath = join(args.out, "config.capnp");
writeFileSync(configPath, capnp);
console.log(`\nwrote ${configPath}`);

// TLS trust, printed for the same reason as reach below: a handshake refused for want of a CA
// reports an untrusted peer, never an empty bundle, so this is the only place an operator can see
// that the CA they supplied was actually loaded.
console.log(`\nTLS trust: system CA bundle ${caBundle.trustSystem ? "trusted" : "NOT trusted"}` +
    (caBundle.pems.length
      ? `, plus ${caBundle.pems.length} operator CA file(s) (FIELDOS_CA_BUNDLE)`
      : ""));

// Print the reachability actually emitted. A refused connection is undiagnosable at runtime -- an
// opaque token to the caller, an addressless line in the log (OZL-251) -- so this is where an
// operator gets to see what they granted, and to which worker, without reading generated capnp.
if (args.interceptor) {
  // Printing per-worker network reach here would be actively misleading: --interceptor overrides
  // every worker's globalOutbound, so none of it applies.
  console.log(`\noutbound reach: NONE — every worker's fetch() goes to the ${INTERCEPTOR_SERVICE}`);
  console.log("  service, which records the request and answers 403. Test scaffolding: this");
  console.log("  deployment cannot reach anything.");
} else {
  console.log(`\noutbound reach (--allow ${args.allow.join(",") || "none"}):`);
  for (const [pkgName, roles] of INTERNAL_REACH) {
    if (!included.some((p) => p.name === pkgName)) continue;
    const addresses = roles.flatMap((role) => internalHosts.addresses.get(role) ?? []);
    console.log(addresses.length > 0
        ? `  ${pkgName}: ${[...args.allow, ...addresses].join(", ")} (${roles.join(", ")})`
        : `  ${pkgName}: ${args.allow.join(", ") || "nothing"} ` +
          `— no ${roles.join("/")} host declared`);
  }
  console.log("  all other workers: public only");
}

// ---------------------------------------------------------------------------
// 4. Spawn workerd, unless --build-only, supervised by a watchdog unless --no-watchdog.
//
// Watchdog: standalone workerd has no CPU/memory limits, and it serves every worker and
// socket on one event loop thread, so a gadget running `while(true){}` pins a core and wedges
// the ENTIRE process — every workspace, not just the one that caused it. This gives RECOVERY,
// not isolation: a runaway still interrupts everyone until the restart completes. SIGTERM is
// ignored by a wedged process (verified), so there is no graceful path — go straight to SIGKILL.
// Nothing in-process can report health while the loop is blocked, so the probe is an external
// HTTP request from this parent process against the socket.
// Resolve the pinned binary rather than letting `pnpm exec` pick one by hoisting. Several workerd
// versions can sit in the store at once, and the KV/R2 binding protocols fieldos-runtime
// implements are UNVERSIONED workerd internals valid for the pinned version exactly — so a
// hoisting change could silently run the deployment on a runtime whose protocol has drifted, while
// every test still passes against the pinned one. Same resolution the test suite uses.
const WORKERD = fileURLToPath(import.meta.resolve("workerd/bin/workerd"));

function spawnWorkerd() {
  console.log(`\nstarting: workerd serve config.capnp --experimental (port ${args.port})\n`);
  return spawn(
      WORKERD, ["serve", "config.capnp", "--experimental"],
      { stdio: "inherit", cwd: args.out },
  );
}

if (args.buildOnly) {
  console.log("--build-only: not starting workerd.");
  process.exit(0);
} else if (!args.watchdog) {
  const child = spawnWorkerd();
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // CALIBRATION KNOBS: the watchdog can't distinguish "wedged" from "legitimately busy under
  // load" — it only sees that the socket didn't answer in time. --watchdog-interval and
  // --watchdog-failures trade false-kills of a heavy-but-healthy workload against how long a
  // real wedge stays up before recovery. Don't hardcode these lower without re-checking against
  // real gadget workloads.
  const RAPID_RESTART_WINDOW_MS = 60_000; // a restart inside this window of the previous one counts as "wedged again soon"
  const MAX_RAPID_RESTARTS = 5; // crash-loop ceiling before we give up and let an operator look

  let child = spawnWorkerd();
  let consecutiveFailures = 0;
  let rapidRestarts = 0;
  let lastRestartAt = 0;
  let stopped = false;

  child.on("exit", (code, signal) => {
    // Only relevant once we've deliberately stopped supervising (crash loop, or shutting down).
    if (stopped) {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    }
  });

  async function probeHealthy() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`http://localhost:${args.port}/`, { signal: controller.signal });
      return res.ok || res.status < 500; // any real HTTP response means the event loop is alive
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function respawn(reason) {
    console.error(`watchdog: restarting workerd (${reason}, ${consecutiveFailures} consecutive failures)`);
    child.removeAllListeners("exit");
    child.kill("SIGKILL"); // SIGTERM is ignored by a wedged process (verified) -- don't try it first.

    const now = Date.now();
    rapidRestarts = now - lastRestartAt < RAPID_RESTART_WINDOW_MS ? rapidRestarts + 1 : 1;
    lastRestartAt = now;

    if (rapidRestarts > MAX_RAPID_RESTARTS) {
      stopped = true;
      console.error(
          `watchdog: ${rapidRestarts} restarts within ${RAPID_RESTART_WINDOW_MS}ms -- ` +
          "this looks like a crash loop, not a transient wedge. Stopping supervision; " +
          "operator needs to investigate before this is restarted again.");
      process.exit(1);
    }

    // Exponential backoff before respawning, so a fast crash loop doesn't hot-loop the CPU.
    const backoffMs = Math.min(1000 * 2 ** (rapidRestarts - 1), 30_000);
    consecutiveFailures = 0;
    setTimeout(() => {
      child = spawnWorkerd();
      child.on("exit", (code, signal) => {
        if (stopped) {
          if (signal) process.kill(process.pid, signal);
          else process.exit(code ?? 0);
        }
      });
    }, backoffMs);
  }

  (async function watchdogLoop() {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, args.watchdogInterval));
      if (stopped) break;
      const healthy = await probeHealthy();
      if (healthy) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= args.watchdogFailures) {
        respawn("health probe failed");
      }
    }
  })();
}
