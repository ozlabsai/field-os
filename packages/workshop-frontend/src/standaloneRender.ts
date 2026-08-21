/**
 * Whether to render without the app shell: a bare page for a signed-out visitor to a public route.
 *
 * Lives outside `routes/__root.tsx` so it can be tested without dragging in the generated route
 * tree, which needs a router to instantiate. The bug this exists to prevent (OZL-312) was a
 * *missing* condition, and a missing condition is what a test of the assembled component is least
 * likely to notice.
 *
 * Both public routes need the `!isAuthenticated` guard. `isSignup` used to lack it: signup writes
 * the token to localStorage and *then* assigns `window.location.href` (SignupPage.tsx:68-69), so
 * between those two `isAuthenticated` flips on the still-live /signup document while `pathname` is
 * still "/signup". A standalone render there puts the routed component outside AuthProvider, and
 * the router — already resolving toward "/" — mounted the index route into it, which throws.
 */
export function isStandaloneRender(pathname: string, isAuthenticated: boolean): boolean {
  const isSignup = pathname === '/signup'
  const isBlueprint = pathname.startsWith('/blueprint/')
  return (isSignup || isBlueprint) && !isAuthenticated
}
