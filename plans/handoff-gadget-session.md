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

Two distinct defects, one of them hit twice. Kept split by owner, as the previous session asked:
**platform bugs 1** (`allow-forms`, 2 occurrences), **agent-code bugs 1**.

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

## What to do next

1. **Build more gadgets.** The rate has not converged — one platform bug appeared twice in four, and
   the sample is four. This is still the only activity finding anything.
2. **Watch for the next interaction-layer bug.** Rendering is no longer where gadgets fail; the two
   platform bugs this session were both *after* a correct render. Anything the sandbox attribute
   withholds is a candidate — the same class as `allow-forms`.
3. **#154** — the agent asserted a specific threshold for a document it could not read. Worth
   deciding whether "I cannot see that document" should be required.
