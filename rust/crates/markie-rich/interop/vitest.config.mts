// Runs the Yjs interop checks against the repo's own TipTap schema, yjs and
// y-tiptap. Root is the repo so `@/` and node_modules resolve as in the app.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: { "@": root + "src" } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [root + "src/test/web-storage.ts", root + "src/test/setup.ts"],
    include: ["rust/crates/markie-rich/interop/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
