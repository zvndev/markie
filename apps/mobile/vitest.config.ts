import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The app's own unit tests, separate from the repo root's `npm test`. They
// cover the logic a device would otherwise be needed to exercise: the API
// client, the deep-link router, the session store and the recent list.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
