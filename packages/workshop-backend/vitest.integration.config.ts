import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);

// Methods deliberately moved off `PublicApi` (OZL-231/OZL-223). Calling one anonymously is the
// property `blueprint-auth.test.ts` asserts, so its rejection is expected rather than a defect.
const EXPECTED_ABSENT_METHODS = ["getBlueprint", "downloadBlueprint"];

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      // Same shape, different cause: calling a method that is deliberately absent from the
      // unauthenticated surface rejects both the awaited call and the session's read loop.
      // `blueprint-auth.test.ts` asserts exactly these, and the message is narrow enough that a
      // genuinely missing method elsewhere would still surface as a test failure first.
      if (EXPECTED_ABSENT_METHODS.some(name => error.message === `'${name}' is not a function.`)) {
        return false;
      }
    },
  },
});
