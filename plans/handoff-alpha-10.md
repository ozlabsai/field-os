# Handoff — Alpha 10, and why Beta is not the next thing

Written 2026-08-23. Read this first, then
[`handoff-deployment.md`](./handoff-deployment.md) for the deployment layer and
[`handoff.md`](./handoff.md) for the airgap port underneath it.

## Where things stand

**FieldOS is live at https://os.ozlabs.ai running `v0.1.0-alpha.10`, deployed by its own pipeline.**
A git tag builds, tests, pushes and deploys; four releases have gone out that way
(`alpha.7`–`alpha.10`).

Verified against the running deployment, **16/16**, with every check baselined to *fail* against the
previous release before being trusted:

| | |
|---|---|
| deployment health, through the public edge | 9/9 — TLS, gate, `/healthz` reaching the backend isolate, SPA served |
| the OZL-134 backend fix, in the running bundle | 3/3 |
| the OZL-134 prompt fix, in the agent's system prompt | 4/4 |
| restore, against the **live** volume with real data | full wipe → restore → content fingerprint identical |
| `pnpm lint` / `build` / `test` | 0 / 0 / 0 |

`AGENTS.md` § Verification posture went from 6 rules to 10 in one day, each earned by a specific
failure. They are worth reading before starting: every one of them cost hours.

## The one number that should decide what happens next

**Roughly ninety minutes of real human use produced five bugs, and the rate did not drop.**

| | |
|---|---|
| model picker's "No agent" silently swallowed messages | fixed, deployed (OZL-313) |
| Context Library invisible until opted into | not a bug — documented |
| gadget UI blank — `dup()` unusable through the facet Proxy | fixed, deployed (#139) |
| every gadget subscription silently dead | fixed, deployed (#145) — **the real OZL-134** |
| the agent puts the UI in `server.js`, leaves `client.js` empty | **open (#151)**, found *after* the above, on the very next gadget |

A full day of infrastructure verification found **none** of them. Every verification passed
correctly, throughout, while the product was unusable.

**So: do not start Beta yet.** Alpha's issue list was genuinely all closed — the list just did not
contain "someone uses it". Beta normally means the shape is settled and the work is hardening; one
sample of real use suggests the shape is not settled. Get a second sample first.

## Start here

**Build three or four real gadgets, end to end, and fix what breaks.** That is what the most
valuable ninety minutes of the previous session were spent on, and it is the only activity that has
found anything.

Measure one thing: **bugs per gadget built**. If it drops sharply, Beta is justified by evidence
rather than by the calendar. If it does not, that is a more important finding than a milestone label.

A concrete first target, since #151 makes it likely to fail: **one gadget that builds and renders
correctly on the first attempt, with no human intervention.** That has not happened yet — five
attempts, five needing help.

`docs/trying-it-out.md` has the preconditions (a model must be configured *and selected*; the Context
Library must be opted into at `/gatekeepers` and then opened once by an admin before the sample data
exists) and what the seeded data contains.

## The open bug, and why it is harder than it looks

**#151 — the agent builds a web server instead of a client module.** Asked for a scheduler it wrote
a `fetch` handler with embedded HTML, left `client.js` as a stub, and reported "Tested and working
correctly". The App tab runs `client.js` in an iframe and never calls `fetch`, so it renders white.

The instruction it violated is explicit and present in the deployed prompt (`agent.ts:417`):

> *"Note that there is no index.html. Instead, `client.js` must build the entire UI using JavaScript
> code."*

Its own comment says **"intentionally kept minimal"**. That is an instruction *overridden*, not
missed — so a stronger prompt may not fix it, if the model is pattern-matching on "web app → serve
HTML from a handler", which describes most of its training data.

**Recommended fix is platform-side, not prompt-side:** make the wrong shape fail loudly. A
`client.js` that renders nothing should produce *"client.js exports no UI"* rather than a white
pane. That works regardless of why the agent got it wrong, and does not depend on winning an
argument with a prior. Two candidate sites are in the issue.

## The pattern worth knowing before you debug anything here

Five separate findings, one shape: **a legitimate code path that renders identically to a broken
one.**

- a message sent with no model selected simply vanished
- a user-facing dead end produced zero server-side logs (OZL-229)
- a gadget with no UI, and a gadget whose UI failed, both render the same white pane
- an agent reported "Real-time collaboration ✅" for a subscription that could never deliver
- an empty `client.js` is indistinguishable from a broken one

When something here does nothing, the absence of an error is not evidence of health. It is usually
the whole bug.

## Traps that will bite specifically

**`pnpm gate` is not what CI runs.** CI also runs `pnpm build` and `types:check`. This was hit
*one commit after quoting the rule* — `lint:check` exited 0 while CI failed on four implicit-`any`
errors. Run `pnpm lint` (which includes `types:check`) before pushing.

**Grepping the deployed bundle works for code and prompt text, not for comments.** The bundler keeps
ordinary comments but drops leading JSDoc blocks on exported functions, so a check keyed on a doc
comment goes red against a working deployment. Prompt strings survive because they live in a
template literal — which is how it was proved that a live pod was still serving the broken
`gadget.subscribe(new Callback())` example.

**JSDoc placement matters.** An inline `/** @param */` before a method shorthand *on the same line*
does not apply; `tsc` keeps reporting the parameter. It must be on its own line.

**`main` may be checked out in the other worktree.** `git checkout main` fails with "already used by
worktree". Branch from `origin/main` instead.

The deployment-specific traps — Kubernetes injecting `FIELDOS_PORT`, GKE ignoring nginx annotations,
the site gate blocking ACME, `cp` glob semantics differing between BSD and GNU — are in
`handoff-deployment.md` § Traps and have all cost real time.

## The deploy pipeline

`git tag v0.1.0-alpha.11 && git push origin v0.1.0-alpha.11` does everything: gate, build, push,
`helm upgrade`, pod replacement, verify.

It runs on a self-hosted runner **inside the cluster** (`deploy/ci-runner/`), because Master
Authorized Networks makes the API server unreachable from a GitHub-hosted runner. Three separate
defects in that runner were found by *operating* it, never by reviewing it: unreachable cluster,
`CrashLoopBackOff` an hour after install (`--ephemeral` plus a 60-minute token), and a phantom
registration after every rollout (`RUNNER_NAME` from the pod name defeated `--replace`).

If a tag ever queues with no runner: `./deploy/ci-runner/install.sh` re-registers it and asserts the
registration rather than inferring it from a successful rollout.

## Other open items, in rough order of value

| | |
|---|---|
| **#151** | the empty `client.js` bug above — blocks first-try gadget builds |
| **#97** | model configuration is per-user; any signed-in user can name an inference endpoint. On a controlled-egress network that is a data-exfiltration path |
| **#98, #99** | hide unreachable providers on airgapped deployments; discover models from the endpoint instead of typing IDs |
| **#102** | connectors and MCPs open everything in a new tab |
| **OZL-229** | logging has no consumer — `ERROR_REPORTER` unbound, stdout with no retention. Three concrete costs are recorded in `handoff-deployment.md` |
| **OZL-228** | gadget execution in a separate OS process; the largest open item, and the log says it is *cheaper* than the ticket estimates |
| airgap posture | `os.ozlabs.ai` runs `--allow public,private`, so hosted models genuinely work. Fine for a demo, wrong for demonstrating an airgapped product. `FIELDOS_INTERNAL_HOSTS` narrows it per role |
| image size | ~2.4GB. `pnpm --prod` would break it — `workerd` is itself a devDependency. Prune by name if cold-pull time becomes a complaint |

## What is deliberately not done

- **No gadget has been built successfully on the first attempt.** Five tries, five needing help.
- **Nobody has watched a gadget UI update live in a browser.** Subscriptions are proven in the
  workerd parity suite and proven present in production, but those are two claims, not the third.
- **`/admin` → AI model providers has never been exercised.** It needs an admin, and `ADMINS` is
  `["guy"]`.
- **The walkthrough has never been completed by anyone** with a working model *and* the seeded data
  present. That combination only became possible at `alpha.8`.
