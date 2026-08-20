// Lets the Home composer tell the walkthrough that a real message was sent, without the tour
// having to reach into the page or the page having to know a tour exists. Same decoupling as
// commandPaletteBus, for the same reason: the two live on opposite sides of the route tree.
export const WALKTHROUGH_SENT_EVENT = 'gadgets:walkthrough-sent'

// Fired by the Home page after a send succeeds. The walkthrough's composer step advances on this
// rather than on a Next button, so the tour only moves once the user has actually asked for
// something -- which is the one step of the story they have to perform themselves.
export function notifyWalkthroughSent(): void {
  window.dispatchEvent(new CustomEvent(WALKTHROUGH_SENT_EVENT))
}

// Fired when the user picks or adds a model from the Home composer. The walkthrough's first step
// -- shown only to a deployment with no model configured at all -- advances on this, for the same
// reason the composer step waits on a real send: the step exists because the agent cannot build
// anything yet, so it should not be clickable past.
export const WALKTHROUGH_MODEL_EVENT = 'gadgets:walkthrough-model'

export function notifyWalkthroughModel(): void {
  window.dispatchEvent(new CustomEvent(WALKTHROUGH_MODEL_EVENT))
}
