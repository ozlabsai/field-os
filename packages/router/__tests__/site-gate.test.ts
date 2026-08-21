// The router's shared-secret gate.
//
// A security path, so the cases that matter are the REJECTIONS. A gate that cannot be shown to
// refuse is indistinguishable from no gate at all.

import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

const PASSWORD = "fieldos:hunter2";
const basic = (credentials: string) =>
    new Request("https://os.example.com/", {
      headers: { Authorization: `Basic ${btoa(credentials)}` },
    });

// The asset service and the backend both answer distinctly, so a test can tell which path ran.
function env(overrides: Partial<Env> = {}): Env {
  return {
    WORKSHOP_BACKEND: { fetch: async () => new Response("backend") } as unknown as Fetcher,
    ASSETS: { fetch: async () => new Response("spa") } as unknown as Fetcher,
    ...overrides,
  } as Env;
}

const fetchWith = (req: Request, e: Env) =>
    worker.fetch(req, e, {} as ExecutionContext) as Promise<Response>;

describe("site gate", () => {
  it("is absent unless SITE_PASSWORD is set", async () => {
    // The airgapped default: the network is the boundary, and a gate nobody configured must not
    // appear and lock an operator out of their own deployment.
    const res = await fetchWith(new Request("https://os.example.com/"), env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spa");
  });

  it("challenges an unauthenticated request", async () => {
    const res = await fetchWith(new Request("https://os.example.com/"),
        env({ SITE_PASSWORD: PASSWORD }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="FieldOS"/);
    // A cached 401 can outlive a password change and pin the user out.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a wrong password, and a right password with a wrong user", async () => {
    for (const wrong of ["fieldos:wrong", "someone:hunter2", "hunter2", ""]) {
      const res = await fetchWith(basic(wrong), env({ SITE_PASSWORD: PASSWORD }));
      expect(res.status, `expected ${JSON.stringify(wrong)} to be refused`).toBe(401);
    }
  });

  it("does not fall through on a malformed Authorization header", async () => {
    // `atob` throws on invalid base64; the catch must lead to a challenge, not to the app.
    for (const header of ["Basic !!!not-base64!!!", "Basic", "Bearer sometoken", "  "]) {
      const res = await fetchWith(
          new Request("https://os.example.com/", { headers: { Authorization: header } }),
          env({ SITE_PASSWORD: PASSWORD }));
      expect(res.status, `expected ${JSON.stringify(header)} to be refused`).toBe(401);
    }
  });

  it("admits the correct credentials", async () => {
    const res = await fetchWith(basic(PASSWORD), env({ SITE_PASSWORD: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spa");
  });

  it("gates the API too, not just the SPA", async () => {
    // Gating only the assets would leave the RPC endpoint open to anyone who skipped the page.
    const res = await fetchWith(new Request("https://os.example.com/api"),
        env({ SITE_PASSWORD: PASSWORD }));
    expect(res.status).toBe(401);
  });

  it("exempts /healthz so probes keep working", async () => {
    // The kubelet and the GCE load balancer probe without credentials. Gating this would take the
    // deployment down rather than protect it -- and /healthz returns no user data.
    const res = await fetchWith(new Request("https://os.example.com/healthz"),
        env({ SITE_PASSWORD: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^ok \(backend 200\)/);
  });
});
