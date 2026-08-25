import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The renderer (src/) is tested with vitest; the server (server/) ships its own
// node:test suite (`npm test` in server/). Keep vitest out of server/ so it
// doesn't try to run node:test files it can't understand.
//
// Two projects:
//   node — pure logic (src/lib, electron/) in a plain node environment. Fast.
//   dom  — React component tests (*.test.tsx) in jsdom with testing-library.
export default defineConfig({
  // Vitest 4 transforms with oxc; it defaults to the automatic JSX runtime, so
  // component tests need no per-file `import React`.
  oxc: {
    jsx: { runtime: "automatic", importSource: "react" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["{src,electron}/**/*.{test,spec}.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.tsx"],
        },
      },
    ],
  },
});
