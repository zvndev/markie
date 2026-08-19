import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The renderer (src/) is tested with vitest; the server (server/) ships its own
// node:test suite (`npm test` in server/). Keep vitest out of server/ so it
// doesn't try to run node:test files it can't understand.
export default defineConfig({
  resolve: {
    alias: {
      // src/ imports itself through the "@/" alias from tsconfig paths. Type-only
      // "@/" imports erase before resolution, so tests got away without this for
      // a long time; the first value import under test needs it resolved for real.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // renderer (src/) + electron main helpers (electron/). The server/ tree
    // ships its own node:test suite, so keep vitest out of it.
    include: ["{src,electron}/**/*.{test,spec}.{ts,tsx}"],
  },
});
