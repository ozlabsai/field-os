// Attempts a fetch to whatever URL is passed in `?url=`, through the worker's configured
// `globalOutbound` (a Network service set up per-fixture-config with a specific `allow` list).
// Reports success/failure only — a blocked connection surfaces to JS as a bare
// `internal error; reference = <token>` Error that does not name the blocked address, so callers
// must assert on ok/not-ok rather than on message text.

export default {
  /** @param {Request} req */
  async fetch(req) {
    const target = new URL(req.url).searchParams.get("url");
    if (!target) return Response.json({ ok: false, error: "missing ?url=" });
    try {
      await fetch(target);
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) });
    }
  },
};
