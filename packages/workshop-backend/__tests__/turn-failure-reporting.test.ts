import { describe, expect, it } from "vitest";

import { AgentTurnError, shouldReportTurnFailure } from "../src/ai-invoke";

// A connection failure carries no status, because there was no HTTP exchange to take one from.
// These are the messages the runtime and the OpenAI SDK actually produce -- see the matching
// suite in backend-utils, which pins them against the runtime they came from.
const SDK_CONNECTION_ERROR = new AgentTurnError("Connection error.");
const RUNTIME_REFUSED = new AgentTurnError("internal error; reference = ks64dkbmgt5s00edfgan62rh");

describe("shouldReportTurnFailure", () => {
  // The bug this guards: an unreachable inference endpoint retries indefinitely, and reporting
  // each attempt turns one operator mistake into unbounded incident traffic.
  it("does not report a request that never reached a provider", () => {
    expect(shouldReportTurnFailure(SDK_CONNECTION_ERROR, undefined)).toBe(false);
    expect(shouldReportTurnFailure(RUNTIME_REFUSED, undefined)).toBe(false);
  });

  // The distinction that makes the above safe: an undefined status still reports when the failure
  // is not a connection failure, so unclassifiable errors are not swallowed with it.
  it("still reports an unclassifiable failure with no status", () => {
    expect(shouldReportTurnFailure(new AgentTurnError("something unexpected"), undefined))
      .toBe(true);
  });

  it("keeps the existing 4xx/5xx triage", () => {
    for (const status of [400, 401, 429]) {
      expect(shouldReportTurnFailure(new AgentTurnError(`${status} nope`, status), status))
        .toBe(false);
    }
    for (const status of [500, 503]) {
      expect(shouldReportTurnFailure(new AgentTurnError(`${status} nope`, status), status))
        .toBe(true);
    }
  });

  // A provider that answers with a status is reporting a real failure even if its body happens to
  // read like a connection problem, so the status wins over the message.
  it("reports a 5xx whose body mentions a connection", () => {
    expect(shouldReportTurnFailure(new AgentTurnError("503 upstream connect error", 503), 503))
      .toBe(true);
  });
});
