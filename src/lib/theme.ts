export interface ThemeTokens {
  background: string;
  surface: string;
  surface2: string;
  foreground: string;
  muted: string;
  border: string;
  /**
   * Rules drawn inside a rendered document: heading underlines, horizontal
   * rules, table borders, code edges. Deliberately far quieter than `border`.
   * A card edge is an object boundary you can act on and has to be seen; a
   * heading underline is typography and its job is to be almost subliminal.
   * They shared a token until 0.5.0, which meant making cards legible also
   * made every document shout. Optional: a theme without it gets a value
   * derived from its own border, so custom themes need no migration.
   */
  docRule?: string;
  accent: string;
  link: string;
  statusGreen?: string;
  statusYellow?: string;
  statusRed?: string;
  statusBlue?: string;
  statusPurple?: string;
  fontSize: number; // base px for the document body
  contentWidth: number; // max width px for the reading column
  // Typography. Optional so every preset saved before templates existed, and
  // every token set an owner pinned to a shared doc, still loads unchanged:
  // a missing field reads as the Markie default. Fonts are stored as ids from
  // TYPEFACES, never as raw CSS, because pinned tokens come from another
  // account and end up in a style property.
  bodyFont?: string;
  headingFont?: string; // HEADING_SAME_AS_BODY or a TYPEFACES id
  lineHeight?: number; // unitless multiple of the body size
  paragraphGap?: number; // em between paragraphs
}

export type ThemeTone = "light" | "dark";

export interface ThemePreset {
  id: string;
  name: string;
  builtIn?: boolean;
  // The template this preset belongs to, and which of its two variants it is.
  // Built-ins always carry both. A custom preset records the template and tone
  // it was forked from; one saved before templates has neither, and is read as
  // a Markie preset of whatever tone its own background is.
  templateId?: string;
  tone?: ThemeTone;
  tokens: ThemeTokens;
}

export const THEME_APPLIED_EVENT = "markie:theme-applied";

// ── Typography ──────────────────────────────────────────────────────────────

export interface ThemeTypography {
  bodyFont: string;
  headingFont: string;
  lineHeight: number;
  paragraphGap: number;
  fontSize: number;
  contentWidth: number;
}

export const HEADING_SAME_AS_BODY = "body";

// Only faces that ship with macOS or Windows, each with fallbacks that keep the
// same character on the other platform. Markie bundles no fonts.
export const TYPEFACES: Array<{ id: string; label: string; stack: string; kind: "sans" | "serif" | "mono" }> = [
  { id: "system", label: "System", stack: "var(--font-geist-sans)", kind: "sans" },
  {
    id: "humanist",
    label: "Avenir",
    stack: "'Avenir Next', Avenir, 'Segoe UI Variable Text', 'Segoe UI', 'Helvetica Neue', sans-serif",
    kind: "sans",
  },
  { id: "helvetica", label: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", kind: "sans" },
  { id: "optima", label: "Optima", stack: "Optima, Candara, 'Avenir Next', 'Segoe UI', sans-serif", kind: "sans" },
  { id: "charter", label: "Charter", stack: "Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif", kind: "serif" },
  { id: "iowan", label: "Iowan", stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", kind: "serif" },
  { id: "newyork", label: "New York", stack: "ui-serif, 'New York', 'Iowan Old Style', Charter, Georgia, serif", kind: "serif" },
  { id: "georgia", label: "Georgia", stack: "Georgia, Charter, 'Times New Roman', serif", kind: "serif" },
  { id: "mono", label: "Monospace", stack: "var(--font-geist-mono)", kind: "mono" },
];

export function typefaceStack(id: string | undefined): string {
  return (TYPEFACES.find((face) => face.id === id) ?? TYPEFACES[0]).stack;
}

// Markie's long-standing look, and the value any missing field falls back to.
// These match the literals globals.css used before templates, so the Markie
// template renders exactly as it did.
export const DEFAULT_TYPOGRAPHY: ThemeTypography = {
  bodyFont: "system",
  headingFont: HEADING_SAME_AS_BODY,
  lineHeight: 1.75,
  paragraphGap: 0.8,
  fontSize: 16,
  contentWidth: 768,
};

export const TYPOGRAPHY_LIMITS = {
  lineHeight: { min: 1.3, max: 2.2, step: 0.05 },
  paragraphGap: { min: 0.3, max: 1.6, step: 0.1 },
  fontSize: { min: 13, max: 22, step: 1 },
  contentWidth: { min: 560, max: 1200, step: 16 },
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Every typography value is checked before it reaches a style property: a
// custom preset can be hand-edited, and pinned tokens belong to someone else.
export function typographyOf(tokens: Partial<ThemeTokens>): ThemeTypography {
  const known = (id: unknown) => TYPEFACES.some((face) => face.id === id);
  const L = TYPOGRAPHY_LIMITS;
  return {
    bodyFont: known(tokens.bodyFont) ? (tokens.bodyFont as string) : DEFAULT_TYPOGRAPHY.bodyFont,
    headingFont:
      tokens.headingFont === HEADING_SAME_AS_BODY || known(tokens.headingFont)
        ? (tokens.headingFont as string)
        : DEFAULT_TYPOGRAPHY.headingFont,
    lineHeight: clampNumber(tokens.lineHeight, DEFAULT_TYPOGRAPHY.lineHeight, L.lineHeight.min, L.lineHeight.max),
    paragraphGap: clampNumber(tokens.paragraphGap, DEFAULT_TYPOGRAPHY.paragraphGap, L.paragraphGap.min, L.paragraphGap.max),
    // The pre-template slider allowed this same range, so stored presets fit.
    fontSize: clampNumber(tokens.fontSize, DEFAULT_TYPOGRAPHY.fontSize, 11, 32),
    contentWidth: clampNumber(tokens.contentWidth, DEFAULT_TYPOGRAPHY.contentWidth, 320, 2400),
  };
}

// ── Templates ───────────────────────────────────────────────────────────────

type ThemeColors = Omit<ThemeTokens, keyof ThemeTypography>;

export interface ThemeTemplate {
  id: string;
  name: string;
  description: string;
  typography: ThemeTypography;
  light: ThemePreset;
  dark: ThemePreset;
}

function variant(
  templateId: string,
  name: string,
  tone: ThemeTone,
  colors: ThemeColors,
  typography: ThemeTypography
): ThemePreset {
  return {
    id: `${templateId}-${tone}`,
    name: `${name} ${tone === "light" ? "Light" : "Dark"}`,
    builtIn: true,
    templateId,
    tone,
    tokens: { ...colors, ...typography },
  };
}

function defineTemplate(spec: {
  id: string;
  name: string;
  description: string;
  typography: Partial<ThemeTypography>;
  light: ThemeColors;
  dark: ThemeColors;
}): ThemeTemplate {
  const typography = { ...DEFAULT_TYPOGRAPHY, ...spec.typography };
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    typography,
    light: variant(spec.id, spec.name, "light", spec.light, typography),
    dark: variant(spec.id, spec.name, "dark", spec.dark, typography),
  };
}

const MARKIE_TEMPLATE = defineTemplate({
  id: "markie",
  name: "Markie",
  description: "Graphite chrome and the system face. The default.",
  typography: {},
  dark: {
    background: "#09090b",
    surface: "#18181b",
    surface2: "#1c1c20",
    foreground: "#fafafa",
    muted: "#a1a1aa",
    // Deliberately quiet, and deliberately below the 3:1 that WCAG 1.4.11 asks
    // of a boundary identifying a component. It was raised to #71717a during
    // 0.5.0 for exactly that reason, and the result was rejected on sight: an
    // app made of visible boxes rather than of documents. Markie is a reader,
    // its edges are meant to be felt rather than seen, and the owner's call is
    // that the calm is worth more than the ratio. Cards are separated by
    // background steps (background / surface / surface-2) and by shadow, so
    // this hairline is a hint and not the only thing carrying structure.
    // If it is ever raised again, raise it alone: docRule below is what keeps
    // rendered documents out of the blast radius.
    border: "#27272a",
    docRule: "#27272a",
    accent: "#3f3f46",
    link: "#60a5fa",
    statusGreen: "#4ade80",
    statusYellow: "#fde047",
    statusRed: "#f87171",
    statusBlue: "#60a5fa",
    statusPurple: "#d8b4fe",
  },
  light: {
    background: "#f8fafc",
    surface: "#eef2f6",
    surface2: "#e3e8ef",
    foreground: "#18181b",
    muted: "#475569",
    // The light half of the same decision recorded on the dark border above:
    // raised to #7a818b during 0.5.0, rejected, and restored. Same reasoning,
    // and the light theme feels it more, because a dark hairline on a pale
    // page reads as a drawn box in a way a light one on a dark page does not.
    border: "#c7d0dc",
    docRule: "#c7d0dc",
    accent: "#dbeafe",
    link: "#1d4ed8",
    statusGreen: "#166534",
    statusYellow: "#92400e",
    statusRed: "#991b1b",
    statusBlue: "#1d4ed8",
    statusPurple: "#6b21a8",
  },
});

// The ids and names predate templates: owner-pinned docs, cloud stores and the
// tests all refer to them, so the Markie variants keep both.
MARKIE_TEMPLATE.dark.name = "Markie Dark";
MARKIE_TEMPLATE.light.name = "Markie Light";

export const MARKIE_DARK: ThemePreset = MARKIE_TEMPLATE.dark;
export const MARKIE_LIGHT: ThemePreset = MARKIE_TEMPLATE.light;

// Every variant below clears the same readability bars theme.test.ts holds the
// Markie variants to (text, muted text, links and status colors at 4.5:1 on
// every surface they sit on). Add a template by adding it here; the tests pick
// it up automatically.
export const THEME_TEMPLATES: ThemeTemplate[] = [
  MARKIE_TEMPLATE,
  defineTemplate({
    id: "paper",
    name: "Paper",
    description: "Warm stock and dark ink, set in a book serif.",
    typography: { bodyFont: "charter", headingFont: "iowan", lineHeight: 1.8, paragraphGap: 1, fontSize: 17, contentWidth: 720 },
    light: {
      background: "#fbf8f1",
      surface: "#f2ede2",
      surface2: "#e9e2d3",
      foreground: "#2b2620",
      muted: "#5f564a",
      border: "#d9cfbc",
      docRule: "#e2d9c7",
      accent: "#efe1c4",
      link: "#9a3b12",
      statusGreen: "#3f6212",
      statusYellow: "#7c4f00",
      statusRed: "#9f1d1d",
      statusBlue: "#1e4f8a",
      statusPurple: "#6b2f8a",
    },
    dark: {
      background: "#1b1916",
      surface: "#24211d",
      surface2: "#2a2722",
      foreground: "#ece4d6",
      muted: "#b5aa96",
      border: "#3a352d",
      docRule: "#322e28",
      accent: "#4a3f2e",
      link: "#eba673",
      statusGreen: "#a9c784",
      statusYellow: "#e9c46a",
      statusRed: "#f2a08f",
      statusBlue: "#9cc0ea",
      statusPurple: "#d6b0ea",
    },
  }),
  defineTemplate({
    id: "nord",
    name: "Nord",
    description: "Arctic blue greys. Cool, quiet and even.",
    typography: { bodyFont: "humanist", lineHeight: 1.7 },
    light: {
      background: "#eceff4",
      surface: "#e3e8ef",
      surface2: "#d8dee9",
      foreground: "#2e3440",
      muted: "#4c566a",
      border: "#c4ccd8",
      docRule: "#cfd6e0",
      accent: "#cfdbea",
      link: "#345e8a",
      statusGreen: "#4a6b2c",
      statusYellow: "#7a5800",
      statusRed: "#a1323b",
      statusBlue: "#345e8a",
      statusPurple: "#7a4777",
    },
    dark: {
      background: "#2e3440",
      surface: "#3b4252",
      surface2: "#434c5e",
      foreground: "#eceff4",
      muted: "#c3cad6",
      border: "#4c566a",
      docRule: "#434c5e",
      accent: "#4c566a",
      link: "#8fc7d6",
      statusGreen: "#b3cf9b",
      statusYellow: "#ebcb8b",
      statusRed: "#f0a9ae",
      statusBlue: "#a9c6e4",
      statusPurple: "#d7b5d2",
    },
  }),
  defineTemplate({
    id: "solarized",
    name: "Solarized",
    description: "Ethan Schoonover's low-glare palette, tuned for reading.",
    typography: { bodyFont: "newyork", headingFont: "system", lineHeight: 1.75 },
    light: {
      background: "#fdf6e3",
      surface: "#f3ecd6",
      surface2: "#eae2c9",
      foreground: "#073642",
      muted: "#4a5f66",
      border: "#d9d0b5",
      docRule: "#e3dbc3",
      accent: "#e8dcb5",
      link: "#1a68a0",
      statusGreen: "#556300",
      statusYellow: "#7d5800",
      statusRed: "#b0211e",
      statusBlue: "#1a68a0",
      statusPurple: "#5357a8",
    },
    dark: {
      background: "#002b36",
      surface: "#073642",
      surface2: "#0b3c49",
      foreground: "#eee8d5",
      muted: "#a7b4b4",
      border: "#1a4b57",
      docRule: "#0f4250",
      accent: "#16505d",
      link: "#5aaee6",
      statusGreen: "#b2c34a",
      statusYellow: "#e0b13c",
      statusRed: "#f57e7b",
      statusBlue: "#6cb6ea",
      statusPurple: "#adb0ea",
    },
  }),
  defineTemplate({
    id: "ink",
    name: "Ink",
    description: "Highest contrast. Pure black and white, editorial type.",
    typography: { bodyFont: "georgia", headingFont: "helvetica", lineHeight: 1.7 },
    light: {
      background: "#ffffff",
      surface: "#f3f3f4",
      surface2: "#e8e8eb",
      foreground: "#000000",
      muted: "#3b3b42",
      border: "#b9b9c0",
      docRule: "#d4d4d8",
      accent: "#dde5ff",
      link: "#0033cc",
      statusGreen: "#0d5c28",
      statusYellow: "#6e4300",
      statusRed: "#a00000",
      statusBlue: "#0033cc",
      statusPurple: "#5a1999",
    },
    dark: {
      background: "#000000",
      surface: "#111113",
      surface2: "#1a1a1e",
      foreground: "#ffffff",
      muted: "#c6c6ce",
      border: "#3a3a40",
      docRule: "#2a2a2f",
      accent: "#2c2c36",
      link: "#82b8ff",
      statusGreen: "#62e28e",
      statusYellow: "#ffd84d",
      statusRed: "#ff8080",
      statusBlue: "#82b8ff",
      statusPurple: "#d9adff",
    },
  }),
  defineTemplate({
    id: "rose",
    name: "Rosé",
    description: "Dusky rose and soft lavender, after Rosé Pine.",
    typography: { bodyFont: "iowan", headingFont: "optima", lineHeight: 1.8, paragraphGap: 0.9 },
    light: {
      background: "#faf4ed",
      surface: "#f3eae0",
      surface2: "#ebe0d5",
      foreground: "#3f3a5a",
      muted: "#625d7c",
      border: "#ddd0c4",
      docRule: "#e6dbd0",
      accent: "#f0dcd8",
      link: "#9c3f58",
      statusGreen: "#3c6b48",
      statusYellow: "#80500a",
      statusRed: "#a23a56",
      statusBlue: "#23607a",
      statusPurple: "#6a4f8e",
    },
    dark: {
      background: "#191724",
      surface: "#1f1d2e",
      surface2: "#26233a",
      foreground: "#e0def4",
      muted: "#a9a5c6",
      border: "#393552",
      docRule: "#2c2942",
      accent: "#403d5c",
      link: "#ebbcba",
      statusGreen: "#9fd3ad",
      statusYellow: "#f6c177",
      statusRed: "#f08aa7",
      statusBlue: "#9ccfd8",
      statusPurple: "#c4a7e7",
    },
  }),
  defineTemplate({
    id: "forest",
    name: "Forest",
    description: "Moss and pine greens, easy on the eyes.",
    typography: { bodyFont: "georgia", headingFont: "humanist", lineHeight: 1.75, paragraphGap: 0.9 },
    light: {
      background: "#f5f7f2",
      surface: "#eaeee5",
      surface2: "#dfe5d9",
      foreground: "#1d2a1f",
      muted: "#4a5a4d",
      border: "#c6d0c0",
      docRule: "#d4dbcd",
      accent: "#d6e7cc",
      link: "#1d6650",
      statusGreen: "#2d662d",
      statusYellow: "#735100",
      statusRed: "#992b2b",
      statusBlue: "#235a8b",
      statusPurple: "#683d83",
    },
    dark: {
      background: "#111914",
      surface: "#17211a",
      surface2: "#1c2820",
      foreground: "#e3ebe2",
      muted: "#a5b7a8",
      border: "#2b3a2f",
      docRule: "#223026",
      accent: "#2d4434",
      link: "#8fd3a9",
      statusGreen: "#93d493",
      statusYellow: "#e3c76f",
      statusRed: "#f2a096",
      statusBlue: "#93bfe8",
      statusPurple: "#cbabe2",
    },
  }),
  defineTemplate({
    id: "studio",
    name: "Studio",
    description: "Technical and compact, with monospace headings.",
    typography: { headingFont: "mono", lineHeight: 1.6, paragraphGap: 0.6, fontSize: 15, contentWidth: 880 },
    light: {
      background: "#fcfcfd",
      surface: "#f1f3f5",
      surface2: "#e7eaee",
      foreground: "#111827",
      muted: "#4b5563",
      border: "#d1d5db",
      docRule: "#e0e3e8",
      accent: "#dfeaff",
      link: "#0b5cc8",
      statusGreen: "#166534",
      statusYellow: "#854d0e",
      statusRed: "#b91c1c",
      statusBlue: "#1d4ed8",
      statusPurple: "#7e22ce",
    },
    dark: {
      background: "#0d1117",
      surface: "#161b22",
      surface2: "#1c2230",
      foreground: "#e6edf3",
      muted: "#9da7b3",
      border: "#30363d",
      docRule: "#21262d",
      accent: "#1f3a5f",
      link: "#58a6ff",
      statusGreen: "#56d364",
      statusYellow: "#e3b341",
      statusRed: "#ff7b72",
      statusBlue: "#79c0ff",
      statusPurple: "#d2a8ff",
    },
  }),
];

// Every built-in variant, so findTheme resolves any of them by id.
export const BUILT_IN_THEMES: ThemePreset[] = THEME_TEMPLATES.flatMap((template) => [
  template.dark,
  template.light,
]);

export function findTemplate(id: string | undefined): ThemeTemplate | undefined {
  return THEME_TEMPLATES.find((template) => template.id === id);
}

export function templateVariant(template: ThemeTemplate, tone: ThemeTone): ThemePreset {
  return tone === "light" ? template.light : template.dark;
}

// ── Store ───────────────────────────────────────────────────────────────────

const STORE_KEY = "markie.themes.v1";

// Shape is shared with the cloud (PUT /api/me/themes) and older builds, so
// everything added after v1 is optional and ignored by anything that predates it.
export interface ThemeStore {
  // The preset painted right now: a template variant or a custom preset. Every
  // caller that only needs the current tokens reads findTheme(store, activeId).
  activeId: string;
  custom: ThemePreset[];
  // The template the person chose. Color mode picks its light or dark variant.
  templateId?: string;
  // A custom preset standing in for the template's variant in one tone. Made
  // by editing colors; the other tone keeps the template until it is edited too.
  overrides?: Partial<Record<ThemeTone, string>>;
  // Typography tweaks layered over the template, in both tones. They belong to
  // the template they were made on and are dropped when another is chosen.
  typography?: Partial<ThemeTypography>;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function presetTone(preset: ThemePreset): ThemeTone {
  return preset.tone ?? editorThemeForTokens(preset.tokens);
}

// Fill in the template fields for a store written before they existed (or by
// another device), so color mode never has to guess.
export function normalizeThemeStore(raw: ThemeStore): ThemeStore {
  const custom = Array.isArray(raw.custom) ? raw.custom.filter((t) => t && typeof t.id === "string" && t.tokens) : [];
  const store: ThemeStore = { ...raw, custom };
  const builtIn = BUILT_IN_THEMES.find((t) => t.id === store.activeId);
  const activeCustom = custom.find((t) => t.id === store.activeId);
  if (!findTemplate(store.templateId)) {
    store.templateId =
      builtIn?.templateId ?? (findTemplate(activeCustom?.templateId) ? activeCustom!.templateId : MARKIE_TEMPLATE.id);
  }
  const overrides: Partial<Record<ThemeTone, string>> = {};
  for (const tone of ["light", "dark"] as const) {
    const id = raw.overrides?.[tone];
    const preset = custom.find((t) => t.id === id);
    if (preset && presetTone(preset) === tone) overrides[tone] = preset.id;
  }
  // A custom preset that was active before templates existed becomes the
  // override for its own tone, so it survives the first color mode change.
  if (activeCustom && !raw.overrides) overrides[presetTone(activeCustom)] = activeCustom.id;
  store.overrides = overrides;
  if (raw.typography && typeof raw.typography === "object") {
    const clean = typographyOf({ ...raw.typography });
    store.typography = Object.fromEntries(
      Object.keys(raw.typography)
        .filter((key): key is keyof ThemeTypography => key in clean)
        .map((key) => [key, clean[key]])
    ) as Partial<ThemeTypography>;
  } else {
    delete store.typography;
  }
  return store;
}

export function loadThemeStore(): ThemeStore {
  const raw = getStorage()?.getItem(STORE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ThemeStore;
      if (parsed && typeof parsed.activeId === "string") {
        return normalizeThemeStore({ ...parsed, custom: parsed.custom ?? [] });
      }
    } catch {
      // fall through to default
    }
  }
  return { activeId: MARKIE_DARK.id, custom: [] };
}

export function saveThemeStore(store: ThemeStore): void {
  getStorage()?.setItem(STORE_KEY, JSON.stringify(store));
}

export function allThemes(store: ThemeStore): ThemePreset[] {
  return [...BUILT_IN_THEMES, ...store.custom];
}

function findPreset(store: ThemeStore, id: string): ThemePreset | undefined {
  return allThemes(store).find((t) => t.id === id);
}

// The preset with the person's typography tweaks applied. Tweaks ride on
// whichever preset is resolved, so every caller that paints findTheme(...)
// (boot, pinned-theme release, share pinning) paints the same thing.
export function findTheme(store: ThemeStore, id: string): ThemePreset {
  const preset = findPreset(store, id) ?? MARKIE_DARK;
  if (!store.typography || Object.keys(store.typography).length === 0) return preset;
  return { ...preset, tokens: { ...preset.tokens, ...store.typography } };
}

export function activeTemplate(store: ThemeStore): ThemeTemplate {
  return findTemplate(normalizeThemeStore(store).templateId) ?? MARKIE_TEMPLATE;
}

// Which preset a tone paints: the custom override for that tone if there is
// one, otherwise the chosen template's own variant.
export function presetForTone(store: ThemeStore, tone: ThemeTone): ThemePreset {
  const clean = normalizeThemeStore(store);
  const overrideId = clean.overrides?.[tone];
  const override = overrideId ? clean.custom.find((t) => t.id === overrideId) : undefined;
  return override ?? templateVariant(findTemplate(clean.templateId) ?? MARKIE_TEMPLATE, tone);
}

// The pure store transitions behind Settings and the palette. They never touch
// storage or the DOM; color-mode.ts commits and paints them.

export function chooseTemplate(store: ThemeStore, templateId: string, tone: ThemeTone): ThemeStore {
  const template = findTemplate(templateId) ?? MARKIE_TEMPLATE;
  return {
    activeId: templateVariant(template, tone).id,
    custom: store.custom,
    templateId: template.id,
    overrides: {},
  };
}

export function chooseCustomPreset(store: ThemeStore, presetId: string): ThemeStore {
  const preset = store.custom.find((t) => t.id === presetId);
  if (!preset) return store;
  const clean = normalizeThemeStore(store);
  const templateId = findTemplate(preset.templateId)?.id ?? clean.templateId ?? MARKIE_TEMPLATE.id;
  const sameTemplate = templateId === clean.templateId;
  const next: ThemeStore = {
    activeId: preset.id,
    custom: store.custom,
    templateId,
    overrides: { ...(sameTemplate ? clean.overrides : {}), [presetTone(preset)]: preset.id },
  };
  if (sameTemplate && clean.typography) next.typography = clean.typography;
  return next;
}

export function resetToTemplate(store: ThemeStore, tone: ThemeTone): ThemeStore {
  const clean = normalizeThemeStore(store);
  return chooseTemplate(clean, clean.templateId ?? MARKIE_TEMPLATE.id, tone);
}

export function setTypography(store: ThemeStore, patch: Partial<ThemeTypography>): ThemeStore {
  return { ...store, typography: { ...store.typography, ...patch } };
}

// Editing a color. A built-in variant forks into a custom preset that remembers
// its template and tone and takes over that tone only; a custom preset is
// edited in place.
export function editColors(
  store: ThemeStore,
  tone: ThemeTone,
  patch: Partial<ThemeColors>,
  newId: string
): ThemeStore {
  const clean = normalizeThemeStore(store);
  const current = presetForTone(clean, tone);
  if (!current.builtIn) {
    return {
      ...clean,
      activeId: current.id,
      custom: clean.custom.map((t) => (t.id === current.id ? { ...t, tokens: { ...t.tokens, ...patch } } : t)),
    };
  }
  const template = findTemplate(current.templateId) ?? MARKIE_TEMPLATE;
  const fork: ThemePreset = {
    id: newId,
    name: `${current.name} Copy`,
    templateId: template.id,
    tone,
    tokens: { ...current.tokens, ...patch },
  };
  return {
    ...clean,
    activeId: fork.id,
    custom: [...clean.custom, fork],
    overrides: { ...clean.overrides, [tone]: fork.id },
  };
}

export function deleteCustomPreset(store: ThemeStore, presetId: string, tone: ThemeTone): ThemeStore {
  const clean = normalizeThemeStore(store);
  const custom = clean.custom.filter((t) => t.id !== presetId);
  const overrides = Object.fromEntries(
    Object.entries(clean.overrides ?? {}).filter(([, id]) => id !== presetId)
  ) as ThemeStore["overrides"];
  const next: ThemeStore = { ...clean, custom, overrides };
  next.activeId = presetForTone(next, tone).id;
  return next;
}

// ── Painting ────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, "");
  const value =
    raw.length === 3
      ? raw
          .split("")
          .map((char) => char + char)
          .join("")
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb
    .map((channel) => channel / 255)
    .map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function editorThemeForTokens(
  tokens: Pick<ThemeTokens, "background">
): "light" | "dark" {
  const tone = luminance(tokens.background);
  return tone !== null && tone > 0.45 ? "light" : "dark";
}

// The CSS a set of tokens paints for typography, shared by applyTheme and the
// Settings previews so a specimen can never disagree with the document.
export function typographyVars(tokens: Partial<ThemeTokens>): Record<string, string> {
  const t = typographyOf(tokens);
  const body = typefaceStack(t.bodyFont);
  return {
    "--theme-font-family": body,
    "--doc-font-family": body,
    "--doc-heading-family": t.headingFont === HEADING_SAME_AS_BODY ? "" : typefaceStack(t.headingFont),
    "--doc-line-height": String(t.lineHeight),
    "--doc-paragraph-gap": `${t.paragraphGap}em`,
    "--theme-font-size": `${t.fontSize}px`,
    "--doc-font-size": `${t.fontSize}px`,
    "--doc-width": `${t.contentWidth}px`,
  };
}

export function applyTheme(tokens: ThemeTokens): void {
  if (typeof document === "undefined") return;
  // Tone-scoped chrome (the flat light treatment in globals.css) keys off
  // this. It derives from the tokens themselves, so custom themes get the
  // treatment that matches their own background, not the preset they came from.
  document.documentElement.dataset.themeTone = editorThemeForTokens(tokens);
  const r = document.documentElement.style;
  r.setProperty("--background", tokens.background);
  r.setProperty("--surface", tokens.surface);
  r.setProperty("--surface-2", tokens.surface2);
  r.setProperty("--foreground", tokens.foreground);
  r.setProperty("--muted", tokens.muted);
  r.setProperty("--border", tokens.border);
  // A custom theme saved before 0.5.0 has no docRule. Rather than dropping such
  // a document back to the loud shared border, soften that theme's own border
  // toward its surface, which keeps the hairline in the theme's palette.
  r.setProperty(
    "--doc-rule",
    tokens.docRule ??
      `color-mix(in srgb, ${tokens.border} 42%, ${tokens.surface})`
  );
  r.setProperty("--accent", tokens.accent);
  r.setProperty("--blue", tokens.link);
  r.setProperty("--status-green", tokens.statusGreen ?? tokens.foreground);
  r.setProperty("--status-yellow", tokens.statusYellow ?? tokens.foreground);
  r.setProperty("--status-red", tokens.statusRed ?? tokens.foreground);
  r.setProperty("--status-blue", tokens.statusBlue ?? tokens.link);
  r.setProperty("--status-purple", tokens.statusPurple ?? tokens.foreground);
  for (const [name, value] of Object.entries(typographyVars(tokens))) {
    // Headings that follow the body leave the variable unset, so they inherit
    // whatever the body is, including a per-document font choice.
    if (value) r.setProperty(name, value);
    else r.removeProperty?.(name);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(THEME_APPLIED_EVENT, {
        detail: { tokens, editorTheme: editorThemeForTokens(tokens) },
      })
    );
  }
}
