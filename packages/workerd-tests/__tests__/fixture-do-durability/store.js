// A trivial Durable Object exposing /write and /read against one fixed-name storage key, plus a
// host worker that routes to a single instance (id "the-instance") so both boots in the test talk
// to the same object.

export class Counter {
  /** @param {DurableObjectState} ctx */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/write") {
      const value = url.searchParams.get("value");
      await this.ctx.storage.put("value", value);
      return Response.json({ wrote: value });
    }
    if (url.pathname === "/read") {
      const value = await this.ctx.storage.get("value");
      return Response.json({ value: value ?? null });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  /** @param {Request} req @param {{COUNTER: DurableObjectNamespace}} env */
  async fetch(req, env) {
    const id = env.COUNTER.idFromName("the-instance");
    return env.COUNTER.get(id).fetch(req);
  },
};
