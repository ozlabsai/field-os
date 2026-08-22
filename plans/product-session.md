# Twenty minutes in the product — a script for Guy

The largest gap in FieldOS is not infrastructure. Signup and the RPC transport are browser-verified;
**building a gadget, the guided walkthrough, and a real workspace are not.** Nobody has used it.

This is ordered so each step sets up the next. Step 1 is load-bearing: skip it and the walkthrough
advertises data that does not exist yet.

**You are the only admin** (`ADMINS` is `["guy"]`), so steps marked **[admin]** cannot be done by
anyone else, including me.

Site: **https://os.ozlabs.ai** — gate `ozos` / `Fosi90-i90-` (HTTP Basic, before the app loads).

Keep this page open and note anything that surprises you. "Surprised me" is the signal — not just
breakage. Roughness that a first-time user would hit is exactly what has never been observed.

---

## 0. Before you start — is the deployment current?

I redeploy before you begin. Confirm you are on new code:

```sh
kubectl get pod fieldos-0 -n fieldos -o jsonpath='{.spec.containers[0].image}{"\n"}'
```

Anything at or after `0.1.0-alpha.7` is current. `alpha.5` means the redeploy did not land and
**the walkthrough you would test is the superseded one** — stop and tell me.

---

## 1. [admin] Open the Context Library — do this FIRST

Left sidebar → **Context Library**.

**Expect:** a collection named **"Sample: Field Reports"**, holding a quarterly site-visit log.

**Why first:** the seed data installs *only when an admin opens this page* — `installSeedCollections`
runs inside `startAppUi`, gated on `isAdmin` (`library-gatekeeper.ts:165`, confirmed in source). It
is not installed at deploy. Until you do this, the collection does not exist, and the walkthrough
recommends a prompt about data the agent cannot read.

**If nothing appears: STOP and tell me.** That is a genuine finding — it means the seeding path does
not work off-platform, and everything downstream would be testing against an empty library.

- [ ] "Sample: Field Reports" is present
- [ ] Opening it shows actual site-visit content, not an empty shell

---

## 2. [admin] The admin panel — the AI model providers toggle

Go to **/admin** → **AI model providers**.

Shipped in #123 and confirmed present in the running container, but **the toggle has never been
clicked.** Server-side enforcement is what actually governs, so the risk here is a UI defect, not a
security hole.

- [ ] The section renders and lists providers
- [ ] Toggling one off, then reloading — does the choice persist?
- [ ] Does a disabled provider actually disappear from the model picker in step 3?

That last one is the real test: it crosses from the admin panel to the user surface.

---

## 3. Configure a model

You need a working model before the walkthrough means anything.

**Note:** `os.ozlabs.ai` runs `--allow public,private`, so hosted providers genuinely work here.
(Deliberate for a demo, and *not* representative of the airgapped product — a separate open
question.)

⚠️ **The trap that cost a day before:** paste the **base URL**, not the full endpoint. The field says
"Base URL of your OpenAI-compatible server" and people paste `.../v1/chat/completions` from the
vendor's own docs anyway. There is now a normalizer, so **if you paste the full endpoint and it
works, that is a pass** — please try it that way deliberately.

- [ ] A model is configured and saved
- [ ] Pasting a full `/chat/completions` URL is handled gracefully

---

## 4. The guided walkthrough — the highest-value item

This is what the peer session most wants observed. Three specific questions:

**a) Does the suggested prompt actually produce something?**
The tour is built around one request working. Try its suggestion:

> *chart the site visits by site and tell me which ones escalate*

Needs step 1 (the data) and step 3 (the model). **Does the agent read the collection and produce a
real chart?**

**b) Is the model step correct for someone who already has a model?**
#119 added a "choose a model first" step. With a model already configured **it should be absent
entirely.** If you see it anyway, that is a bug in the conditional — the peer flagged it as the one
thing they could not check themselves, having written the copy knowing what the data contains.

**c) Does the tour survive the workspace round trip?**
It pauses when you enter a workspace (fullscreen, no sidebar) and should **resume at "Your results
collect here"** when you come back — not restart from the beginning. Flagged as reasoned, not
observed.

- [ ] The suggested prompt produced a real result
- [ ] Model step absent when a model is configured
- [ ] Tour resumes rather than restarts after a workspace visit
- [ ] The copy reads sensibly to someone not in the authoring conversation

---

## 5. Build one real gadget, start to finish

The single biggest unverified thing. Not a toy — something you would plausibly keep.

Suggestion, since it exercises persistence, the agent loop, and the UI together: **a gadget that
tracks site visits and flags the ones that escalate**, built on the seeded collection.

Watch for:
- [ ] The agent writes code that actually runs
- [ ] Errors are legible — can you tell what went wrong and ask for a fix?
- [ ] Iterating works: "change X" produces a changed gadget, not a rewritten one
- [ ] State survives a page reload
- [ ] It still works when you come back to it

**Known and not worth reporting:** PDF export is unavailable off-platform (no `BROWSER` binding) and
should degrade cleanly. If it degrades *badly*, that IS worth reporting.

---

## 6. Optional, if you have patience

- [ ] **#126:** leave a tab idle past 60 minutes, then click something. Expect a **redirect to the
      login page**, not console errors. Low priority — it costs an hour of waiting and the fix is
      unit-tested both ways.

---

## Known noise — do not report these

| | |
|---|---|
| A `useAuthenticatedApi` console error during signup | OZL-312, closed low priority, cosmetic, app recovers |
| Gadget PDF export unavailable | no `BROWSER` binding off-platform; should degrade cleanly |
| Blueprints fetchable unauthenticated by id | OZL-223, known |

---

## What I need back

Rough notes are fine — bullet points beat prose. Most useful:

1. **Anything that stopped you.** Where did you get stuck, confused, or have to guess?
2. **Step 1 and step 4a specifically** — the seed install and the suggested prompt. If either
   failed, everything downstream was testing against a broken premise.
3. **Where the product felt good.** Genuinely useful to know what not to change.

I fix infrastructure findings; the peer session takes product ones. Tell me either way.
