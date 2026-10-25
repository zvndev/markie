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
    // CI's two-core runner, loaded by the whole suite, has run real-work tests
    // (key derivation, a 1 MB ODT round trip, lazy editor mounts) past vitest's
    // five-second default one file at a time, and each one blocked a release.
    // A hang still fails, at twenty seconds instead of five.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // A handful of these opt into jsdom with a per-file directive, and
          // they need the same web-storage repair the dom project does.
          setupFiles: ["./src/test/web-storage.ts"],
          // scripts/ too: the release and check scripts hold real logic, and
          // "it is only a script" is how a one-line quoting bug reached a
          // release gate.
          include: ["{src,electron,scripts}/**/*.{test,spec}.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/web-storage.ts", "./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.tsx"],
        },
      },
    ],
  },
});
