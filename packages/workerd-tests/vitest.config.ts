import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain node: these tests spawn the real workerd binary as a child process.
    environment: "node",
    // Each suite in this package boots its own workerd process on its own OS-assigned port, so
    // files can run in parallel — unlike fieldos-runtime, nothing here shares a fixed port.
  },
});
