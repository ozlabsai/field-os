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
