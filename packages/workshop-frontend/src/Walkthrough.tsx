import { useEffect } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { logRpcFailure } from './rpcErrors'
import { useAuthenticatedApi } from './AuthContext'

// The guided walkthrough that runs once, immediately after onboarding. Onboarding *configures* the
// account (name, model, connections); this *orients* the user in an app that is already configured,
// by walking the persistent left rail one region at a time.
//
// Every target is a sidebar nav row, so all five exist in the DOM simultaneously and the tour never
// navigates. That is what makes it a plain driver.js tour with Next buttons rather than something
// that has to survive a route change: there is no user action to wait for between steps.
//
// Steps are declared against `data-tour` attributes, which SidebarItem derives from each row's
// resolved route (see SidebarItem.tsx). Any step whose target is missing is dropped before the tour
// starts -- see `presentSteps()`.

// One step of the walkthrough. `element` is the `data-tour` value of the row it points at.
type WalkthroughStep = {
  element: string
  title: string
  description: string
}

// The tour, in order. Each entry points at a nav row the deployment may or may not have; the ones
// it does not have are filtered out at start rather than conditionalised here.
const STEPS: WalkthroughStep[] = [
  {
    element: 'nav-home',
    title: 'Start here',
    description:
      'Home is the launcher. Describe what you want in plain language and the agent builds it — ' +
      'no template to pick first.',
  },
  {
    element: 'nav-workspaces',
    title: 'Your work lives here',
    description:
      'Each thing you build gets a workspace: the conversation, the app, and its data together. ' +
      'Come back to one and the agent still has the context.',
  },
  {
    element: 'nav-blueprints',
    title: 'Reusable starting points',
    description:
      'A blueprint is a workspace someone already shaped. Start from one when you want the shape ' +
      'without describing it again.',
  },
  {
    element: 'nav-outputs',
    title: 'Finished results collect here',
    description:
      'Documents, dashboards and reports your workspaces produce land in Outputs, so you can find ' +
      'them without remembering which workspace made them.',
  },
  {
    element: 'nav-gatekeepers',
    title: 'Connect your tools and data',
    description:
      'Gatekeepers give the agent scoped access to outside services. It only ever reaches what you ' +
      'connect here, and writes wait for your approval.',
  },
]

// Narrow the declared steps to the ones this deployment actually renders. A step pointing at a
// disabled connector or a nav row a fork removed would highlight an empty rectangle in the corner
// of the screen, so absence is resolved against the live DOM -- the same source of truth the rail
// itself uses -- rather than by re-deriving deployment config here. Exported for the test.
export function presentSteps(): DriveStep[] {
  return STEPS.filter((step) => document.querySelector(`[data-tour="${step.element}"]`)).map(
    (step) => ({
      element: `[data-tour="${step.element}"]`,
      popover: { title: step.title, description: step.description },
    }),
  )
}

// Runs the walkthrough once for a user who has not seen it, then records that they have. Renders
// nothing: driver.js owns its own overlay, mounted on document.body.
//
// `onDone` lets the shell drop this component once the tour is over, so its listeners and the
// driver instance are not kept alive for the rest of the session.
export default function Walkthrough({ onDone }: { onDone: () => void }) {
  const { authenticatedApi } = useAuthenticatedApi()

  useEffect(() => {
    const steps = presentSteps()
    // Nothing to point at (a fork with a different rail, or the rail not yet painted). Treat it as
    // done rather than retrying: a tour that highlights nothing is worse than no tour.
    if (steps.length === 0) {
      onDone()
      return
    }

    // Marking completion is deliberately fire-and-forget and happens on *any* exit -- finishing the
    // last step, the close button, Escape, or clicking the overlay. A user who dismissed a tour has
    // answered the question; showing it again on next login would be nagging. Failure to persist is
    // logged, not surfaced: the cost is seeing the tour once more, which is not worth a toast.
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      authenticatedApi.completeWalkthrough().catch((err) => {
        logRpcFailure('Failed to record walkthrough completion:', err)
      })
      onDone()
    }

    const tour = driver({
      showProgress: true,
      steps,
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      // Fires on close/Escape/overlay-click and after the final step's Done.
      onDestroyed: finish,
    })
    tour.drive()

    return () => {
      // Unmounting mid-tour (a logout, or a hot reload in dev) must not leave driver.js's overlay
      // attached to document.body with no React tree behind it.
      if (tour.isActive()) tour.destroy()
    }
  }, [authenticatedApi, onDone])

  return null
}
