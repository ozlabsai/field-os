// The "after migration" side of facet-storage.test.js: an ORDINARY Durable Object namespace --
// no facets, no durableObjectClass binding -- pointed at a directory where a facet's raw sqlite
// file has been renamed to the filename a normal DO with this uniqueKey + id expects.
//
// If this reads the facet's value back, a facet's storage file is an ordinary DO's storage file
// and only its NAME made it a facet. That is the whole question OZL-239 was gated on.

export class Reader {
  /** @param {DurableObjectState} ctx */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** @param {Request} req */
  async fetch(req) {
    const value = await this.ctx.storage.get("value");
    const keys = [...(await this.ctx.storage.list()).keys()];
    return Response.json({ value: value ?? null, id: this.ctx.id.toString(), keys });
  }
}

export default {
  /** @param {Request} req @param {{READER: DurableObjectNamespace}} env */
  async fetch(req, env) {
    // Reads `id`, and the test's negative control depends on it being honoured: a fixture that
    // ignored this parameter would answer every request from the same object and turn the
    // negative control into a false pass. That is not hypothetical -- it happened during the
    // original probe (see this fixture's test file).
    const name = new URL(req.url).searchParams.get("id") ?? "the-parent";
    return env.READER.get(env.READER.idFromName(name)).fetch(new Request("http://internal/read"));
  },
};
