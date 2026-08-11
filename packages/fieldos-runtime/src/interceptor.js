// A recording, refusing stand-in for the network, used as every worker's `globalOutbound` when
// scripts/run-workerd.mjs runs with `--interceptor`.
//
// WHY THIS EXISTS. Tier-2 tests boot a real stack and run real gadget code. On a CI runner with
// real egress, a test asserting "nothing escaped" proves nothing unless something is actually
// positioned to catch an escape -- the assertion and a silent success look identical. This service
// is that something: it records every outbound request and answers 403, so a test can read back
// exactly what was attempted.
//
// WHY IT IS STRONGER THAN PATCHING globalThis.fetch. packages/integration-tests'
// network-interceptor.ts patches `globalThis.fetch` inside the Node process, which works only
// because miniflare routes a Worker's outbound fetch back through Node. It also lives *inside* the
// isolate, so worker code could in principle patch around it. A `globalOutbound` service sits
// below the isolate: there is no JS reachable from inside that can bypass it.
//
// It catches dynamically-loaded workers too. Verified by execution: a worker loaded through a
// `workerLoader` binding inherits its parent's `globalOutbound` unless it sets its own, so gadget
// code routes here as well. Production sets `globalOutbound: null` on gadget workers
// (overseer.ts:2356), which still wins -- the two are complementary, not redundant. That is
// precisely the value here: if a change ever dropped `globalOutbound: null`, gadget traffic would
// arrive at this interceptor and be recorded instead of silently reaching the internet.
//
// NOT A SECURITY CONTROL. This is test scaffolding. `--interceptor` makes a deployment unable to
// reach anything, which is useful for a suite and useless for a deployment; nothing about the
// shipped configuration depends on it.

/**
 * Every request this service was handed, most recent last, as `"<METHOD> <url>"`.
 *
 * Module-global on purpose: workerd may reuse the isolate across requests within one run, and a
 * test wants the whole run's history rather than one request's. A test that needs a clean slate
 * boots a fresh stack, which is the same granularity everything else in tier 2 uses.
 *
 * @type {string[]}
 */
const intercepted = [];

/** Path a test reads the record back from. Chosen to be implausible as a real outbound URL. */
const READ_PATH = "/__fieldos_intercepted";

export default {
  /**
   * @param {Request} request
   * @returns {Response}
   */
  fetch(request) {
    const url = new URL(request.url);

    // The readback hatch. Deliberately keyed on path alone: whatever hostname a test uses, the
    // request lands here anyway (that is what being `globalOutbound` means), so there is no
    // meaningful host to match on. Not recorded -- reading the record must not alter it.
    if (url.pathname === READ_PATH) {
      return Response.json(intercepted);
    }

    intercepted.push(`${request.method} ${request.url}`);

    // 403 with a named body rather than a thrown error: a refused *connection* reaches the caller
    // as an opaque `internal error; reference = ...` with no address (see plans/handoff.md), which
    // is exactly the undiagnosable case this repo has been bitten by. An HTTP response says who
    // refused and why, at the call site.
    return new Response("blocked by the FieldOS test interceptor", { status: 403 });
  },
};
