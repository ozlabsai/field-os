# Handoff — the first bugs-per-gadget measurement

Written 2026-08-23, immediately after [`handoff-alpha-10.md`](./handoff-alpha-10.md), which asked for
exactly this: *build three or four real gadgets end to end and fix what breaks.*

## The number

**Four gadgets built against the live deployment. Three bugs, two of them platform.**

| | gadget | rendered first try? | bugs |
|---|---|---|---|
| 1 | eight-hour escalation calculator | **yes** | 1 — agent code (#154), `>= 8` for a `> 8` rule |
| 2 | site visit logger | yes | 1 — platform, `allow-forms` |
| 3 | shared tally counter (live updates) | yes | **0** |
| 4 | field engineer checklist | yes | 1 — platform, `allow-forms` (same bug) |
| 5 | visit duration log + CSV export | yes | 1 — CSV export silently does nothing (**undiagnosed**, below) |

Kept split by owner, as the previous session asked: **platform bugs 1 confirmed**
(`allow-forms`, 2 occurrences) **+ 1 undiagnosed** (CSV export), **agent-code bugs 1**.

**The `<form>` choice is not universal, which qualifies the `allow-forms` count.** Gadget 5 wired a
plain click handler instead and its adds worked. So it is 2 of 5 affected, not a certainty — the
agent's structural choice varies per gadget, which is worth knowing before predicting blast radius
from a sample.

**The target from the previous handoff is met: gadget 1 built and rendered correctly on the first
attempt with no human intervention.** That had never happened — five previous attempts, five needing
help. All four rendered, in fact. The failure mode has moved *past* rendering and into interaction.

Caveat on comparability: these were built with Claude Sonnet 4.5 via OpenRouter, and the earlier five
were not necessarily the same model. The count is a real measurement of *this* configuration; treat
the improvement over five-for-five as suggestive rather than as a controlled comparison.

## The one that matters

**`allow-forms` was missing from the iframe sandbox, so any gadget built around a `<form>` could
never submit.** Two of four gadgets were completely unusable. The agent reaches for a `<form>`
whenever there is an input to submit, and nothing in the prompt discourages it.

Same signature as everything else here: the gadget **rendered perfectly and did nothing**. The
logger accepted three visits and kept saying "No visits logged yet"; the checklist accepted three
items and kept saying "No items yet". Both read as *no data*, not as *your input was discarded*.

Fixed in #153. Verified in Chrome with both halves measured: under the old attribute the submit
handler **never fires at all** — the browser blocks the submission before any script runs, so
`preventDefault()` cannot happen. Adding `allow-forms` does not let a form reach the network; the
CSP's `form-action 'none'` and `connect-src 'none'` are the controls doing that work.

## The undiagnosed one: CSV export

Gadget 5 renders, adds work, and **"Export as CSV" produces no download and no console output at
all.** The extracted code is the ordinary shape — `new Blob([csv])` → `URL.createObjectURL` →
`<a download>` → `.click()`.

**Deliberately not filed as an `allow-downloads` bug, because that is not established.** At least
two mechanisms fit and this session could not separate them:

1. the sandbox lacks `allow-downloads`; or
2. the CSP is `default-src 'none'` with **no `blob:` in any directive**, so the object URL may be
   dead regardless of any sandbox flag.

Those imply different fixes. A harness to discriminate them was written and **failed the same way
the earlier one did** — its control row (a form handler that *must* fire, independently measured as
firing) returned `NO REPORT` in both variants, so all four rows were junk. Had the control been
omitted, "download: no report in both" would have read as *confirmation* of the `allow-downloads`
hypothesis: a satisfying, wrong result. Second time in one session that the control was the only
thing standing between a plausible story and a false finding.

So: **an observation without a mechanism.** Next session should test `blob:` reachability under the
current CSP first, since that is the cheaper of the two to rule out.

## Three claims that were previously untested, now measured

**Live subscriptions work in a real browser.** Two independent browser contexts on the same gadget;
clicking `+` three times in A took B from 0 to 3 **without a reload**, clean consoles both sides.
The previous handoff listed this explicitly as never done — it had two claims (proven in the workerd
parity suite, proven present in production) and noted those are not the third. It is now the third.
Note the scope: I observed *B updating without a reload*; that the mechanism is a `dup()`'d callback
stub is inference from the code, not something measured.

**The OZL-313 relabel shipped.** The composer reads "Choose a model", not "No agent".

**#151 did not recur.** All four gadgets wrote both `server.js` and `client.js`. One sample of the
opposite outcome does not retire the bug — the platform fix in #153 is what makes it legible when it
does happen — but it did not reproduce in four attempts.

## Traps hit while driving the product

**The onboarding inputs have no `name` attributes.** Base UI generates opaque ids (`base-ui-_r_6_`)
that change between renders. A selector on `input[name="username"]` matches nothing, silently, and
the script then waits forever. Use `getByPlaceholder`. Same family as every other bug here.

**A product tour overlay intercepts clicks.** `#driver-popover-content` swallows pointer events on
first visit; dismiss it before anything else or every click times out with a confusing "element
intercepts pointer events".

**The model dropdown offers exactly one option on this deployment**: "Other Local /
OpenAI-compatible...". No AI Gateway and no built-in suggested models, so every user must paste an
endpoint by hand. The API URL placeholder is `http://localhost:11434`, which is right for an
airgapped install and a dead end here (see #98/#99).

**`f.content()` on a live iframe returns the executed DOM, not the `srcdoc`.** To recover a gadget's
source, read the `srcdoc` attribute from the *host* side and decode the data URL.

## The UI pass that followed

A separate `/impeccable` review of `workshop-frontend` (#155) found three more defects, all of the
same family and all measured rather than argued:

- **The brand migration was half-finished.** Light mode's primary button was green with an orange
  hover — a **137° hue swap** at the moment of interaction, landing at **4.30:1** against white text,
  under the AA floor. Dark mode had never been migrated off Cloudflare orange at all. Selected text
  was **2.81:1**. The file's own comment claimed the accent was orange while the token beneath it was
  green.
- **The composer had no keyboard focus indicator.** The product's primary input. Its `outline-none`
  was never replaced, and `.prompt-input` — CSS that sets exactly the right border and ring — is
  applied to **no element anywhere**. Someone wrote the fix and never wired it up.
- **Adding an unreachable model reports success.** The API URL field pre-filled
  `http://localhost:11434`, `addModel` never contacts the endpoint, and the result is a green
  "added successfully" toast plus a listed, selectable model that cannot work (#156). It is the
  first thing a new user does.

Two of those were caught only by *rendering* rather than reading: the pale orange
`--color-selection-bg` turned out to double as the composer's focus ring, so focusing the main input
drew a green border inside a pink halo, and nothing in the token name says so.

**Two self-corrections worth repeating**, both caught by a control rather than by noticing something
looked wrong. A first probe reported "no focus rings anywhere" — that was `.click()` setting
`:focus` without `:focus-visible`; the app is correctly keyboard-gated and 14/14 tab stops paint an
indicator. And a review of *this session's own* empty states failed them: they had different words
and identical visual weight, which is a weaker version of the exact bug the pane was built to break.

## What to do next

1. **Build more gadgets.** The rate has not converged — one platform bug appeared twice in four, and
   the sample is four. This is still the only activity finding anything.
2. **Watch for the next interaction-layer bug.** Rendering is no longer where gadgets fail; the two
   platform bugs this session were both *after* a correct render. Anything the sandbox attribute
   withholds is a candidate — the same class as `allow-forms`.

   The flags worth thinking about, as **hypotheses, not measurements** (see the failed attempt
   below): `allow-downloads` is the obvious next one — a gadget offering "export as CSV" via
   `<a download>` is a plausible ask and would fail the same silent way. `allow-modals` is
   *deliberately* withheld and documented in the prompt; leave it. `allow-same-origin` must stay off
   or the opaque-origin isolation the design rests on collapses.

   **A harness for this was attempted and failed, which is worth more than the flags list.** Five
   capability probes were run under three sandbox variants to see which fail silently. Every one of
   the fifteen rows came back **identical across all three variants** — including the form-submit
   row, which is *known* to differ, having been measured cleanly elsewhere. So the harness was not
   exercising the sandbox at all and every row was junk.

   The only reason that was caught: one row had a **predicted** result that could be checked, and
   the prediction failed. Run with a single variant — as the first version was — those same five
   rows read as entirely plausible findings ("downloads fail silently, clipboard is blocked") and
   would have been reported. Whoever builds this next should include at least one probe whose answer
   is already known, and treat a result that never varies with the input as a broken instrument
   rather than a finding.
3. **#154** — the agent asserted a specific threshold for a document it could not read. Worth
   deciding whether "I cannot see that document" should be required.

## Shipped as `v0.1.0-alpha.11`

Deployed 2026-08-23 by the tag pipeline; `os.ozlabs.ai` now runs `alpha.11`. Verified rather than
assumed:

| | |
|---|---|
| pod actually replaced | new UID `0bccf1fd` (was `e7a363b2`), image `0.1.0-alpha.11`, 0 restarts |
| data survived | `keys.json` byte-identical at 1967, all 24 DO directories intact |
| bundle contents | **8/8**, each row baselined to fail against `alpha.10` first |
| composer focus ring, in a browser | `no ring → RING → no ring` |
| `--color-kumo-brand` in the browser | `oklch(44% .075 152)` |

**Two checks were wrong before they were right**, and both are now rules in `AGENTS.md`. A grep for
`oklch(0.44 0.075 152)` returned 0 because the bundler minifies it to `oklch(44% .075 152)` — and
the pre-deploy baseline had shown that row failing, which was read as proof it discriminates when it
was really a check that could never pass. And the browser check reported the focus ring "does not
change on focus" while printing a value that contained the ring, because the composer autofocuses on
load so "before" already had it.

Both were caught the same way as everything else this session: a result that disagreed with a stated
expectation, checked rather than explained.
