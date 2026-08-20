import { useEffect, useState } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { logRpcFailure } from './rpcErrors'
import { useAuthenticatedApi } from './AuthContext'
import { WALKTHROUGH_SENT_EVENT, WALKTHROUGH_MODEL_EVENT } from './walkthroughBus'

// The guided walkthrough that runs once, after onboarding. Onboarding *configures* the account;
// this walks the user through building one real thing, which is what the app is actually for:
//
//   ask for something  ->  it gets built  ->  find the result  ->  connect your own data
//
// Only the first step waits on the user: it advances when a message is actually sent, not on a
// Next button, so the tour cannot claim progress the user has not made.
//
// PAUSING. Sending navigates to /workspace/$id, which __root.tsx renders fullscreen with no
// sidebar (see `fullscreen` there). This component is mounted inside AppShell, so that navigation
// unmounts it and the effect cleanup tears the tour down -- no popover floats over the editor.
// Returning to any shell route remounts it, and it resumes from the persisted step below.
//
// Steps are declared against `data-tour` attributes; nav rows derive theirs from their route (see
// SidebarItem.tsx). Any step whose target is missing is dropped -- see `presentSteps()`.

// Where the tour got to, so returning from the fullscreen workspace (or reloading) resumes instead
// of restarting. Deliberately client-side: this is per-device UI position, not an account fact --
// the *completion* flag is the account fact and lives on the server. Mirrors how AppShell stores
// its own `gadgets:sidebar-collapsed`.
const PROGRESS_KEY = 'gadgets:walkthrough-step'

function readProgress(): number {
  try {
    const raw = Number(localStorage.getItem(PROGRESS_KEY))
    return Number.isInteger(raw) && raw > 0 ? raw : 0
  } catch {
    return 0
  }
}

function writeProgress(index: number): void {
  try {
    localStorage.setItem(PROGRESS_KEY, String(index))
  } catch {
    // A blocked localStorage costs a restarted tour, not a broken one.
  }
}

function clearProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY)
  } catch {
    // Nothing to do; the completion flag on the server is what stops the tour returning.
  }
}

// One step of the walkthrough. `element` is the `data-tour` value of its anchor; `awaitsSend` marks
// the single step the user has to act on rather than click past.
type WalkthroughStep = {
  element: string
  title: string
  description: string
  awaitsSend?: boolean
  /** Shown only when the deployment has no model at all; advances when one is chosen. */
  awaitsModel?: boolean
}

// The story, in order. Each entry points at something the deployment may or may not render; the
// ones it does not are filtered out at start rather than conditionalised here.
const STEPS: WalkthroughStep[] = [
  {
    element: 'model-picker',
    title: 'Choose a model first',
    description:
      'Nothing here can be built without one. Pick a model from this menu — or, if the list is ' +
      'empty, add one under Providers in the account menu at the bottom of the sidebar. A model ' +
      'your administrator configured for the deployment appears here for everyone automatically.',
    awaitsModel: true,
  },
  {
    element: 'home-composer',
    title: 'Ask for something real',
    description:
      'Describe what you want in plain language — there is no template to pick first. This ' +
      'deployment ships with a "Sample: Field Reports" collection holding a quarterly site-visit ' +
      'log, so "chart the site visits by site and tell me which ones escalate" is a real thing to ' +
      'try. Send it and the tour picks up afterwards.',
    awaitsSend: true,
  },
  {
    element: 'nav-outputs',
    title: 'Your results collect here',
    description:
      'That workspace keeps the conversation, the app, and its data together — and the documents ' +
      'and dashboards it produces land in Outputs, so you can find them later without ' +
      'remembering which workspace made them.',
  },
  {
    element: 'nav-gatekeepers-context',
    title: 'This is what it read',
    description:
      'The sample data lives in the Context Library. Add your own documents here and the agent ' +
      'reads them the same way — as something it can look at, not something it can change.',
  },
  {
    element: 'nav-gatekeepers',
    title: 'Connect your own tools',
    description:
      'Gatekeepers give the agent scoped access to outside services. It only ever reaches what ' +
      'you connect here, and anything that writes waits for your approval.',
  },
]

// Narrow the declared steps to the ones this deployment actually renders. A step pointing at a
// disabled connector or a nav row a fork removed would highlight an empty rectangle in the corner
// of the screen, so absence is resolved against the live DOM -- the same source of truth the rail
// itself uses -- rather than by re-deriving deployment config here. Exported for the test.
export function presentSteps(hasModel = true): DriveStep[] {
  return STEPS
    // The model step exists only to resolve "the agent cannot build anything yet". A deployment
    // that already has a model -- whether the user added one or an administrator configured it
    // for everyone via the gateway, which listModels() returns to all users alike -- must not be
    // told to choose one it already has.
    .filter((step) => !step.awaitsModel || !hasModel)
    .filter((step) => document.querySelector(`[data-tour="${step.element}"]`))
    .map(
    (step) => ({
      element: `[data-tour="${step.element}"]`,
      popover: {
        title: step.title,
        description: step.description,
        // The step the user has to act on offers no way to click past it; the others get ordinary
        // Back/Next. Leaving Next on the composer step would let someone "complete" the tour
        // without ever having asked for anything, which is the whole point of it.
        // The two steps the user has to act on offer no way to click past them; the rest get
        // ordinary Back/Next. A Next on either would let someone "complete" a guided build
        // without a model, or without ever having asked for anything.
        showButtons: step.awaitsSend || step.awaitsModel
          ? (['close'] as const).slice()
          : (['previous', 'next', 'close'] as const).slice(),
      },
    }),
  )
}

// Whether the step at `index` is the one waiting on a send. Leaving before that has happened is
// the case worth confirming, since every step after it describes what that action produced.
function isAwaitingSend(steps: DriveStep[], index: number): boolean {
  const element = steps[index]?.element
  return typeof element === 'string' && element.includes('home-composer')
}

// Whether the step at `index` is the model step. Same shape as isAwaitingSend, and both are
// resolved against the rendered steps rather than the declaration, since the model step is dropped
// entirely on a deployment that already has one.
function isAwaitingModel(steps: DriveStep[], index: number): boolean {
  const element = steps[index]?.element
  return typeof element === 'string' && element.includes('model-picker')
}

// Runs the walkthrough for a user who has not finished it, then records that they have. Renders
// nothing: driver.js owns its overlay, mounted on document.body.
//
// `onDone` lets the shell drop this component once the tour is over, so its listeners and the
// driver instance are not kept alive for the rest of the session.
export default function Walkthrough({ onDone }: { onDone: () => void }) {
  const { authenticatedApi } = useAuthenticatedApi()

  // Whether this deployment can build anything at all: any model the user configured, plus any the
  // administrator configured for everyone (listModels() merges both, so an admin-provided gateway
  // model is visible to every user without them doing anything). null = still asking.
  const [hasModel, setHasModel] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listModels()
      .then((models) => { if (!cancelled) setHasModel(models.length > 0) })
      .catch((err) => {
        logRpcFailure('Failed to check configured models:', err)
        // Assume a model exists, which drops the step. Wrongly showing "choose a model" to someone
        // who has one is worse than omitting it: it sends them to fix something that is not broken.
        if (!cancelled) setHasModel(true)
      })
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    // Wait for the answer rather than starting on an assumption and re-driving: restarting the
    // tour a beat after it appeared reads as a glitch.
    if (hasModel === null) return
    const steps = presentSteps(hasModel)
    // Nothing to point at (a fork with a different rail, or the rail not yet painted). Treat it as
    // done rather than retrying: a tour that highlights nothing is worse than no tour.
    if (steps.length === 0) {
      onDone()
      return
    }

    // Resume where we left off, clamped in case this deployment renders fewer steps than the one
    // the position was written on.
    const start = Math.min(readProgress(), steps.length - 1)

    // Recorded on any finish -- the last step, or an explicit dismissal. Fire-and-forget: failing
    // to persist costs one extra sighting of the tour, which is not worth a toast.
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearProgress()
      authenticatedApi.completeWalkthrough().catch((err) => {
        logRpcFailure('Failed to record walkthrough completion:', err)
      })
      onDone()
    }

    const tour = driver({
      steps,
      showProgress: true,
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      // The rail's rows are 32px tall, and driver.js pads the cutout by 10px on every side by
      // default -- on a row that short it reads as a box floating around the item rather than on
      // it.
      stagePadding: 4,
      stageRadius: 8,
      // The default 400ms transition is what makes a step change look like it is highlighting the
      // rows *between* two targets: the cutout is mid-tween for most of that. Short enough to
      // still connect the two positions, brief enough not to be mistaken for the highlight.
      animate: true,
      duration: 150,
      // Clicking the backdrop is the "I would rather look around" signal. Before the user has
      // asked for anything, every remaining step describes what that action produced, so confirm
      // rather than silently dropping them out; afterwards, just let them go.
      overlayClickBehavior: () => {
        if (isAwaitingSend(steps, tour.getActiveIndex() ?? 0)) {
          const leave = window.confirm(
            'Leave the walkthrough? It is waiting for you to ask for something — that first ' +
              'request is what the rest of it builds on.',
          )
          if (!leave) return
        }
        tour.destroy()
      },
      onDestroyed: () => finish(),
    })

    tour.drive(start)

    // Remember the position on every move, so returning from the fullscreen workspace resumes.
    // driver.js exposes no "step changed" hook on the instance, so watch the same user actions
    // that move it. Cheap, and wrong only in the direction of re-showing a step already seen.
    const remember = () => {
      const index = tour.getActiveIndex()
      if (typeof index === 'number') writeProgress(index)
    }
    document.addEventListener('click', remember, true)
    document.addEventListener('keyup', remember, true)

    // The composer step advances on a real send rather than a button.
    const onSent = () => {
      const next = (tour.getActiveIndex() ?? 0) + 1
      if (next >= steps.length) {
        finish()
        return
      }
      // Recorded before moving: the send navigates to the fullscreen workspace, which unmounts
      // this component almost immediately, and the resume path reads exactly this value.
      writeProgress(next)
      tour.drive(next)
    }
    window.addEventListener(WALKTHROUGH_SENT_EVENT, onSent)

    // The model step advances the same way, on a real choice rather than a button.
    const onModel = () => {
      if (!isAwaitingModel(steps, tour.getActiveIndex() ?? 0)) return
      const next = (tour.getActiveIndex() ?? 0) + 1
      if (next >= steps.length) { finish(); return }
      writeProgress(next)
      tour.drive(next)
    }
    window.addEventListener(WALKTHROUGH_MODEL_EVENT, onModel)

    return () => {
      window.removeEventListener(WALKTHROUGH_MODEL_EVENT, onModel)
      window.removeEventListener(WALKTHROUGH_SENT_EVENT, onSent)
      document.removeEventListener('click', remember, true)
      document.removeEventListener('keyup', remember, true)
      // Unmounting mid-tour (navigating into a workspace, a logout, a hot reload) must not leave
      // driver.js's overlay attached to document.body with no React tree behind it. Setting
      // `finished` first stops onDestroyed reading this teardown as the user finishing -- which
      // would mark the walkthrough complete on the way into the very workspace it asked for.
      finished = true
      if (tour.isActive()) tour.destroy()
    }
  }, [authenticatedApi, onDone, hasModel])

  return null
}
