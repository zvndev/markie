import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// The rule set is the one eslint-config-next used to assemble (react
// recommended, react-hooks recommended, a handful of jsx-a11y checks,
// typescript-eslint recommended, and the same overrides), spelled out here now
// that Next is gone. Keeping it identical means the migration commit changes
// no lint outcome.
export default defineConfig([
  globalIgnores([
    "out/**",
    "build/**",
    "coverage/**",
    // Electron main-process code is CommonJS, not part of the renderer bundle
    "electron/**",
    // A check that drives Electron needs an Electron main entry, and that has
    // to be CommonJS: an .mjs main starts and then never reaches whenReady in
    // this version. Same reason as electron/ above, different folder.
    "scripts/**/*.cjs",
    "dist/**",
  ]),
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      // The two hooks rules the old config enforced. The plugin's current
      // recommended set also carries the React Compiler rules; those are a
      // separate decision, not a side effect of changing bundlers.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-no-target-blank": "off",
      "jsx-a11y/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
    },
  },
]);
