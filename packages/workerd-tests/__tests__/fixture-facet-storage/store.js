// PROBE for OZL-239 Q1/Q3: does a facet have its own on-disk storage, separate from its parent?
//
// Parent is a real DO namespace (disk-backed, uniqueKey "ozl239-probe-parent"). Child is a facet
// of Parent, created via ctx.facets.get("child", ...) per overseer.ts's gadgetFacet() pattern
// (packages/workshop-backend/src/overseer.ts:2409). Routes:
//   /parent-write?value=X  -> Parent DO writes X to its own ctx.storage
//   /parent-read           -> Parent DO reads its own ctx.storage
//   /child-write?value=X   -> Parent DO forwards to its "child" facet, which writes X
//   /child-read            -> Parent DO forwards to its "child" facet, which reads

export class Child {
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
      return Response.json({ wrote: value, facetId: this.ctx.id.toString() });
    }
    if (url.pathname === "/read") {
      const value = await this.ctx.storage.get("value");
      return Response.json({ value: value ?? null, facetId: this.ctx.id.toString() });
    }
    return new Response("not found", { status: 404 });
  }
}

export class Parent {
  /** @param {DurableObjectState} ctx @param {{CHILD_CLASS: DurableObjectClass}} env */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  #childFacet() {
    return this.ctx.facets.get("child", () => ({
      class: this.env.CHILD_CLASS,
      id: "child",
    }));
  }

  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/parent-write") {
      const value = url.searchParams.get("value");
      await this.ctx.storage.put("value", value);
      return Response.json({ wrote: value, parentId: this.ctx.id.toString() });
    }
    if (url.pathname === "/parent-read") {
      const value = await this.ctx.storage.get("value");
      return Response.json({ value: value ?? null, parentId: this.ctx.id.toString() });
    }
    if (url.pathname === "/child-write") {
      const value = url.searchParams.get("value");
      const facet = this.#childFacet();
      return facet.fetch(new Request(`http://internal/write?value=${value}`));
    }
    if (url.pathname === "/child-read") {
      const facet = this.#childFacet();
      return facet.fetch(new Request("http://internal/read"));
    }
    if (url.pathname === "/child-clone") {
      const dst = url.searchParams.get("dst") ?? "child-clone";
      this.ctx.facets.clone("child", dst);
      return Response.json({ cloned: "child", to: dst });
    }
    if (url.pathname === "/clone-read") {
      const name = url.searchParams.get("name") ?? "child-clone";
      const facet = this.ctx.facets.get(name, () => ({
        class: this.env.CHILD_CLASS,
        id: name,
      }));
      return facet.fetch(new Request("http://internal/read"));
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  /** @param {Request} req @param {{PARENT: DurableObjectNamespace}} env */
  async fetch(req, env) {
    const id = env.PARENT.idFromName("the-parent");
    return env.PARENT.get(id).fetch(req);
  },
};
