// Regenerate the data Markie RS shares with the Electron app for Markdown
// styles and fonts, from the Electron sources themselves:
//
//   rust/crates/markie-core/data/fonts.json           the font registry
//   rust/crates/markie-core/data/markdown-style.json  presets, lists, labels and CSS rules
//   rust/crates/markie-core/data/markdown-style-golden.json  what Electron answers, for tests
//
// Run from the repo root: node rust/scripts/export-styles-fonts.mjs
// MARKIE_ELECTRON_SRC names the Electron checkout (default: this repo).
// The font files themselves are src/assets/fonts, the same files Electron ships.
import { writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const electron = resolve(process.env.MARKIE_ELECTRON_SRC ?? resolve(here, "../.."));
const isFile = (f) => { try { return existsSync(f) && statSync(f).isFile(); } catch { return false; } };
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
      for (const file of [base, `${base}.ts`]) if (isFile(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
globalThis.localStorage = undefined;
const lib = (p) => import(pathToFileURL(resolve(electron, "src/lib", p)).href);
const schema = await lib("markdown-style-schema.ts");
const ms = await lib("markdown-style.ts");
const reg = await lib("fonts/registry.ts");
const out = (name, value) => {
  writeFileSync(resolve(here, "../crates/markie-core/data", name), JSON.stringify(value, null, 1) + "\n");
  console.log("wrote", name);
};

// ── Fonts ──
out("fonts.json", {
  system: reg.SYSTEM_TYPEFACES,
  groupLabels: reg.TYPEFACE_GROUP_LABELS,
  bundled: reg.BUNDLED_FAMILIES.map((f) => ({
    id: f.id, family: f.family, license: f.license, licenseFile: f.licenseFile, version: f.version,
    kind: f.kind, group: f.group, role: f.role, standsInFor: f.standsInFor ?? [], stack: f.stack,
    files: f.files.map((x) => ({ file: x.file, style: x.style, weight: x.weight, bytes: x.bytes, sha256: x.sha256 })),
  })),
});

// ── Styles ──
const CHOICE_ORDER = [
  "headingNumbers", "headingScale", "headingWeight", "headingCase", "headingRule", "headingAlign",
  "paragraphStyle", "bulletStyle", "orderedStyle", "markerColor", "taskStyle", "taskDone",
  "tableStyle", "tableHeader", "tableDensity", "tableWidth", "quoteAccent", "quoteStyle",
  "codeBlockStyle", "inlineCodeStyle", "dividerStyle", "imageAlign", "imageFrame", "captionStyle", "linkStyle",
];
const PAREN = '@counter-style markie-paren { system: extends decimal; suffix: ") "; }';
const rules = {};
for (const key of CHOICE_ORDER) {
  rules[key] = {};
  for (const option of schema.MARKDOWN_STYLE_CHOICES[key]) {
    const css = ms.markdownStyleCss({ base: "spacious", choices: { [key]: option } }, "&");
    rules[key][option] = css ? css.split("\n").filter((line) => line !== PAREN) : [];
  }
}
const labels = Object.fromEntries(Object.entries(ms.MARKDOWN_STYLE_CHOICE_LABELS).map(([k, v]) => [k, v]));
const numberLabels = Object.fromEntries(Object.entries(ms.MARKDOWN_STYLE_NUMBER_LABELS).map(([k, v]) => [k, v.label]));
out("markdown-style.json", {
  presetIds: schema.MARKDOWN_STYLE_PRESET_IDS,
  choices: Object.entries(schema.MARKDOWN_STYLE_CHOICES).map(([key, options]) => ({ key, options })),
  numbers: Object.entries(schema.MARKDOWN_STYLE_NUMBERS).map(([key, v]) => ({ key, ...v })),
  limits: schema.MARKDOWN_STYLE_LIMITS,
  presets: ms.MARKDOWN_STYLE_PRESETS,
  groups: ms.MARKDOWN_STYLE_GROUPS,
  choiceLabels: labels,
  numberLabels,
  choiceOrder: CHOICE_ORDER,
  parenCounter: PAREN,
  rules,
});

// ── Goldens ──
const styles = [
  ...schema.MARKDOWN_STYLE_PRESET_IDS.map((base) => ({ base })),
  { base: "compact", name: "  My\u0000 notes  ", choices: { tableStyle: "grid", bogus: "x", headingRule: "nope", bodyFont: "inter", codeFont: "inter" }, numbers: { leading: 9, blockGap: 0.123456, listIndent: "2", imageRadius: -3 } },
  { base: "unknown", choices: { orderedStyle: "paren", linkStyle: "ink" }, numbers: { headingSpaceAbove: 1.3, headingSpaceBelow: 0.7, listIndent: 2.2, listItemGap: 0, imageRadius: 12, blockGap: 1.35, leading: 1.1 } },
  { base: "classic", choices: { headingFont: "eb-garamond", bodyFont: "literata", quoteStyle: "panel" }, numbers: { leading: 1.04 } },
  { base: "technical", choices: { headingFont: "theme", codeFont: "theme", bodyFont: "local:inter:Futura" } },
  "not a style", null, [], { choices: [] },
];
const stores = [
  null, {}, { activeId: "compact", profiles: [] },
  { activeId: "style-a", profiles: [{ id: "style-a", name: "Mine", style: { base: "classic", choices: { tableStyle: "grid" } } }, { id: "style-a", name: "dup", style: { base: "compact" } }, { id: "Bad Id", name: "x", style: { base: "compact" } }, { id: "compact", name: "x", style: { base: "compact" } }, { id: "style-b", name: "", style: { base: "minimal", numbers: { leading: 1.2 } } }], draft: { base: "classic", choices: { tableStyle: "zebra" } } },
  { activeId: "gone", profiles: "x", draft: { base: "editorial" } },
];
const group = ms.MARKDOWN_STYLE_GROUPS.find((g) => g.id === "tables");
const transitions = stores.map((raw) => {
  let s = ms.markdownStyleStoreOf({ markdownStyle: raw });
  const steps = [];
  const push = (label, next) => { s = next; steps.push({ label, store: s, active: ms.activeMarkdownStyle(s), name: ms.activeMarkdownStyleName(s), edited: ms.markdownStyleEdited(s), pinnable: ms.pinnableMarkdownStyle(s) }); };
  push("start", s);
  push("edit", ms.editMarkdownStyle(s, { choices: { tableStyle: "grid", bodyFont: "lora" }, numbers: { leading: 1.1 } }));
  push("groupChanged:" + ms.markdownStyleGroupChanged(ms.activeMarkdownStyle(s), group), s);
  push("resetGroup", ms.resetMarkdownStyleGroup(s, group));
  push("saveAs", ms.saveMarkdownStyleAs(s, "Compact", "style-new"));
  push("edit2", ms.editMarkdownStyle(s, { choices: { quoteStyle: "card" } }));
  push("saveEdits", ms.saveMarkdownStyleEdits(s));
  push("duplicatePreset", ms.duplicateMarkdownStyle(s, "editorial", "style-dup"));
  push("duplicateProfile", ms.duplicateMarkdownStyle(s, "style-new", "style-dup2"));
  push("rename", ms.renameMarkdownStyle(s, "style-dup", "Spacious"));
  push("choose", ms.chooseMarkdownStyle(s, "style-dup"));
  push("edit3", ms.editMarkdownStyle(s, { numbers: { blockGap: 1.5 } }));
  push("discard", ms.discardMarkdownStyleDraft(s));
  push("delete", ms.deleteMarkdownStyle(s, "style-dup"));
  push("chooseUnknown", ms.chooseMarkdownStyle(s, "nope"));
  return { raw, steps };
});
out("markdown-style-golden.json", {
  styles: styles.map((raw) => ({
    raw,
    sanitized: schema.sanitizeMarkdownStyle(raw),
    canonical: ms.canonicalMarkdownStyle(raw),
    resolved: ms.resolveMarkdownStyle(raw),
    css: ms.markdownStyleCss(raw, ".markdown-body"),
    appCss: ms.markdownStyleCss(raw),
    fontTokens: ms.markdownStyleFontTokens(raw),
    fontCss: ms.markdownStyleFontCss(raw, ms.markdownStyleContainerScope("x")),
    painted: ms.withPaintedFonts(raw, { bodyFont: "local:carlito:Calibri", headingFont: "body", codeFont: "theme" }),
  })),
  stores: transitions,
  names: ["  a\tb  ", "x".repeat(80), 5, " ", "Ünï cödé"].map((raw) => ({ raw, clean: schema.cleanMarkdownStyleName(raw, "fb") })),
  numberFormats: Object.fromEntries(Object.entries(ms.MARKDOWN_STYLE_NUMBER_LABELS).map(([k, v]) => [k, [0.4, 0.65, 1, 1.25, 1.4, 1.8, 2, 3, 8].map((n) => [n, v.format(n)])])),
  profileIds: [[[], 1700000000000], [["style-loyw3v28"], 1700000000000]].map(([taken, seed]) => ({ taken, seed, id: ms.newMarkdownStyleProfileId(taken, seed) })),
  local: ["Futura", "Calibri", "Courier New", "  Gill   Sans ", "Bad;Name", ".SF NS", "A", "Fira Mono"].map((family) => ({ family, kind: reg.localFontKind(family), id: reg.localTypefaceId(family) })),
  localParse: ["local:inter:Futura", "local:nope:Futura", "local:inter:", "local:inter: Futura", "local:carlito:Calibri", "inter"].map((id) => ({ id, family: reg.parseLocalTypefaceId(id)?.family ?? null, fallback: reg.parseLocalTypefaceId(id)?.fallback.id ?? null })),
  office: ["Calibri", "Times New Roman", "Wingdings", "", "x\u0001", "It's"].map((name) => ({ name, stack: reg.officeFontStack(name), aliased: reg.officeFontStack(name, "markie-doc-1"), substitute: reg.substituteFor(name)?.id ?? null })),
  styleFontIds: ["inter", "local:inter:Futura", "theme", "body", "mono", "nope"].map((id) => ({ id, body: ms.styleFontId("bodyFont", id) ?? null, heading: ms.styleFontId("headingFont", id) ?? null, code: ms.styleFontId("codeFont", id) ?? null })),
});

// The Rust table of embedded files (crates/markie-core/src/fonts/files.rs).
{
  const lines = [
    "// Generated by rust/scripts/export-styles-fonts.mjs (see its header). Do not edit by hand.",
    "// The bundled font files and license texts, the same bytes Electron ships (src/assets/fonts).",
    "",
    "pub(super) static FILES: &[(&str, &[u8])] = &[",
    ...reg.BUNDLED_FAMILIES.flatMap((f) => f.files.map((x) => `    ("${x.file}", include_bytes!("../../../../../src/assets/fonts/${x.file}")),`)),
    "];",
    "",
    "pub(super) static LICENSES: &[(&str, &str)] = &[",
    ...reg.BUNDLED_FAMILIES.map((f) => `    ("${f.id}", include_str!("../../../../../src/assets/fonts/${f.licenseFile}")),`),
    "];",
    "",
  ];
  writeFileSync(resolve(here, "../crates/markie-core/src/fonts/files.rs"), lines.join("\n"));
  console.log("wrote fonts/files.rs");
}
