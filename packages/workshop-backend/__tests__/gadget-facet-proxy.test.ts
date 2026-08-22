// OZL-134: `callback.dup()` failed through the gadget-facet Proxy, silently killing every gadget
// subscription. The agent is instructed to call it (`agent.ts:425-441`); without it Cap'n Web
// disposes the callback stub when `subscribe()` returns, so the gadget's UI waits forever for
// state that never arrives -- and renders a blank page while reporting success.
//
// The Proxy wraps every method to route exceptions to the gadget console log, and assumed every
// result was a promise. `dup()` returns a stub synchronously, so `.catch()` threw before the call
// did anything.
//
// Two levels are tested. `isCatchable` is the shipped predicate, imported from the module under
// test rather than restated. The Proxy test rebuilds the wrapper shape from `getGadgetFacet`
// because the real one is constructed inside a Durable Object method that cannot be instantiated
// here -- so it is pinned against real Cap'n Web stubs, and asserts the *behaviour* the fix must
// preserve rather than only the predicate in isolation.
import { describe, expect, it } from "vitest";
import { RpcStub, RpcTarget } from "capnweb";

import { isCatchable } from "../src/overseer.js";

class Counter extends RpcTarget {
  async increment(): Promise<number> {
    return 1;
  }
  async explode(): Promise<never> {
    throw new Error("boom");
  }
}

// The wrapper from `getGadgetFacet` (overseer.ts), reduced to the part under test: the guard and
// the catch that delivers to the console log. `onError` stands in for `deliverGadgetLogs`.
function wrapLikeGadgetFacet(stub: RpcStub<Counter>, onError: (err: unknown) => void) {
  return new Proxy(stub, {
    get(target, prop, _receiver) {
      let method = Reflect.get(target, prop, target);
      if (typeof method !== "function" || typeof prop === "symbol") return method;
      return (...args: unknown[]) => {
        let result = Reflect.apply(method, target, args);
        if (!isCatchable(result)) return result;
        return result.catch((err: unknown) => {
          onError(err);
          throw err;
        });
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }) as unknown as RpcStub<Counter> & { dup(): RpcStub<Counter> };
}

describe("isCatchable", () => {
  it("accepts promises and rejects Cap'n Web's synchronous lifecycle results", () => {
    expect(isCatchable(Promise.resolve(1))).toBe(true);
    expect(isCatchable({ catch: () => {} })).toBe(true);

    // The values that broke: a stub returned by dup(), and the undefined from onRpcBroken().
    expect(isCatchable(undefined)).toBe(false);
    expect(isCatchable(null)).toBe(false);
    expect(isCatchable(42)).toBe(false);
    expect(isCatchable({})).toBe(false);
  });
});

describe("the gadget-facet Proxy", () => {
  it("lets dup() through, so a subscription callback can outlive the call", () => {
    using stub = new RpcStub(new Counter());
    let proxy = wrapLikeGadgetFacet(stub, () => {});

    // Before the fix this threw `TypeError: result.catch is not a function`.
    let duplicate = proxy.dup();
    expect(typeof duplicate).toBe("function");
    // The duplicate must be a usable stub, not merely a value that did not throw.
    expect(typeof (duplicate as unknown as Counter).increment).toBe("function");
    duplicate[Symbol.dispose]();
  });

  it("still routes async rejections to the console log, which is why the wrapper exists", async () => {
    using stub = new RpcStub(new Counter());
    let seen: unknown[] = [];
    let proxy = wrapLikeGadgetFacet(stub, (err) => seen.push(err));

    await expect(proxy.explode()).rejects.toThrow("boom");
    expect(seen).toHaveLength(1);
  });

  it("still resolves ordinary RPC calls", async () => {
    using stub = new RpcStub(new Counter());
    let proxy = wrapLikeGadgetFacet(stub, () => {});
    await expect(proxy.increment()).resolves.toBe(1);
  });
});
