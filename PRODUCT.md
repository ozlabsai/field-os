# PRODUCT.md

Strategic design context for FieldOS. Written 2026-08-23 via `/impeccable teach`.

## Register

**product** — design serves the work. The bulk of the surface is workspace, chat, gadget panes,
settings and admin: tools people return to, not a campaign they see once. Signup and the blueprint
landing page are entry points *into* a product, and inherit the product language rather than
setting their own.

## Users

Deliberately, uncomfortably broad — and this is the product thesis rather than an unresolved
question. Upstream states it plainly: *"a large portion of Cloudflare's workforce, from engineering
to sales and everything in between"*, and the security framing exists so *"non-technical users can
safely go nuts and nothing bad will happen."*

So the same screen serves:

- someone in sales who has never written code, describing a tool in plain language;
- an operator who wants a small thing built and used once;
- an engineer reading the generated diff and rewiring a gadget's bindings.

**The design consequence is specific:** neither "simplify for beginners" nor "dense tool for
experts" is available. Both would break half the audience. The resolution the product already
reaches for is *progressive disclosure by surface* — the App tab is for anyone, the Code tab is for
people who want it, and neither is hidden behind the other. Design work should strengthen that
split rather than average the two audiences into one bland middle.

FieldOS adds a constraint upstream does not have: it runs **airgapped, on customer infrastructure,
with no internet access and models served locally.** Sessions happen in offices and in operational
settings; light and dark are both real, not a preference toggle. That also means every asset must be
self-hosted, so any typographic or visual choice that depends on a CDN is off the table.

## Product purpose

Ask an agent for a small personal application ("a gadget"), get working code, run it safely in a
sandbox, and share it. The security framework is what makes the casual use safe.

## Brand personality

**A serious instrument, not a toy.** Calm, precise, and trustworthy for real operational work. The
interface should feel like something that will still be running next quarter.

Three anti-references, all confirmed by the product owner:

1. **Not a playful consumer SaaS.** No mascots, no confetti, no celebratory empty states. People are
   doing work.
2. **Not another AI chat product.** Avoid the LLM-wrapper look: a centered chat column as the whole
   application, sparkle iconography, purple/violet gradients, "AI magic" framing. FieldOS's chat is
   *one pane beside a working artifact*, and the layout should keep saying so.
3. **Not a generic Cloudflare dashboard.** It is a fork built on Kumo and should stay compatible
   with it, but it should read as FieldOS. Inherited Cloudflare visual defaults are not decisions.

## Strategic design principles

1. **Silence is the enemy.** This codebase's signature bug is a legitimate path that renders
   identically to a broken one: a blank pane, a dead subscription, a form that swallows input, a
   message sent with no model selected. Every empty state must distinguish *nothing yet* from
   *something is wrong*, and say which. Design here is a correctness concern, not decoration.
2. **The artifact is the subject; the chat is the tool.** Screen weight should follow that.
3. **Two audiences, one screen, no averaging.** Keep the plain-language path and the code path both
   first-class and visibly separate.
4. **Inherited defaults are not decisions.** Where Kumo or upstream left a value, treat it as
   unexamined until someone examines it.

## Accessibility

Non-negotiable: visible focus rings on every interactive element, contrast that holds in both
themes, and no meaning carried by color alone (status must also carry text or shape). Both themes
ship, so both must pass — a fix that only holds in light mode is not a fix.
