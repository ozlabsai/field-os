# DESIGN.md

Visual system for FieldOS. Written 2026-08-23 via `/impeccable teach`, by reading
`packages/workshop-frontend/src/styles.css` rather than by proposing something new.

Strategic context lives in [PRODUCT.md](./PRODUCT.md). Read that first: it is what makes the
choices here non-arbitrary.

## The system this actually is

FieldOS renders through **Kumo** (`@cloudflare/kumo` v2.9) with **Tailwind 4**, and overrides Kumo's
semantic tokens in `styles.css`. Design work happens by changing those token values, not by adding
component-local colors. Two themes ship and **both are real** — dark is selected by
`[data-mode="dark"]`, not by `prefers-color-scheme`.

**The two themes are built on different systems, and that is the single most important fact here.**
Dark mode is coherent OKLCH with every neutral tinted toward hue 285 and a comment explaining the
intent. Light mode is hand-written hex with a warm undertone. They were authored at different times
by different hands, and light mode is the one carrying unfinished migration.

## Color

**Strategy: Restrained.** Tinted neutrals carry the surface; one accent appears only for intent —
active item, link, primary action, focus ring. `styles.css` states this explicitly and it is the
right call for a tool people sit in all day.

### Brand

FieldOS green, hue 152. Chosen rather than inherited: neither of the two values found in the file
was a decision (see Known defects). Every value below is verified for white-on-button contrast.

| token | light | dark | white text |
|---|---|---|---|
| `--color-kumo-brand` | `oklch(0.44 0.075 152)` `#2f5e3e` | `oklch(0.52 0.085 152)` `#407750` | 7.52:1 / 5.29:1 |
| `--color-kumo-brand-hover` | `oklch(0.385 0.078 152)` `#1d4f2e` | `oklch(0.465 0.082 152)` `#326642` | 9.50:1 / 6.74:1 |
| `--text-color-kumo-brand` | `#2f5e3e` | `oklch(0.78 0.105 152)` `#82cb96` | 7.33:1 / 10.59:1 on own surface |

**Hover darkens; it never changes hue.** Zero-degree shift in both themes. A hover that changes hue
reads as a different button, not the same button reacting.

### Neutrals

Never `#000` or `#fff` for a surface. Dark mode tints toward hue 285; light mode toward warm grey.
Status colors (`info` / `warning` / `danger` / `success`) are already OKLCH in both themes and are
correct as they stand — leave them alone.

## Typography

`FT Kunst Grotesk` (sans) and `Apercu Mono Pro` (mono), both self-hosted. **Self-hosting is a
requirement, not a preference:** the deployment is airgapped, so a webfont CDN would silently fall
back to system fonts on exactly the installs that matter most.

The scale restores Tailwind's defaults over Kumo's 12/13/14/16px steps. Body copy stays within
65–75ch.

## Layout

Three-pane working surface: sidebar, chat, artifact. **The artifact is the subject and the chat is
the tool** — screen weight should keep saying so, because it is also what distinguishes FieldOS from
the centered-chat-column look of every LLM wrapper.

## Motion

Ease out; no bounce, no elastic. Do not animate layout properties. Existing transitions sit at
120–180ms, which is the right range for a tool.

## Known defects (found while writing this, all measured)

1. **The light-mode primary button changes hue on hover.** `--color-kumo-brand` was `#2d6a4f`
   (green, hue 153°) and `--color-kumo-brand-hover` was `#e03f00` (orange, hue 17°): a **137° swap**
   at the moment of interaction. Dark mode shifts 1°, which is what correct looks like. Live on the
   onboarding "Let's build" CTA, `SettingsPage`, `BlueprintLandingPage` and `__root`.
2. **That same hover fails contrast.** `#e03f00` with white text is **4.30:1**, under the 4.5:1 AA
   floor — so the button became both wrong-hued *and* non-compliant precisely when touched.
3. **Light mode was half-migrated.** Its own comment reads *"the brand **orange** is reserved for
   intent only"* while the token directly beneath it is green, and dark mode was never converted at
   all (`#b84e00`, `#ff8a5c` are still Cloudflare orange). The comment, the hover, and the dark
   theme all still describe the pre-fork design.

These are recorded as *defects* rather than preferences because two of the three are measurable
against a standard, and the third is an internal contradiction in the file.

## Where the brand tokens live (all of them)

**Four places, not one.** Each package that builds its own bundle ships its own copy, and a change
to one does not reach the others:

| file | surface |
|---|---|
| `packages/workshop-frontend/src/styles.css` | the Workshop itself |
| `packages/gatekeeper-context/app/styles.css` | Context Library management UI |
| `packages/gatekeeper-scheduler/app/styles.css` | Scheduled Tasks UI |
| `packages/mcp-shared/src/html.ts` | MCP OAuth consent pages (`--brand`, `--contrast`) |

The last one matters beyond looks: `--contrast` is the primary button background on a consent
screen, so an inherited Cloudflare orange there misrepresents who is asking for access.

Before claiming a color is gone, run
`grep -rl "color-kumo-brand" packages --include='*.css' --include='*.ts' | grep -v dist`. A sweep of
the first file alone reported the migration complete while three surfaces were still fully orange.

## Blueprint previews never resolve on this fork

`blueprintScreenshotUrl()` returns `undefined` unless `metadata.screenshot` is set, and that is only
set when a screenshot was captured — which needs the `BROWSER` binding. Standalone `workerd` has no
Browser Rendering, so **no FieldOS deployment will ever have blueprint screenshots.** The placeholder
is not a transient state; it is the permanent one.

That rules out anything skeleton-shaped. A mock document that never resolves reads as perpetual
loading, and drawing fake content makes unrelated blueprints look identical. The placeholder shows
initials derived from the blueprint's own title over its id-derived gradient: real data, distinct per
card, claiming nothing that was not captured. Use the **trailing** word — first-letters collides on
the shipped set (`Workspace Slides` / `Workspace Sheets` both give `WS`).

## How the contrast numbers here were derived

Stated so they can be re-derived rather than trusted. A ratio without its inputs is the same defect
as a count without its scope.

- **Formula:** WCAG 2.x relative luminance — sRGB channels linearised (`c/12.92` below 0.04045, else
  `((c+0.055)/1.055)^2.4`), weighted `0.2126 R + 0.7152 G + 0.0722 B`, then
  `(L_lighter + 0.05) / (L_darker + 0.05)`. OKLCH values were converted to sRGB first.
- **Which pair, for each claim:**
  - *Button figures* — `#ffffff` text against `--color-kumo-brand` / `--color-kumo-brand-hover`, per
    theme. That is the real pairing: every primary CTA in the codebase sets `text-white`.
  - *Selected text* — `--color-selection-text` against `--color-selection-bg`.
  - *Warning icon in the gadget empty state* — `--text-color-kumo-warning` against
    `--color-kumo-warning-tint`, judged against the **3:1** non-text bar rather than 4.5:1, because
    it is an icon.
- **Thresholds:** 4.5:1 for text (AA normal), 3:1 for non-text/icons. Large-text 3:1 was not claimed
  anywhere here.
- **What was not measured:** neutral body text on neutral surfaces, and the status colors
  (`info` / `danger` / `success`). Both were inherited unchanged and are outside the scope of the
  brand migration — absence of a number here is not a pass.
