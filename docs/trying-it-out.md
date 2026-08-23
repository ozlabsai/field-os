# Trying it out

Things to actually do in a running FieldOS, and what to expect from each.

Every example below is marked with how much is known about it, because that varies a lot and the
difference matters:

| | |
|---|---|
| **verified** | someone ran this on a real deployment and saw it work |
| **untested** | it should work by design; nobody has run it |
| **broken** | known to fail today, with a link to why |

The distinction is not pedantry — the first real user session found three separate cases where the
system reported success for something that had not happened. Treat "untested" as a hypothesis.

## Before anything works

Three things have to be true, and none of them is automatic. If a deployment feels dead, it is
almost always one of these.

**1. A model must be configured.** Settings → AI models. Paste the **base URL** of your
OpenAI-compatible server, not the full endpoint — though the normalizer now handles
`.../v1/chat/completions` if you paste it from a vendor's docs.

**2. A model must be *selected* in the composer.** The control at the bottom of the chat must name
a model. If it reads **"No agent"**, nothing you send will be answered and you will get no error —
open it and pick one.

That control is being relabelled to **"Choose a model"**, with the opt-out reading **"No agent
(don't answer)"**, because "No agent" beside a list of model names does not read as a choice
(OZL-313, [#133](https://github.com/ozlabsai/field-os/pull/133) — **not yet released**, so a current
deployment still shows the old wording).

**3. For anything involving the sample data, turn on the Context Library.** It is an optional
connector: go to `/gatekeepers` and enable **Context Library**, or as a deployment admin set it to
**enabled** in `/admin` → Gatekeepers so every user gets it. It will not appear in the sidebar until
then — that is correct behaviour, not a fault (`DEFAULT_AMBIENT_GATEKEEPER_MODE` is `"optional"`).

**Then open the Context Library once as an admin.** The sample collection installs at that moment,
not at deploy — `installSeedCollections` runs inside `startAppUi`, gated on `isAdmin`. Until an
admin opens the page, the collection does not exist.

## What the sample data actually contains

Knowing this is the difference between a question the agent can answer and one it cannot. The
**"Sample: Field Reports"** collection holds two documents about a fictional field-service team:

**`site-visits.md`** — a Q3 log of **10 visits** across **4 sites** (Harbour Point, Kestrel Ridge,
Blackwater, Fenwick Yard) and **3 engineers** (R. Okonkwo, M. Lindqvist, P. Nayar), each with a
date, duration in hours, and an outcome of *Resolved*, *Escalated* or *Pending parts*.

**`handbook.md`** — the rules behind those outcomes:

- a visit running longer than **eight hours is escalated automatically**, whatever the diagnosis
- a site visited **three or more times in a quarter** is flagged for a standing fix

That second document is what makes the data interesting. Questions that need *both* files — the
numbers and the rule that explains them — exercise the agent properly, where a question about the
table alone only tests summarisation.

## Ask the agent something

These need a model and the Context Library. No gadget building involved.

**verified** — the walkthrough's own suggestion, and the one to start with:

> chart the site visits by site and tell me which ones escalate

**untested** — questions that require reading the handbook *and* the log together, which is where
the seed data earns its keep:

> Which visits were escalated for a reason other than running over eight hours?

> Per the handbook's reporting rule, which sites should be flagged for a standing fix this quarter?

> Is any engineer's average visit longer than the others', and does that explain their escalations?

The first of those has a real answer in the data and is a good test of whether the agent is reading
the rule or pattern-matching on the word "escalated".

## Build a gadget

This is the part with the most unknowns, and the honest summary is: **the agent reliably generates
substantial code, and whether that code renders is the open question.** No gadget has yet been built
successfully on the first attempt — five tries, five needing help.

**verified to generate** — an agent run completes and produces substantial code:

> build a website for scheduling shifts

Four agent runs, all successful, ~39KB of code. Whether the result *renders* was not established in
the same session, because it hit the subscription bug below.

**the failure to expect** — the agent may build the UI as HTML served from a `fetch()` handler in
`server.js` and leave `client.js` a stub, then report success
([#151](https://github.com/ozlabsai/field-os/issues/151)). Nothing calls that handler, so the App
tab renders blank. If you see a blank pane, open `client.js` first and check it actually builds DOM.

**fixed in `alpha.10`** — subscriptions work. What was broken was never `dup()` itself but the
*shape of the callback* the agent was being taught to pass
([#134](https://github.com/ozlabsai/field-os/issues/134),
[#145](https://github.com/ozlabsai/field-os/pull/145)). A **bare function** crosses the gadget's
isolate boundary as a live RPC stub with a working `dup()`; an **object** — including a
`class Callback extends RpcTarget` with an `update()` method — is structurally cloned instead and
arrives with its methods gone, so `dup()` throws and the subscription silently never delivers. The
prompt now says so explicitly.

Note what the old symptom looked like, because it is the pattern to expect here: the agent hit the
throw, "fixed" it with a fallback that swallowed the error, and **reported the feature as working**.
A green tick next to something that cannot function is the failure mode to watch for.

**untested** — nobody has yet watched a gadget UI update live in a browser. The mechanism is proven
in the workerd parity suite and proven present in production; that is two claims, not the third.

**untested** — smaller, self-contained gadgets:

> a form that records a site visit and shows the running total per site

> a calculator that applies the handbook's eight-hour escalation rule to a duration I type in

## Poke at the admin panel

Requires being in `ADMINS`.

**untested** — `/admin` → **AI model providers**. Turning a provider off should remove it from every
user's model picker. Server-side enforcement in `addModel` is what actually governs, so a UI defect
here is cosmetic rather than a security problem.

**untested** — `/admin` → **Gatekeepers**. Each auto-provisioning connector has three modes:
*disabled*, *optional* (the default), *enabled*. Setting Context Library to **enabled** gives it to
every user without them opting in.

## When something does nothing

In roughly the order worth checking:

1. **Does the composer say "Choose a model" or "No agent"?** The second means nothing will answer.
2. **Is the Context Library actually on?** No connector, no sample data, and questions about field
   visits have nothing to read.
3. **What is in the browser console?** Gadget errors are forwarded out of the sandbox with a stack.
   A *clean* console is informative too — it means nothing threw, so nothing ran.
4. **Ask the agent.** "The preview is blank — what went wrong?" It can see its own code and the
   captured runtime logs. Note that it may confidently misdiagnose: in #134 it blamed a Cap'n Web
   API for being unavailable when the API was correct and the platform was at fault.
5. **Check the server log** — `kubectl logs -n fieldos fieldos-0` on a Kubernetes deployment. Be
   aware that most paths log nothing at all (OZL-229), so silence there is not evidence of health.

## A note on what "it worked" means here

Three findings in the first real user session had the same shape: a legitimate code path that looks
exactly like a broken one, or a broken one that looks exactly like success.

- a message sent with no model selected simply vanished
- a user-facing dead end produced zero server-side logs
- an agent reported "Real-time collaboration ✅" for a subscription that could never deliver

So when trying the system out, **check the thing itself rather than the report of it.** Open the
gadget, read the answer, look for the data you expected. That is not distrust of the software; it is
the only way to tell these cases apart today.
