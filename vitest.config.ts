import { defineConfig } from "vitest/config";

// The renderer (src/) is tested with vitest; the server (server/) ships its own
// node:test suite (`npm test` in server/). Keep vitest out of server/ so it
// doesn't try to run node:test files it can't understand.
export default defineConfig({
  test: {
    // renderer (src/) + electron main helpers (electron/). The server/ tree
    // ships its own node:test suite, so keep vitest out of it.
    include: ["{src,electron}/**/*.{test,spec}.{ts,tsx}"],
  },
});
