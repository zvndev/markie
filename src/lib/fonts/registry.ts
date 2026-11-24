// The font registry: the one place that says which typefaces Markie knows,
// what each is called, what CSS it paints and which files it ships as.
//
// Three sorts of typeface live here.
//
//   System    The nine faces Markie offered before it bundled any font. Each
//             is a stack of fonts that ship with macOS or Windows. Their ids
//             and stacks are frozen: a theme pinned years ago names them.
//   Bundled   Open-licensed families shipped with the app, the server's web
//             bundle and the phone (src/assets/fonts, built by
//             scripts/fonts/build-fonts.py). The "library" ones are offered
//             for Markdown documents. The "substitute" ones stand in for an
//             Office font that is not installed, and are never offered.
//   Local     A font installed on this computer, chosen by its owner. It is
//             stored as an id that also names a bundled face, because a
//             hosted link or another person cannot load it and sees that
//             bundled face instead.
//
// A typeface is always stored and sent as an id, never as CSS: a pinned theme
// is written by one account and painted for another. Everything that turns an
// id or a document's font name into CSS goes through this file.
//
// No bundler imports here, so the server's tests and plain Node can read it.
// The file URLs come from bundled-fonts.ts.
import { BUNDLED_FONT_FILES, type BundledFontFiles } from "./bundled-files.generated";

export type TypefaceKind = "sans" | "serif" | "mono";

/** How a picker groups its choices. */
export type TypefaceGroup = "system" | "sans" | "serif" | "mono" | "rounded" | "readable" | "display" | "local";

export interface Typeface {
  id: string;
  label: string;
  stack: string;
  kind: TypefaceKind;
  group?: TypefaceGroup;
  /** Ships with Markie, so it looks the same everywhere. */
  bundled?: boolean;
  /** Installed on this computer only. Elsewhere the fallback face is shown. */
  localOnly?: boolean;
}

export const TYPEFACE_GROUP_LABELS: Record<TypefaceGroup, string> = {
  system: "System",
  sans: "Sans serif",
  serif: "Serif",
  mono: "Monospace",
  rounded: "Rounded",
  readable: "Easy to read",
  display: "With personality",
  local: "Only on this computer",
};

// ── System faces ────────────────────────────────────────────────────────────

// Frozen. Only faces that ship with macOS or Windows, each with fallbacks that
// keep the same character on the other platform. registry.test.ts holds every
// id and stack to the value it had before the registry existed.
export const SYSTEM_TYPEFACES: readonly Typeface[] = Object.freeze([
  { id: "system", label: "System", stack: "var(--font-geist-sans)", kind: "sans", group: "system" },
  {
    id: "humanist",
    label: "Avenir",
    stack: "'Avenir Next', Avenir, 'Segoe UI Variable Text', 'Segoe UI', 'Helvetica Neue', sans-serif",
    kind: "sans",
    group: "system",
  },
  { id: "helvetica", label: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", kind: "sans", group: "system" },
  { id: "optima", label: "Optima", stack: "Optima, Candara, 'Avenir Next', 'Segoe UI', sans-serif", kind: "sans", group: "system" },
  { id: "charter", label: "Charter", stack: "Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif", kind: "serif", group: "system" },
  { id: "iowan", label: "Iowan", stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", kind: "serif", group: "system" },
  { id: "newyork", label: "New York", stack: "ui-serif, 'New York', 'Iowan Old Style', Charter, Georgia, serif", kind: "serif", group: "system" },
  { id: "georgia", label: "Georgia", stack: "Georgia, Charter, 'Times New Roman', serif", kind: "serif", group: "system" },
  { id: "mono", label: "Monospace", stack: "var(--font-geist-mono)", kind: "mono", group: "system" },
] satisfies Typeface[]);

// ── Bundled families ────────────────────────────────────────────────────────

// What follows a bundled face in its stack, for the moment before the file
// has loaded and for any character the Latin subset does not hold. Literal
// names, no custom properties: an exported HTML file or PDF has none.
const TAILS: Record<TypefaceKind | "hand", string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  hand: "'Bradley Hand', 'Segoe Print', cursive",
};

interface FamilyMeta {
  kind: TypefaceKind;
  group: TypefaceGroup;
  /** Offered for Markdown documents, or kept as a stand-in for an Office font. */
  role: "library" | "substitute";
  tail?: keyof typeof TAILS;
  /**
   * Office font names this family stands in for when they are not installed,
   * lower case. Each is metric-compatible: the same advance widths, so lines
   * and pages break where they did in Word.
   */
  standsInFor?: readonly string[];
}

// One entry per family in scripts/fonts/sources.json. The order is the order
// the pickers show.
const FAMILY_META: Record<string, FamilyMeta> = {
  inter: { kind: "sans", group: "sans", role: "library" },
  "source-sans": { kind: "sans", group: "sans", role: "library" },
  "plex-sans": { kind: "sans", group: "sans", role: "library" },
  "space-grotesk": { kind: "sans", group: "display", role: "library" },
  atkinson: { kind: "sans", group: "readable", role: "library" },
  lexend: { kind: "sans", group: "readable", role: "library" },
  nunito: { kind: "sans", group: "rounded", role: "library" },
  quicksand: { kind: "sans", group: "rounded", role: "library" },
  "source-serif": { kind: "serif", group: "serif", role: "library" },
  literata: { kind: "serif", group: "serif", role: "library" },
  lora: { kind: "serif", group: "serif", role: "library" },
  "eb-garamond": { kind: "serif", group: "serif", role: "library" },
  "roboto-slab": { kind: "serif", group: "serif", role: "library" },
  fraunces: { kind: "serif", group: "display", role: "library" },
  playfair: { kind: "serif", group: "display", role: "library" },
  caveat: { kind: "sans", group: "display", role: "library", tail: "hand" },
  "jetbrains-mono": { kind: "mono", group: "mono", role: "library" },
  "fira-code": { kind: "mono", group: "mono", role: "library" },
  "source-code": { kind: "mono", group: "mono", role: "library" },
  "atkinson-mono": { kind: "mono", group: "mono", role: "library" },
  // Stand-ins for the fonts Office documents name most. Carlito and Caladea
  // were drawn to Calibri's and Cambria's widths; Arimo, Tinos and Cousine
  // (the Liberation fonts' upstream) to Arial's, Times New Roman's and Courier
  // New's; Gelasio to Georgia's. Helvetica, Times and Courier share widths
  // with the Microsoft faces that were themselves drawn to match them.
  carlito: { kind: "sans", group: "sans", role: "substitute", standsInFor: ["calibri"] },
  caladea: { kind: "serif", group: "serif", role: "substitute", standsInFor: ["cambria"] },
  arimo: { kind: "sans", group: "sans", role: "substitute", standsInFor: ["arial", "arial mt", "arialmt", "helvetica", "helvetica neue", "liberation sans"] },
  tinos: { kind: "serif", group: "serif", role: "substitute", standsInFor: ["times new roman", "times", "liberation serif"] },
  cousine: { kind: "mono", group: "mono", role: "substitute", standsInFor: ["courier new", "courier", "liberation mono"] },
  gelasio: { kind: "serif", group: "serif", role: "substitute", standsInFor: ["georgia"] },
};

export interface BundledFamily extends BundledFontFiles, FamilyMeta {
  /** The CSS a document set in this family paints. */
  stack: string;
}

/**
 * A font family name as one quoted CSS string. Everything outside letters,
 * digits and spaces is written as a hex escape, so a name can never close the
 * string, start another declaration or name a second family.
 */
export function cssFamilyName(name: string): string {
  return `'${name.replace(/[^a-zA-Z0-9 ]/gu, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}'`;
}

const fileOrder = new Map(BUNDLED_FONT_FILES.map((family, index) => [family.id, index]));

/** Every family that ships with Markie, in picker order. */
export const BUNDLED_FAMILIES: readonly BundledFamily[] = Object.freeze(
  Object.keys(FAMILY_META)
    .filter((id) => fileOrder.has(id))
    .map((id) => {
      const files = BUNDLED_FONT_FILES[fileOrder.get(id)!];
      const meta = FAMILY_META[id];
      return { ...files, ...meta, stack: `${cssFamilyName(files.family)}, ${TAILS[meta.tail ?? meta.kind]}` };
    })
);

const bundledById = new Map(BUNDLED_FAMILIES.map((family) => [family.id, family]));
const bundledByName = new Map(BUNDLED_FAMILIES.map((family) => [family.family.toLowerCase(), family]));
const substituteByName = new Map(
  BUNDLED_FAMILIES.flatMap((family) => (family.standsInFor ?? []).map((name) => [name, family] as const))
);

export function bundledFamily(id: string | undefined): BundledFamily | undefined {
  return id === undefined ? undefined : bundledById.get(id);
}

/** The bundled family with exactly this name, whatever the case. */
export function bundledFamilyNamed(name: string | undefined): BundledFamily | undefined {
  return name ? bundledByName.get(name.trim().toLowerCase()) : undefined;
}

/** The families offered for Markdown documents. */
export const LIBRARY_FAMILIES: readonly BundledFamily[] = Object.freeze(BUNDLED_FAMILIES.filter((family) => family.role === "library"));

const LIBRARY_TYPEFACES: readonly Typeface[] = LIBRARY_FAMILIES.map((family) => ({
  id: family.id,
  label: family.family,
  stack: family.stack,
  kind: family.kind,
  group: family.group,
  bundled: true,
}));

// ── Fonts in Word, RTF and OpenDocument files ───────────────────────────────

/**
 * The bundled family that stands in for a document's font when that font is
 * not installed, or undefined when Markie has no stand-in for it.
 */
export function substituteFor(fontName: string | undefined): BundledFamily | undefined {
  return fontName ? substituteByName.get(fontName.trim().toLowerCase()) : undefined;
}

/** Whether a document's font name is safe to put in a style at all. */
export function isPaintableFontName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 200 && !/[\x00-\x1f\x7f]/u.test(name);
}

/**
 * The CSS for a font a Word, RTF or OpenDocument file names.
 *
 * The order is the rule: the document's own embedded copy if it carries one
 * (an alias only that document's text uses), then the font by its real name,
 * which is whatever is installed, and only then the bundled stand-in. A
 * browser takes the first family it can find, so the stand-in is used when,
 * and only when, the real font is missing. The name in the file is never
 * touched: this is how the run is painted, not what is saved.
 */
export function officeFontStack(fontName: string | undefined, embeddedAlias?: string): string {
  if (!isPaintableFontName(fontName)) return "";
  const families = [];
  if (embeddedAlias) families.push(cssFamilyName(embeddedAlias));
  families.push(cssFamilyName(fontName.trim()));
  const substitute = substituteFor(fontName);
  if (substitute) families.push(cssFamilyName(substitute.family));
  return families.join(", ");
}

// ── Fonts installed on this computer ────────────────────────────────────────

const LOCAL_PREFIX = "local:";
// A family name as an operating system reports it. Deliberately narrow: the
// id is stored in themes that sync and get pinned, and is read back on other
// people's computers.
const LOCAL_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._+&-]{0,62}[A-Za-z0-9.+]$|^[A-Za-z0-9]$/;
const LOCAL_LIMIT = 64;

const SERIF_NAME = /serif|times|georgia|garamond|palatino|baskerville|bodoni|didot|caslon|cambria|charter|iowan|hoefler|minion|goudy|bookman|century|constantia|rockwell|sabon|plantin|cochin|athelas|new york|book antiqua|perpetua|merriweather|playfair/i;
const SANS_SERIF_NAME = /sans[ -]?serif|sans/i;
const MONO_NAME = /mono|code|courier|consol|menlo|monaco|terminal|typewriter|fixed|andale/i;

/** A guess at a local font's kind from its name; all a browser will say is the name. */
export function localFontKind(family: string): TypefaceKind {
  if (MONO_NAME.test(family)) return "mono";
  if (SANS_SERIF_NAME.test(family)) return "sans";
  return SERIF_NAME.test(family) ? "serif" : "sans";
}

const LOCAL_FALLBACK: Record<TypefaceKind, string> = { sans: "inter", serif: "source-serif", mono: "jetbrains-mono" };

/**
 * The id a local font is stored as: `local:<bundled id>:<family>`. The
 * bundled id is the face shown wherever the font is not installed. A font
 * Markie has a metric-compatible stand-in for names that stand-in.
 */
export function localTypefaceId(family: string, kind: TypefaceKind = localFontKind(family)): string | null {
  const name = family.trim().replace(/\s+/g, " ");
  if (!LOCAL_FAMILY.test(name)) return null;
  const fallback = substituteFor(name)?.id ?? LOCAL_FALLBACK[kind];
  return `${LOCAL_PREFIX}${fallback}:${name}`;
}

/** Reads a local id back, or null when it is not exactly one. */
export function parseLocalTypefaceId(id: unknown): { family: string; fallback: BundledFamily } | null {
  if (typeof id !== "string" || !id.startsWith(LOCAL_PREFIX) || id.length > 160) return null;
  const rest = id.slice(LOCAL_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 1) return null;
  const fallback = bundledById.get(rest.slice(0, split));
  const family = rest.slice(split + 1);
  if (!fallback || !LOCAL_FAMILY.test(family) || family !== family.trim() || /\s{2,}/.test(family)) return null;
  return { family, fallback };
}

function localTypeface(id: string): Typeface | null {
  const parsed = parseLocalTypefaceId(id);
  if (!parsed) return null;
  return {
    id,
    label: `${parsed.family} (only on this computer)`,
    stack: `${cssFamilyName(parsed.family)}, ${parsed.fallback.stack}`,
    kind: parsed.fallback.kind,
    group: "local",
    localOnly: true,
  };
}

// ── The list everything reads ───────────────────────────────────────────────

/**
 * Every typeface a Markdown document can be set in: the system faces first
 * (so the first entry stays the default any unknown id falls back to), then
 * the bundled library, then the local fonts this computer has adopted.
 *
 * theme.ts re-exports this as TYPEFACES. It grows when a local font is
 * adopted and never shrinks or reorders.
 */
export const TYPEFACE_LIST: Typeface[] = [...SYSTEM_TYPEFACES, ...LIBRARY_TYPEFACES];

export function findTypeface(id: unknown): Typeface | undefined {
  return typeof id === "string" ? TYPEFACE_LIST.find((face) => face.id === id) : undefined;
}

/** The typefaces fit for code: every monospace one. */
export function codeTypefaces(): Typeface[] {
  return TYPEFACE_LIST.filter((face) => face.kind === "mono");
}

/**
 * Makes one local id a typeface the theme will accept. Returns it, or null
 * for anything that is not a well-formed local id. Safe to call with ids
 * from other people: the family is painted as a quoted name ahead of a
 * bundled face, and a computer without that font shows the bundled face.
 */
export function adoptLocalTypeface(id: unknown): Typeface | null {
  const known = findTypeface(id);
  if (known) return known.localOnly ? known : null;
  if (TYPEFACE_LIST.filter((face) => face.localOnly).length >= LOCAL_LIMIT) return null;
  const face = typeof id === "string" ? localTypeface(id) : null;
  if (face) TYPEFACE_LIST.push(face);
  return face;
}

/**
 * Adopts every local id found anywhere in a value: a theme store from the
 * cloud, tokens an owner pinned. Call it before the theme reads the value,
 * or a local id in it is unknown and falls back to the default face.
 */
export function adoptLocalTypefacesIn(value: unknown, depth = 0): void {
  if (typeof value === "string") {
    if (value.startsWith(LOCAL_PREFIX)) adoptLocalTypeface(value);
  } else if (value && typeof value === "object" && depth < 6) {
    for (const item of Array.isArray(value) ? value.slice(0, 200) : Object.values(value).slice(0, 200)) adoptLocalTypefacesIn(item, depth + 1);
  }
}

// What this browser already stored is adopted as the module loads, which is
// before the theme reads its store for the first time. A theme saved with a
// local font would otherwise lose it on the next launch.
const ADOPTED_KEYS = ["markie.themes.v1", "markie.fonts.v1"];
try {
  if (typeof localStorage !== "undefined") {
    for (const key of ADOPTED_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw && raw.includes(LOCAL_PREFIX)) adoptLocalTypefacesIn(JSON.parse(raw));
    }
  }
} catch {
  // Unreadable storage only means nothing local is adopted yet.
}

// ── @font-face ──────────────────────────────────────────────────────────────

/**
 * The @font-face rules for bundled families. `urlFor` turns a file path under
 * src/assets/fonts into whatever the page can load: a built asset URL in the
 * app, a data: URL in an exported file. A file it has no URL for is left out.
 */
export function fontFaceRules(urlFor: (file: string) => string | undefined, families: readonly BundledFamily[] = BUNDLED_FAMILIES): string {
  const rules: string[] = [];
  for (const family of families) {
    for (const file of family.files) {
      const url = urlFor(file.file);
      if (!url) continue;
      rules.push(
        `@font-face{font-family:${cssFamilyName(family.family)};font-style:${file.style};font-weight:${file.weight};font-display:swap;src:url(${JSON.stringify(url)}) format("woff2")}`
      );
    }
  }
  return rules.join("\n");
}

/** The bundled families a set of typeface ids and document font names would paint with. */
export function bundledFamiliesUsed(typefaceIds: readonly (string | undefined)[], fontNames: readonly (string | undefined)[] = []): BundledFamily[] {
  const used = new Set<BundledFamily>();
  for (const id of typefaceIds) {
    const family = bundledFamily(id) ?? parseLocalTypefaceId(id)?.fallback;
    if (family) used.add(family);
  }
  for (const name of fontNames) {
    const family = bundledFamilyNamed(name) ?? substituteFor(name);
    if (family) used.add(family);
  }
  return BUNDLED_FAMILIES.filter((family) => used.has(family));
}
