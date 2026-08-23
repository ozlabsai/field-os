This project is building a platform for "vibe coded" personal applications and AI agents that run inside a strong sandbox.

The following files are commonly important to reference:

* packages/workshop-shared/node_modules/capnweb/README.md: Explains how to use Cap'n Web RPC, which is used extensively for client-server communications.
* packages/workshop-shared/src/api.ts: Defines the RPC API used between the frontend and backend.

The project structure is:

* packages/workshop-frontend: The Gadgets Workshop UI.
    * This is a pure single-page app, running entirely client-side.
    * It speaks to the backend using an RPC API over a persistent WebSocket connection.
    * Uses React, Kumo UI (https://kumo-ui.com/api/component-registry), Phosphor icons, and Vite.
* packages/workshop-backend: The Gadgets Workshop server.
    * Runs on Cloudflare Workers.
    * This is the **kernel**: it defines the architecture and is held to a higher bar than UI/gatekeeper code. Reviewers read *every line* of `workshop-backend` and of API changes in `workshop-shared`, so keep diffs here small and elegant. Concretely: doc-comment **every** exported member of the `workshop-shared` public API (types, consts, and functions — not just interfaces); never introduce a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast (derive from the real type instead, or rethink the design); and prefer reusing existing mechanisms over adding parallel ones. Capability-based security note: a resource becomes "ambient" (auto-injected) only by user/admin configuration — a gatekeeper must never assert its own ambience. When a change to this package is large, split it by concern into separate PRs (and at minimum group commits so `workshop-backend`/`workshop-shared` can be reviewed apart from UI), since fewer kernel lines = easier review.
    * `format-blueprints/` holds the **output format** blueprints the deployment ships with, committed as data: a `<name>.gadget` archive plus a `<name>.json` sidecar giving its `blueprintId`, prose, and `output` presentation. `scripts/build-format-blueprints.mjs` globs that directory (override with `FORMAT_BLUEPRINTS_DIR`, which lets a fork ship its own set without touching this submodule) into the gitignored `src/generated/format-blueprints.ts`, so `build`, `types:check` and `test` all run the generator first. Replace one with `pnpm import:format-blueprint <export.gadget> <blueprintId>`, or add one with `pnpm import:format-blueprint <export.gadget> --new <name>`; never edit a `blueprintId` after deploy, since the install and promotion are keyed on it and a rename orphans the old entry. See `format-blueprints/README.md`.
* packages/workshop-shared: Shared API definitions between client and server.
    * This defines the application's RPC interface.
    * The RPC protocol is Cap'n Web, which has similar semantics to Cloudflare's Worker-to-Worker RPC system, while being able to run in a browser over WebSocket. Read the readme for details.
* packages/configurator-ui: Type-only component helpers used by optional gatekeeper resource configurator UI modules.
    * Gatekeeper configurator UI modules are compiled by `scripts/build-gatekeeper-configurator.mjs` as part of package builds.
* packages/gatekeeper-*: Gatekeeper workers for external service integrations.
    * Each gatekeeper runs as a separate Cloudflare Worker.
    * Gatekeepers handle OAuth flows and provide sandboxed access to external APIs.
    * A gatekeeper may declare `VendorDescription.autoProvisionsAccount`: it can mint a connected account with no OAuth flow (via `GatekeeperVendor.createAccount()`, which takes no user identity). For such gatekeepers the deployment admin picks a per-vendor mode in the admin Gatekeepers panel — **disabled** / **optional** / **enabled** (default **optional**) — resolved in `provisioning-policy.ts`: `enabled` auto-provisions the account for every user (forced, and hidden from the Connectors list), `optional` lets each user opt in from the Connectors page, and `disabled` offers it to no one (existing accounts go dormant). The Workshop persists the account in the user DO like any connected account (the account capability — not an asserted identity — is the authority thereafter). The **account** (a `GatekeeperUser`) declares in its `AccountDescription` whether it provides an agent **singleton** (`singleton: { tsType }`) and/or a **management UI** (`providesUi`). The Workshop auto-provides the singleton to the owner's workspaces as an **ambient gatekeeper record**, folded into each chat's env as a **named chat binding** (named by the gatekeeper's `suggestedBindingName`; see `prepareChatBindings` in overseer.ts) that the agent reads in `executeCode` (`getSession`/`getAgentCatalog`), each read recorded as an observation. It is not bound to any gadget by default — most gadgets never call it programmatically — but the agent may wire it into a gadget's binding list with `setGadgetBinding` when the gadget's persistent code needs it. The UI is hosted at `/gatekeepers/$appId` (the gatekeeper's vendor id, e.g. `/gatekeepers/context`) via `startAppUi({ isAdmin })`. The two are orthogonal — an account can declare either, both, or neither.
* packages/mcp-shared: Shared implementation behind the two MCP gatekeepers — `gatekeeper-mcp` (endpoints a user pastes) and `gatekeeper-mcp-portal` (one admin-configured portal). Not a Worker; a library both import, holding the MCP client, the OAuth chain, the account DO base, the resource-URL scope grammar, and the queued-action store. See `packages/mcp-shared/README.md` and each connector's README.
    * The trust boundary is `tools.ts`, and nothing outside it reads a tool's annotations: a tool the server declares `readOnlyHint: true` runs as an observation, everything else is queued for approval, and auto-*applying* a write additionally requires a `vetted` endpoint — which only the portal can produce, via `MCP_PORTAL_TRUST_ANNOTATIONS`.
    * OAuth uses the official `@modelcontextprotocol/client`; always give SDK OAuth operations `sdkFetch(...)` so every request and redirect retains endpoint and SSRF checks.
* packages/gatekeeper-context: The Context Library — a gatekeeper whose account provides a singleton read session + a management UI, for authoring collections of context documents that agents read as observations. Collections have one of two visibilities: **private** (owned by a single account, readable/writable only by that account) and **public** (created/edited only by deployment admins, readable by everyone and auto-enabled for all users). It owns its state in three Durable Objects (`ContextCollectionDurableObject` for content, `UserLibraryDurableObject` for each account's own private collections, `LibraryRegistryDurableObject` for the domain's public set) plus a KV namespace. All data is namespaced by a `sharingDomain` (from the binding's props, see `domain.ts`) so multiple workshops sharing one gatekeeper instance stay isolated.
    * Its `GatekeeperVendor` entrypoint (bound as `GATEKEEPER_CONTEXT`) declares `autoProvisionsAccount` and mints a `ContextAccount` via `createAccount()` (no user identity is passed in; the account keys its private data by its own generated `accountId`). The account exposes the agent read session (`getSession()`), collection discovery metadata (`getAgentCatalog()`), and a management UI (`startAppUi({ isAdmin })`). The UI is a single-file React SPA in `app/` (Vite + Tailwind + Kumo) bundled by `build-app.mjs` into `src/generated/app.txt`.
* packages/gatekeeper-scheduler: Scheduled Tasks — an auto-provisioned gatekeeper whose account provides an ambient singleton for registering persistent workspace callbacks plus a read-only management UI. One account-scoped `ScheduleDriver` Durable Object stores enabled schedules and delivers them from a shared alarm; hook enablement remains in the Workshop Connections UI.
* packages/router: The public origin of a deployed gadgets instance. Serves the workshop-frontend assets and routes by path prefix: `/api/*` and `/blueprint-screenshot/*` to the workshop backend, `/gatekeeper/<name>/*` to whichever gatekeepers are bound (discovered by scanning its own `GATEKEEPER_*` service bindings, so installing a gatekeeper is purely a binding change). The same worker doubles as the dev router (`pnpm dev-server`): with no `ASSETS` binding it proxies frontend requests to the Vite dev server instead.

Deployment admin settings (the `/admin` panel) follow a few conventions worth knowing when extending them:

* `packages/workshop-backend/src/admin-config.ts` defines `AdminConfig` — the deployment's "soft" customizations: agent instructions, banners/theme, and which gatekeeper connectors/resources are offered (plus the three-state mode for auto-provisioning gatekeepers, see `provisioning-policy.ts`). Connectors/resources default to enabled and the admin UI opts them *out*; auto-provisioning gatekeepers default to *optional*. **Authentication/authorization config (sign-in providers via `AUTH_GATEKEEPERS`, password login via `DISABLE_PASSWORD_AUTH`) is deliberately NOT here** — it stays env-var driven (`auth/config.ts`) so it can't be changed by a compromised admin session.
* The `AdminSettings` durable object owns the authoritative `AdminConfig` and mirrors it to a single reserved KV key (`.adminConfig`, see `isReservedBlueprintKey()`), so hot-path code (connect/agent) reads it with one cheap KV get via `readAdminConfig(env)`. The DO is the only writer (`updateAdminConfig(patch)`).
* Admin operations are exposed as an `AdminApi` capability obtained via `AuthenticatedApi.getAdminApi()` (returns null for non-admins). The `#isAdmin()` check happens once when the capability is minted, so the individual methods don't re-check.
* `user.ts:getGatekeeperClassFor()` is the single core chokepoint where disabled gatekeepers/resources are enforced before a capability is minted (gadget/agent code can't reach it directly).

Release pipeline (`scripts/release/`) — how customer instances get deployed:

* `build-release.mjs` bundles every deployable worker byte-identically (wrangler dry-run with the pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest — the contract between this repo's CI and the deploy service, produced by `manifest-lib.mjs` from each package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`, `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
* `upload-release.mjs` mirrors the release to R2 content-addressed, manifest last; with `--candidate` the manifest lands under `candidates/<id>/` (invisible to the deploy service) so e2e can verify it, and `promote-release.mjs` then copies it to `releases/<id>/` — publishing is that single all-or-nothing manifest copy. The copy is not isolated against concurrent promotions, so CI serializes promote runs (a GitLab resource group) and the script's newer-release guard skips candidates that a later release has already superseded.
* The manifest is covered by a golden-file test; after an intentional manifest change, regenerate with `UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js` and review the golden diff.
* Running the flow by hand (upload and promote need `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`):
    * `node scripts/release/build-release.mjs --out release-out` — build everything into `release-out/` (id defaults to `r<CI_PIPELINE_IID>-<sha7>` in CI, `dev-<timestamp>` locally; override with `--release-id <id>`).
    * `node scripts/release/upload-release.mjs --release release-out --candidate` — mirror to R2; omit `--candidate` to publish directly (bypasses the gate — CI never does this).
    * `node scripts/release/promote-release.mjs --release-id <id>` — copy the verified candidate's manifest into `releases/<id>/`.
* Deploy-wizard configuration: an installable gatekeeper's user-supplied inputs default to OAuth `CLIENT_ID`/`CLIENT_SECRET` secrets; a per-package `deploy-inputs.json` overrides them, and `NO_DEFAULT_CRED_INPUTS` in `manifest-lib.mjs` opts out gatekeepers that take no third-party OAuth app credentials (the wizard blocks Install on unfilled secret inputs, so a spurious default makes a gatekeeper uninstallable). Backend instance-state vars (`ADMINS`, `DEPLOY_URL`, ...) are injected by the deploy service at PUT time, never manifest-templated.

To test changes:
- Run `pnpm build` (optionally narrowed to a particular package) to run TypeScript type checks.
- Run `pnpm test` to run unit tests, though as of this writing most packages don't have tests yet.

Linting (oxlint):
- `pnpm lint` runs what CI currently enforces: `lint:check` (oxlint) and `types:check` (recursive `tsc --noEmit`). Run this before pushing.
- Individual scripts:
    * `pnpm lint:check` / `pnpm lint:fix` — oxlint (config in `.oxlintrc.json`; `correctness` + `suspicious` as errors).
    * `pnpm types:check` — recursive `tsc --noEmit`.
- Unused function parameters and caught errors are not lint-enforced; unused imports and local variables are still errors.
- Some rules are kept as warnings (e.g. `no-shadow`) for incremental cleanup; warnings don't block CI.
- Type-aware oxlint rules are intentionally not enabled. The type-aware engine (tsgo) requires an explicit `rootDir` under declaration emit and drops `baseUrl`, which is incompatible with this monorepo's cross-package source imports. Among other things this means `no-floating-promises` is not enforced — which is just as well, since RPC promise pipelining (below) intentionally leaves promises unawaited. Type safety is still enforced by `tsc` through `pnpm types:check` and `pnpm build`.

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.

IMPORTANT: Server-side logging uses `@gadgets/backend-utils/logger` (frontend browser `console.*` is out of scope):
- Define a package-owned field type and module-scoped logger with a stable dot-separated `component`
  and, for gatekeepers, `vendorId`:
  `const logger = createLogger<GitHubLogFields>({ component: "gatekeeper.github", vendorId: VENDOR_ID });`.
- Emit concrete event names and relevant typed fields, for example:
  `logger.warn("failed to notify credential expiry", { event: "credentials.expiry.notify.failed", error: err });`.
  Each call emits one indexed object; module/child fields such as `vendorId` are inherited.
- Use immutable `logger.with(fields)` for object-owned or nearby context. Prefer module/object loggers
  over logger parameters, and do not replace a shallow child logger with ambient context just to
  remove a local variable.
- For bounded operation context needed by deep helpers, independent loggers, or other observability
  consumers, use `createObservabilityContext` from `@gadgets/backend-utils/observability-context`.
  Re-establish it per operation;
  it does not cross RPC, hibernation, or restart, and requires `nodejs_als` or `nodejs_compat`.
- Pass caught values as `error`. The helper stringifies `Error` instances and primitives, uses an
  own string `message` for plain objects, omits `undefined`, and adds stacks to all `Error` logs.
  Keep this normalization deliberately small; do not traverse causes or copy arbitrary properties.
- Extend field vocabularies locally. Levels: `error` needs attention, `warn` continues best-effort,
  `info` is notable lifecycle, and `debug` is noisy breadcrumbs. Never log secrets, prompts, headers,
  tokens, or request/response bodies.
- To also dispatch a failure to the optional external issue Reporter (in addition to logging it),
  call `reportIssue(failureSite, caught, options?)` from
  `@gadgets/backend-utils/error-reporting`. Attach ambient fields from the package's observability
  context and augment them with capture-site fields:
  `reportIssue("overseer.catalog-fallback", err, { handled: true, attributes: { ...obsContext.get(), gatekeeperId } });`.
  It is a no-op when the `ERROR_REPORTER` binding is absent (local dev / deployments without an issue
  destination). Only bounded scalars are retained as attributes; reported context obeys the same
  no-secrets rules as log fields.

IMPORTANT: Frontend error reporting is a separate, opt-in path:
- `@gadgets/error-reporting` owns the vendor-neutral browser/Worker event contract and tolerant,
  bounded normalization. `VITE_FRONTEND_ERROR_REPORTING=true` enables trusted frontend producers
  and their hidden source maps at build time; deployments without reporting should leave it unset.
- The Workshop browser sends best-effort reports to the same-origin `POST /api/client-errors`
  endpoint. The backend dispatches only when both `FRONTEND_ERROR_REPORTER` and
  `FRONTEND_ERROR_RATE_LIMITER` are bound; otherwise the endpoint is an intentional no-op.
- Gatekeeper management/configurator UIs run as Workshop-owned opaque-origin `srcDoc` frames. They
  send bounded reports with `postMessage`; the host accepts them only from the known frame window
  with origin `null`, adds host-owned surface/vendor context, and performs the same-origin POST.
  Do not add direct cross-origin reporting from a gatekeeper Worker domain.
- Frontend reports and frame metadata are diagnostic only and never convey identity or authority.
  Install automatic capture only in trusted first-party surfaces, never gadget/user-authored code.
  Exception messages and stacks reach the external Reporter, so never intentionally put secrets,
  prompts, tokens, headers, or request/response bodies in thrown errors or report metadata.

---

## Verification posture

This is a fork that runs on a different runtime than upstream tests against, so claims in the
planning docs decay silently. Each rule below was earned by a specific failure rather than stated
as principle. The incidents behind them are recorded in `plans/handoff.md` § Traps and
`plans/handoff-deployment.md` § Traps, which hold more detail and more cases than are distilled
here.

**Plan claims are hypotheses until executed.** `plans/*.md` records reasoning, not guarantees. Two
plausible, load-bearing claims were wrong: "R2 → MinIO, R2's API is S3-compatible" conflated R2's
*S3 endpoint* with the *binding*, which MinIO cannot serve; "local inference is zero code changes"
conflated the *endpoint* with the *request body*, and real vLLM rejects what we were sending. Both
cost real time. When you correct one, cite `file:line` and fix it in the plan.

**A test that does not exercise its subject is indistinguishable from a pass.** A denial-of-service
repro silently never started the gadget — a missing `mainModule` meant the loader failed, the
process looked healthy, and the result read green. Read the log, not the exit code. When a check
matters, confirm it can *fail*: break the thing deliberately and watch it go red.

**Prefer execution to inference, and label which you did.** "Verified by execution" and "inferred
from the schema" are different claims and should not be written the same way. This matters most for
delegated work: several agent findings were wrong in both directions, including a warning that the
R2 protocol would be far harder than KV, which execution refuted.

**Run a check before the change, and predict what it will say.** A verification script is
apparatus, and nothing else verifies it. A post-deploy check reported `keys.json missing or empty` —
character-identical to the output of genuine total data loss — when the real fault was a wrong path
in the check (`/data` vs `/var/lib/fieldos`). Run only afterwards, it reads as a coherent story
about user data being destroyed. What caught it was that **one failure was predicted and two
arrived**. This is a different mechanism from the rules above: it needs no hypothesis about which
part is broken, and it is the only one that covers the checker itself. Note the direction — this
class bites in *reporting*, not engineering, and a false alarm about destroyed user data is its own
kind of expensive.

The same rule caught the mirror case the same day, and that one is worse. A check for whether a
shipped bundle contained a fix was baselined against the *previous* release expecting three
failures; **two passed**. Both matched strings that already existed elsewhere in the old build —
`"Choose a model"` lived in two unrelated components, and a sentinel constant predated the change.
Run only after the deploy it would have reported 3/3 green **whether or not the fix shipped**. A
false negative is visible and gets chased; a false positive is invisible and gets believed, so a
check that cannot fail is worse than no check. Prove each assertion discriminates by watching it go
red against the state it is meant to reject — and for a string match, confirm the string is absent
from the old build rather than merely present in the new one.

Generalised, because it recurred the same day in a form with no strings in it: **an assertion that
happens to be true is not the same as one that could only be true.** A blank pane was attributed to
the iframe branch because it showed no text — correct, but three other branches are also textless,
including a stuck spinner, so the reasoning did not exclude them. The repair was to find a property
only one branch has: the pane was *white on a dark host*, and the iframe is the sole separate
document (`createSandboxedHtml` emits a bare `<html><body>` with no background), so every themed
React branch would have been dark. Same defect as the grep, same check in both cases — **ask what
else could produce this result, and if the answer is anything plausible, the assertion is not
discriminating yet.**

**Observing and explaining are different acts with different failure rates — label which one you
are doing.** Counted over a single day: observations held almost without exception; *mechanisms*
were wrong four times from this project's own sessions (a missing `client.js` that existed, a
missing empty state that shipped, `useState(null)` as "the default" when the state is hydrated after
mount, and `executeCode` "returning no output" when its handler returns `toolResult(output, …)`) and
three times from the coding agent under test (`dup()` "unavailable in all contexts" — wrong about
capnweb; a `finish` tool that does not exist; the same `executeCode` claim).

This is not the rule above restated. That one is about *how you obtained* a claim — ran it, or
reasoned it. This one is about *what kind of claim it is* — what happened, or why. They come apart
in the case that keeps biting: an execution-backed observation supporting an inferred mechanism that
is wrong. Every wrong mechanism above cited real, correctly-quoted code. That is what makes them dangerous: the
evidence is sound and the inference from it is not. So state the measurement separately from what
you think it means, and mark the second — it is far likelier to be wrong and far cheaper for someone
else to correct when it is flagged. This applies to *anything* reporting on a system, including an
agent under test: treat its account of what happened as evidence and its account of why as a
hypothesis. Doing so is not hedging; it puts the low-failure-rate claim where it survives the
high-failure-rate one collapsing.

**State the scope of a measurement, not just its result.** A sound measurement reported in a
sentence broader than the thing measured produces confident wrong action, and nothing downstream can
detect it — the number is right, so it survives every check. One probe showed a callback arriving in
a gadget as a plain object with its methods gone; that was reported as "the callback does not arrive
as a stub", and a permanent instruction was written telling the agent that gadget subscriptions do
not work and to poll instead. Exactly one callback *shape* had been tested. A bare function crosses
the same boundary as a live stub with a working `dup()`, and the whole feature works. The failing
shape was the one the prompt itself taught.

*"An object callback arrives dead"* and *"callbacks arrive dead"* differ by one word and lead to
opposite instructions. So name what varied and what did not: which shape, which path, which version,
how many cases. And weigh the asymmetry before writing anything permanent from a single measurement —
a missing instruction gets discovered when someone needs it, while a wrong *"this does not work"*
gets believed and never retested.

The reader of a measurement has the cheaper half of this. *"Which shape did you test?"* costs one
message; not asking it cost a permanent instruction that removed a working capability. When someone
hands you a result and you are about to write something durable on top of it, ask what varied
before you build on it.

**A waiting tool's exit code is not its answer.** `gh pr checks` exits **8** while checks are still
pending, so `until gh pr checks ... 2>/dev/null; do sleep; done` treats "still running" as "done"
and returns instantly with no output. Three CI waiters completed against still-running builds before
this was noticed, and a second session independently reproduced it — having already filed one
implausibly fast "settle" as *CI being quick*.

That is what makes this class expensive rather than merely annoying: the failure **supplies its own
innocent explanation**, so the anomaly gets absorbed instead of investigated, and the next step
proceeds on a green that was never measured. Key a wait on the *content* — `--json bucket --jq
'.[] | select(.bucket=="pending")'` and wait for empty — not on the exit status, and confirm the run
you are waiting on is the one built from your HEAD sha rather than a superseded run of the same
branch.

**A capability sweep needs one row whose answer you already know.** Five sandbox probes were run
across three iframe `sandbox` variants to find which browser capabilities fail silently. All
**fifteen rows came back identical across all three variants** — including a form-submit row *known*
to differ from a separate clean measurement. The harness was not exercising the sandbox at all and
every row was junk.

Nothing about the individual results looked wrong; *"downloads fail silently, clipboard is blocked"*
is entirely plausible, and run with a single variant — as the first version was — they would have
been reported as findings and accepted by a reviewer with context left to spend. The only thing that
caught it was a row with a **predicted** result, and the prediction failing. This is the pre-run
baseline applied to a capability sweep, and it is the cheapest form of it: one known row costs
nothing and validates the other fourteen. A result that does not vary with the input is a broken
instrument, not a finding.

**Grep is not a search.** A character class missing `_` hid two services and produced a confident
false alarm; a name-based dead-code scan false-positived because `agent.ts` contains `export class`
declarations *inside a prompt template literal*. Resolve imports rather than matching names, and
sanity-check a pattern before trusting a negative result.

**Derive, never restate.** When the same fact must exist in two places, compute the second from the
first. Two people reached for this independently in one week without any guidance saying to:
`data-tour` selectors are computed from each row's resolved route (`SidebarItem.tsx`) rather than
threaded through every call site, and `AiModelProvider` is derived from `AI_MODEL_PROVIDERS`
(`api.ts`) so the runtime list and the type cannot disagree. The cost of restating is not
untidiness — the copies drift *silently*, and the failure surfaces far from the edit that caused
it. Where derivation is genuinely impossible, such as a string in one package describing data
committed in another, a test that reads the real source is the substitute.

**The author is structurally the wrong reader.** Two sessions working the same bug produced nine
wrong mechanisms in a day, and **neither caught their own worst one** — each was caught by the other
person. That is not a story about carelessness; a wrong assumption is invisible to its author
precisely because it is the thing being reasoned *from* rather than *about*. The remedy is a second
reader, not more care from the first.

What makes a second reader useful rather than merely present is the separation this file keeps
returning to: **state the measurement apart from what you think it means.** Welded together, a
reader who doubts the conclusion has to reject the evidence with it, so they usually reject neither.
Stated apart, three exchanges in one day each kept one half and discarded the other — a correct
caller identification survived a wrong mechanism, a sound bundle measurement survived a wrong
conclusion drawn from it, and a good prompt rewrite survived the too-broad scope that prompted it.
Every time, the surviving half was the one that had not been attached to the other.

**An intervention that can be inert must report whether it fired.** A hook, probe, blocker or
filter that silently does nothing yields a null result indistinguishable from a real refutation,
and the silence reads as evidence. Four instances in one debugging session: a `console.error` hook
that caught nothing because React holds its own reference; an event blocker that blocked nothing; an
`appendChild` hook that dynamic `import()` bypasses; and a router probe that would have been
half-armed had its methods not been checked first. Each was caught only by a count nobody asked for
— `probe armed: 2/2`, `0 events blocked`. The rule extends one level up, which is where it bit
hardest: the check that the intervention is *present* can be inert too. `grep -c … | head -1` over
a two-file glob reported `0` for a probe that was sitting in the second file.
