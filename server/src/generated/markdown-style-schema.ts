// GENERATED from src/lib/markdown-style-schema.ts by server/scripts/sync-markdown-style.mjs.
// Do not edit. Change the source, then run: (cd server && npm run markdown-style:sync)
// What a stored Markdown style may contain, and the one function that cleans
// one. A style is how Markdown is drawn (heading rules, list markers, table
// borders, spacing), kept apart from colours and faces so any style works
// with any colour theme.
//
// A style travels: it syncs with the account, and an owner can pin it to a
// document so everyone it is shared with reads it that way. So a style from
// storage is somebody else's data. It is never CSS. It is a preset id, a few
// option ids picked from the lists below, and a few numbers held inside the
// ranges below. Anything else is dropped here, on the server when it is
// stored and again on every client when it is read, and the CSS is written
// from the cleaned value by a table lookup (markdown-style.ts), never by
// putting a stored string into a stylesheet.
//
// This file has no imports and uses only syntax Node can strip, because the
// server keeps a byte-for-byte copy (server/src/generated/markdown-style-schema.ts,
// written by server/scripts/sync-markdown-style.mjs): its Docker build sees
// server/ alone. markdown-style-schema.test.ts fails when the two differ.
//
// Compatibility: adding an option or a number is safe. A client or server
// that predates it drops that one choice and draws the preset's own. Never
// remove or rename an id that has shipped; the first id of each list is what
// Spacious uses and must stay first.

/** The built-in looks. The first is Markie's long-standing rendering. */
export const MARKDOWN_STYLE_PRESET_IDS = ["spacious", "compact", "classic", "technical", "editorial", "minimal"] as const;

/** Every named choice and the option ids it accepts. The first option of each is Spacious. */
export const MARKDOWN_STYLE_CHOICES = {
  headingScale: ["standard", "compact", "large", "flat"],
  headingWeight: ["bold", "medium", "light", "heavy"],
  headingCase: ["none", "upper", "upper-minor", "small-caps"],
  headingRule: ["underline", "title", "short", "none"],
  headingAlign: ["left", "center-title", "center"],
  paragraphStyle: ["block", "indented", "justified"],
  bulletStyle: ["disc", "nested", "dash", "square", "hollow", "arrow"],
  orderedStyle: ["decimal", "paren", "alpha", "roman", "outline", "legal"],
  markerColor: ["muted", "text", "accent"],
  taskStyle: ["box", "round", "minimal"],
  taskDone: ["plain", "dim", "strike"],
  tableStyle: ["lines", "grid", "zebra", "minimal"],
  tableHeader: ["caps", "bold", "filled", "plain"],
  tableDensity: ["comfortable", "compact", "roomy"],
  tableWidth: ["auto", "full", "centered"],
  quoteStyle: ["panel", "bar", "italic", "card", "pull"],
  quoteAccent: ["accent", "quiet", "link", "text"],
  codeBlockStyle: ["card", "flat", "bordered", "bar"],
  inlineCodeStyle: ["chip", "flat", "bordered", "plain"],
  dividerStyle: ["line", "short", "dotted", "ornament", "space"],
  imageAlign: ["inline", "center"],
  imageFrame: ["none", "border", "shadow"],
  captionStyle: ["inline", "centered", "quiet"],
  linkStyle: ["hover", "underline", "dotted", "ink", "plain"],
} as const;

/** Every number, its range, and the value Spacious uses. */
export const MARKDOWN_STYLE_NUMBERS = {
  headingSpaceAbove: { min: 0.4, max: 2, step: 0.05, default: 1 },
  headingSpaceBelow: { min: 0.4, max: 2, step: 0.05, default: 1 },
  blockGap: { min: 0.4, max: 2, step: 0.05, default: 1 },
  leading: { min: 0.8, max: 1.25, step: 0.01, default: 1 },
  listIndent: { min: 1, max: 3, step: 0.1, default: 1.8 },
  listItemGap: { min: 0, max: 0.8, step: 0.05, default: 0.3 },
  imageRadius: { min: 0, max: 24, step: 1, default: 8 },
} as const;

export type MarkdownStylePresetId = (typeof MARKDOWN_STYLE_PRESET_IDS)[number];
export type MarkdownStyleChoiceKey = keyof typeof MARKDOWN_STYLE_CHOICES;
export type MarkdownStyleNumberKey = keyof typeof MARKDOWN_STYLE_NUMBERS;
export type MarkdownStyleChoices = { [K in MarkdownStyleChoiceKey]?: (typeof MARKDOWN_STYLE_CHOICES)[K][number] };
export type MarkdownStyleNumbers = { [K in MarkdownStyleNumberKey]?: number };

/**
 * A style as it is stored: a preset and what was changed on top of it. A
 * choice or number that is absent is the preset's own, so a preset that is
 * improved later improves every profile built on it.
 */
export interface MarkdownStyle {
  base: MarkdownStylePresetId;
  /** What its maker called it. Shown to a reader of a pinned document; never used for anything else. */
  name?: string;
  choices?: MarkdownStyleChoices;
  numbers?: MarkdownStyleNumbers;
}

/** A style somebody saved under a name. */
export interface MarkdownStyleProfile {
  id: string;
  name: string;
  style: MarkdownStyle;
}

/** The account's styles: the saved profiles, which one is in use, and edits not yet saved. */
export interface MarkdownStyleStore {
  /** A preset id or a profile id. */
  activeId: string;
  profiles: MarkdownStyleProfile[];
  /** Changes made on top of the active style and not saved yet. */
  draft?: MarkdownStyle;
}

export const MARKDOWN_STYLE_LIMITS = { profiles: 40, name: 60, bytes: 64 * 1024 } as const;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** A label: one line, printable, short. Never trusted as anything but text. */
export function cleanMarkdownStyleName(value: unknown, fallback: string = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, MARKDOWN_STYLE_LIMITS.name).join("").trim() || fallback;
}

function isPresetId(value: unknown): value is MarkdownStylePresetId {
  return typeof value === "string" && (MARKDOWN_STYLE_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * The style in `raw`, holding only what the lists above allow. Null when
 * `raw` is not a style at all. An unknown preset reads as Spacious; an
 * unknown choice, an unknown option and a number that is not a number are
 * dropped; a number out of range is moved to the nearest end of it.
 */
export function sanitizeMarkdownStyle(raw: unknown): MarkdownStyle | null {
  if (!isRecord(raw)) return null;
  const style: MarkdownStyle = { base: isPresetId(own(raw, "base")) ? (own(raw, "base") as MarkdownStylePresetId) : "spacious" };
  const name = cleanMarkdownStyleName(own(raw, "name"));
  if (name) style.name = name;

  const rawChoices = own(raw, "choices");
  if (isRecord(rawChoices)) {
    const choices: Record<string, string> = {};
    for (const key of Object.keys(MARKDOWN_STYLE_CHOICES) as MarkdownStyleChoiceKey[]) {
      const value = own(rawChoices, key);
      if (typeof value === "string" && (MARKDOWN_STYLE_CHOICES[key] as readonly string[]).includes(value)) choices[key] = value;
    }
    if (Object.keys(choices).length > 0) style.choices = choices as MarkdownStyleChoices;
  }

  const rawNumbers = own(raw, "numbers");
  if (isRecord(rawNumbers)) {
    const numbers: Record<string, number> = {};
    for (const key of Object.keys(MARKDOWN_STYLE_NUMBERS) as MarkdownStyleNumberKey[]) {
      const value = own(rawNumbers, key);
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const { min, max } = MARKDOWN_STYLE_NUMBERS[key];
      numbers[key] = Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000;
    }
    if (Object.keys(numbers).length > 0) style.numbers = numbers as MarkdownStyleNumbers;
  }
  return style;
}

/**
 * The account's style store, cleaned the same way. Null when `raw` is not
 * one. Profiles with a bad id or a repeated id are dropped, the list is cut
 * at the limit, and an active id that names nothing reads as Spacious.
 */
export function sanitizeMarkdownStyleStore(raw: unknown): MarkdownStyleStore | null {
  if (!isRecord(raw)) return null;
  const profiles: MarkdownStyleProfile[] = [];
  const seen = new Set<string>(MARKDOWN_STYLE_PRESET_IDS);
  const rawProfiles = own(raw, "profiles");
  if (Array.isArray(rawProfiles)) {
    for (const entry of rawProfiles) {
      if (profiles.length >= MARKDOWN_STYLE_LIMITS.profiles) break;
      if (!isRecord(entry)) continue;
      const id = own(entry, "id");
      const style = sanitizeMarkdownStyle(own(entry, "style"));
      if (typeof id !== "string" || !PROFILE_ID.test(id) || seen.has(id) || !style) continue;
      seen.add(id);
      const name = cleanMarkdownStyleName(own(entry, "name"), "Untitled style");
      profiles.push({ id, name, style: { ...style, name } });
    }
  }
  const activeId = own(raw, "activeId");
  const store: MarkdownStyleStore = { activeId: typeof activeId === "string" && seen.has(activeId) ? activeId : "spacious", profiles };
  const draft = sanitizeMarkdownStyle(own(raw, "draft"));
  if (draft) store.draft = draft;
  return store;
}

/** True when `id` could be a profile's id. Preset ids are not. */
export function isMarkdownStyleProfileId(id: unknown): id is string {
  return typeof id === "string" && PROFILE_ID.test(id) && !isPresetId(id);
}
