import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  async ping() { return "pong"; }
}

export default {
  /**
   * @param {Request} request
   * @param {{ PROBE: DurableObjectNamespace<Probe> }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "alice";

    // The exact shape workshop-backend uses: idFromName, then read `.name` off the STUB's id.
    const id = env.PROBE.idFromName(name);
    const stub = env.PROBE.get(id);
    await stub.ping();  // force the DO to exist, as a real request would

    return Response.json({
      requested: name,
      idName: id.name ?? null,          // the id we constructed
      stubIdName: stub.id?.name ?? null, // what #isAdmin() actually reads
    });
  },
};
