// Regenerate rust/crates/markie-app/themes/templates.json from the Electron
// app's src/lib/theme.ts, so both apps ship the same style templates.
// Run from the repo root: node rust/scripts/export-themes.mjs
import { writeFileSync } from "node:fs";
const { THEME_TEMPLATES } = await import("../../src/lib/theme.ts");
const out = THEME_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  light: t.light.tokens,
  dark: t.dark.tokens,
}));
writeFileSync(
  new URL("../crates/markie-app/themes/templates.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n"
);
console.log(`wrote ${out.length} templates`);
