import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron main-process code is CommonJS, not part of the Next app
    "electron/**",
    // A check that drives Electron needs an Electron main entry, and that has
    // to be CommonJS: an .mjs main starts and then never reaches whenReady in
    // this version. Same reason as electron/ above, different folder.
    "scripts/**/*.cjs",
    "dist/**",
  ]),
]);

export default eslintConfig;
