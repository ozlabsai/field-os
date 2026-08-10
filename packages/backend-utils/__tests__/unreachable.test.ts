import { describe, expect, it } from "vitest";

import { classifyUnreachable, describeUnreachable } from "../src/unreachable.js";

// These messages are what the runtime and the OpenAI SDK actually produce -- captured by running a
// worker under the pinned workerd and printing what reached the catch block. They are matched on
// text because the thrown values carry nothing else, so this suite is the canary: if a workerd or
// SDK bump changes the wording, these fail rather than the feature silently reverting to opaque
// errors that nobody notices until an operator is stuck.
const REFUSED_LOCALLY = new Error("internal error; reference = ks64dkbmgt5s00edfgan62rh");
const REFUSED_BY_PEER = Object.assign(new Error("Network connection lost."), { retryable: true });
const SDK_CONNECTION_ERROR = new Error("Connection error.");

describe("classifyUnreachable", () => {
  it("recognises a request refused before it left the process", () => {
    // A network-policy refusal and a DNS failure both land here, byte-identical.
    expect(classifyUnreachable(REFUSED_LOCALLY)).toBe("refused-locally");
  });

  it("recognises a request the peer refused", () => {
    expect(classifyUnreachable(REFUSED_BY_PEER)).toBe("refused-by-peer");
    expect(classifyUnreachable(SDK_CONNECTION_ERROR)).toBe("refused-by-peer");
  });

  it("passes through anything that is not a connection failure", () => {
    expect(classifyUnreachable(new Error("MCP server returned a non-JSON response."))).toBe(null);
    expect(classifyUnreachable(new Error("404 Not Found"))).toBe(null);
    expect(classifyUnreachable("not an error")).toBe(null);
    expect(classifyUnreachable(undefined)).toBe(null);
  });
});

describe("describeUnreachable", () => {
  it("names the target the runtime dropped", () => {
    const message = describeUnreachable(REFUSED_LOCALLY, "vllm.internal:8000");
    expect(message).toContain("vllm.internal:8000");
  });

  // The two cases must send an operator to different places: one to their configuration, the
  // other to the service itself.
  it("offers the network policy only when the request never left", () => {
    expect(describeUnreachable(REFUSED_LOCALLY, "h")).toContain("network policy");
    expect(describeUnreachable(REFUSED_BY_PEER, "h")).not.toContain("network policy");
  });

  it("does not claim a cause it cannot know", () => {
    // A policy refusal and a DNS failure are indistinguishable, so the message must name both
    // rather than assert either.
    const message = describeUnreachable(REFUSED_LOCALLY, "h")!;
    expect(message).toContain("resolved");
    expect(message).toContain("network policy");
  });

  it("returns null for unrelated errors, so callers leave them alone", () => {
    expect(describeUnreachable(new Error("MCP server answered a different request."), "h"))
      .toBe(null);
  });
});
