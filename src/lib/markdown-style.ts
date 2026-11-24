// Markdown styles: how a document's Markdown is drawn, apart from its colours
// and faces (theme.ts). A style is a preset plus what was changed on top of
// it (markdown-style-schema.ts says what may be stored). This file holds the
// presets, the labels the editor shows, the transitions the editor makes on
// the account's store, and the one function that turns a style into CSS.
//
// How it paints. globals.css draws Spacious, Markie's long-standing look, and
// is not touched. Every other choice is written as a few override rules,
// looked up from the tables below and prefixed with a scope. Spacious itself
// writes nothing at all: the stylesheet is empty, so the default look is the
// same bytes of CSS it always was. Colours are never written here, only the
// theme's own variables, so a style follows whatever theme is painted.
//
// Nothing stored ever reaches the stylesheet as text. A style is cleaned
// (sanitizeMarkdownStyle) and each id is then a key into a table of rules
// written in this file; a number is clamped, rounded and printed as a number.
import {
  MARKDOWN_STYLE_CHOICES,
  MARKDOWN_STYLE_NUMBERS,
  MARKDOWN_STYLE_PRESET_IDS,
  cleanMarkdownStyleName,
  isMarkdownStyleProfileId,
  sanitizeMarkdownStyle,
  sanitizeMarkdownStyleStore,
  type MarkdownStyle,
  type MarkdownStyleChoiceKey,
  type MarkdownStyleChoices,
  type MarkdownStyleNumberKey,
  type MarkdownStyleNumbers,
  type MarkdownStylePresetId,
  type MarkdownStyleStore,
} from "./markdown-style-schema";

export type {
  MarkdownStyle,
  MarkdownStyleChoiceKey,
  MarkdownStyleNumberKey,
  MarkdownStylePresetId,
  MarkdownStyleProfile,
  MarkdownStyleStore,
} from "./markdown-style-schema";
export { MARKDOWN_STYLE_CHOICES, MARKDOWN_STYLE_NUMBERS, sanitizeMarkdownStyle } from "./markdown-style-schema";

// ── Presets ─────────────────────────────────────────────────────────────────

export interface MarkdownStylePreset {
  id: MarkdownStylePresetId;
  name: string;
  /** One line under the name on its card. */
  description: string;
  choices: MarkdownStyleChoices;
  numbers: MarkdownStyleNumbers;
}

export const MARKDOWN_STYLE_PRESETS: readonly MarkdownStylePreset[] = [
  {
    id: "spacious",
    name: "Spacious",
    description: "Markie's own look: ruled headings, roomy blocks. The default.",
    choices: {},
    numbers: {},
  },
  {
    id: "compact",
    name: "Compact",
    description: "Tighter everything, for notes and reference pages you scan.",
    choices: {
      headingScale: "compact",
      headingRule: "title",
      bulletStyle: "nested",
      taskDone: "dim",
      tableHeader: "bold",
      tableDensity: "compact",
      quoteStyle: "bar",
      codeBlockStyle: "flat",
      inlineCodeStyle: "flat",
    },
    numbers: { headingSpaceAbove: 0.7, headingSpaceBelow: 0.7, blockGap: 0.7, leading: 0.9, listIndent: 1.5, listItemGap: 0.1 },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Set like a book: indented paragraphs, a centred title, no rules.",
    choices: {
      headingWeight: "medium",
      headingRule: "none",
      headingAlign: "center-title",
      paragraphStyle: "indented",
      markerColor: "text",
      tableStyle: "minimal",
      tableHeader: "bold",
      tableWidth: "centered",
      quoteStyle: "italic",
      quoteAccent: "quiet",
      codeBlockStyle: "bordered",
      inlineCodeStyle: "bordered",
      dividerStyle: "ornament",
      imageAlign: "center",
      captionStyle: "centered",
      linkStyle: "underline",
    },
    numbers: { headingSpaceAbove: 1.2, imageRadius: 2 },
  },
  {
    id: "technical",
    name: "Technical",
    description: "For docs and specs: numbered outlines, gridded tables, plain links.",
    choices: {
      bulletStyle: "nested",
      orderedStyle: "legal",
      markerColor: "text",
      tableStyle: "grid",
      tableHeader: "filled",
      tableDensity: "compact",
      tableWidth: "full",
      quoteStyle: "card",
      linkStyle: "underline",
    },
    numbers: { headingSpaceAbove: 1.1, imageRadius: 4 },
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Big confident headings and pull quotes, like a published piece.",
    choices: {
      headingScale: "large",
      headingWeight: "heavy",
      headingCase: "upper-minor",
      headingRule: "short",
      bulletStyle: "square",
      markerColor: "accent",
      tableHeader: "bold",
      tableDensity: "roomy",
      quoteStyle: "pull",
      codeBlockStyle: "bar",
      dividerStyle: "short",
      imageAlign: "center",
      imageFrame: "shadow",
      captionStyle: "centered",
      linkStyle: "ink",
    },
    numbers: { headingSpaceAbove: 1.3, blockGap: 1.2, imageRadius: 4 },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Close to plain text: flat headings, dashes, almost no lines.",
    choices: {
      headingScale: "flat",
      headingWeight: "medium",
      headingRule: "none",
      bulletStyle: "dash",
      taskStyle: "minimal",
      taskDone: "dim",
      tableStyle: "minimal",
      tableHeader: "plain",
      quoteStyle: "bar",
      quoteAccent: "quiet",
      codeBlockStyle: "flat",
      inlineCodeStyle: "plain",
      dividerStyle: "space",
      linkStyle: "dotted",
    },
    numbers: { imageRadius: 0 },
  },
];

export const DEFAULT_MARKDOWN_STYLE: MarkdownStyle = { base: "spacious" };

export function findMarkdownStylePreset(id: unknown): MarkdownStylePreset | undefined {
  return MARKDOWN_STYLE_PRESETS.find((preset) => preset.id === id);
}

// ── Resolving ───────────────────────────────────────────────────────────────

/** A style with every choice and number filled in. */
export interface ResolvedMarkdownStyle {
  base: MarkdownStylePresetId;
  choices: { [K in MarkdownStyleChoiceKey]: (typeof MARKDOWN_STYLE_CHOICES)[K][number] };
  numbers: { [K in MarkdownStyleNumberKey]: number };
}

const CHOICE_KEYS = Object.keys(MARKDOWN_STYLE_CHOICES) as MarkdownStyleChoiceKey[];
const NUMBER_KEYS = Object.keys(MARKDOWN_STYLE_NUMBERS) as MarkdownStyleNumberKey[];

/** What a preset draws, in full. */
function presetValues(id: MarkdownStylePresetId): ResolvedMarkdownStyle {
  const preset = findMarkdownStylePreset(id) ?? MARKDOWN_STYLE_PRESETS[0];
  const choices = Object.fromEntries(CHOICE_KEYS.map((key) => [key, preset.choices[key] ?? MARKDOWN_STYLE_CHOICES[key][0]]));
  const numbers = Object.fromEntries(NUMBER_KEYS.map((key) => [key, preset.numbers[key] ?? MARKDOWN_STYLE_NUMBERS[key].default]));
  return { base: preset.id, choices, numbers } as ResolvedMarkdownStyle;
}

/** Any value at all, read as a style. Cleaned first, so it is safe on whatever storage or a server returned. */
export function resolveMarkdownStyle(raw: unknown): ResolvedMarkdownStyle {
  const style = sanitizeMarkdownStyle(raw) ?? DEFAULT_MARKDOWN_STYLE;
  const resolved = presetValues(style.base);
  return {
    base: resolved.base,
    choices: { ...resolved.choices, ...style.choices },
    numbers: { ...resolved.numbers, ...style.numbers },
  } as ResolvedMarkdownStyle;
}

/**
 * The same style in its one stored form: cleaned, and holding only what
 * differs from its preset. Two styles that draw the same thing from the same
 * preset are equal after this.
 */
export function canonicalMarkdownStyle(raw: unknown): MarkdownStyle {
  const style = sanitizeMarkdownStyle(raw) ?? DEFAULT_MARKDOWN_STYLE;
  const preset = presetValues(style.base);
  const out: MarkdownStyle = { base: style.base };
  if (style.name) out.name = style.name;
  const choices: Record<string, string> = {};
  for (const key of CHOICE_KEYS) {
    const value = style.choices?.[key];
    if (value !== undefined && value !== preset.choices[key]) choices[key] = value;
  }
  const numbers: Record<string, number> = {};
  for (const key of NUMBER_KEYS) {
    const value = style.numbers?.[key];
    if (value !== undefined && value !== preset.numbers[key]) numbers[key] = value;
  }
  if (Object.keys(choices).length > 0) out.choices = choices as MarkdownStyleChoices;
  if (Object.keys(numbers).length > 0) out.numbers = numbers as MarkdownStyleNumbers;
  return out;
}

/** True when both draw the same thing. Names do not count. */
export function sameMarkdownStyle(a: unknown, b: unknown): boolean {
  const left = resolveMarkdownStyle(a);
  const right = resolveMarkdownStyle(b);
  return CHOICE_KEYS.every((key) => left.choices[key] === right.choices[key]) && NUMBER_KEYS.every((key) => left.numbers[key] === right.numbers[key]);
}

// ── What the editor shows ───────────────────────────────────────────────────

export interface MarkdownStyleGroup {
  id: string;
  label: string;
  /** What the group covers, for the line under its name. */
  hint: string;
  choices: readonly MarkdownStyleChoiceKey[];
  numbers: readonly MarkdownStyleNumberKey[];
}

/** The elements of a document, in the order the editor lists them. */
export const MARKDOWN_STYLE_GROUPS: readonly MarkdownStyleGroup[] = [
  { id: "headings", label: "Headings", hint: "Size, weight, case, rules and the space around them", choices: ["headingScale", "headingWeight", "headingCase", "headingRule", "headingAlign"], numbers: ["headingSpaceAbove", "headingSpaceBelow"] },
  { id: "spacing", label: "Paragraphs and spacing", hint: "How paragraphs separate, and the rhythm between blocks", choices: ["paragraphStyle"], numbers: ["blockGap", "leading"] },
  { id: "bullets", label: "Bulleted lists", hint: "The marker in front of each item", choices: ["bulletStyle"], numbers: [] },
  { id: "numbered", label: "Numbered lists", hint: "How items are numbered, and how nested levels count", choices: ["orderedStyle"], numbers: [] },
  { id: "list-layout", label: "List layout", hint: "Marker colour, indent and the space between items", choices: ["markerColor"], numbers: ["listIndent", "listItemGap"] },
  { id: "tasks", label: "Task lists", hint: "The checkbox, and how a finished item reads", choices: ["taskStyle", "taskDone"], numbers: [] },
  { id: "tables", label: "Tables", hint: "Borders, the header row, density and width", choices: ["tableStyle", "tableHeader", "tableDensity", "tableWidth"], numbers: [] },
  { id: "quotes", label: "Blockquotes", hint: "Bar, panel, card or pull quote", choices: ["quoteStyle", "quoteAccent"], numbers: [] },
  { id: "code", label: "Code", hint: "Code blocks and inline code", choices: ["codeBlockStyle", "inlineCodeStyle"], numbers: [] },
  { id: "dividers", label: "Dividers", hint: "What a horizontal rule becomes", choices: ["dividerStyle"], numbers: [] },
  { id: "images", label: "Images", hint: "Corners, placement, frame and captions", choices: ["imageAlign", "imageFrame", "captionStyle"], numbers: ["imageRadius"] },
  { id: "links", label: "Links", hint: "How a link is marked in running text", choices: ["linkStyle"], numbers: [] },
];

export const MARKDOWN_STYLE_CHOICE_LABELS: { [K in MarkdownStyleChoiceKey]: { label: string; options: Record<(typeof MARKDOWN_STYLE_CHOICES)[K][number], string> } } = {
  headingScale: { label: "Size", options: { standard: "Standard", compact: "Compact", large: "Large", flat: "Flat" } },
  headingWeight: { label: "Weight", options: { bold: "Bold", medium: "Medium", light: "Light", heavy: "Heavy" } },
  headingCase: { label: "Case", options: { none: "As written", upper: "Uppercase", "upper-minor": "Uppercase minor", "small-caps": "Small caps" } },
  headingRule: { label: "Rule", options: { underline: "Underline", title: "Title only", short: "Short bar", none: "None" } },
  headingAlign: { label: "Alignment", options: { left: "Left", "center-title": "Centred title", center: "Centred" } },
  paragraphStyle: { label: "Paragraphs", options: { block: "Spaced", indented: "Indented", justified: "Justified" } },
  bulletStyle: { label: "Marker", options: { disc: "Disc", nested: "By level", dash: "Dash", square: "Square", hollow: "Circle", arrow: "Arrow" } },
  orderedStyle: { label: "Numbering", options: { decimal: "1.", paren: "1)", alpha: "a.", roman: "i.", outline: "1. a. i.", legal: "1.1.1" } },
  markerColor: { label: "Marker colour", options: { muted: "Muted", text: "Text", accent: "Link colour" } },
  taskStyle: { label: "Checkbox", options: { box: "Box", round: "Round", minimal: "Thin" } },
  taskDone: { label: "Finished items", options: { plain: "Unchanged", dim: "Dimmed", strike: "Struck through" } },
  tableStyle: { label: "Borders", options: { lines: "Row lines", grid: "Grid", zebra: "Zebra", minimal: "Minimal" } },
  tableHeader: { label: "Header", options: { caps: "Uppercase", bold: "Bold", filled: "Filled", plain: "Plain" } },
  tableDensity: { label: "Density", options: { comfortable: "Comfortable", compact: "Compact", roomy: "Roomy" } },
  tableWidth: { label: "Width", options: { auto: "Fit content", full: "Full width", centered: "Centred" } },
  quoteStyle: { label: "Style", options: { panel: "Panel", bar: "Bar", italic: "Italic", card: "Card", pull: "Pull quote" } },
  quoteAccent: { label: "Bar colour", options: { accent: "Accent", quiet: "Quiet", link: "Link colour", text: "Text" } },
  codeBlockStyle: { label: "Code blocks", options: { card: "Card", flat: "Flat", bordered: "Bordered", bar: "Side bar" } },
  inlineCodeStyle: { label: "Inline code", options: { chip: "Chip", flat: "Flat", bordered: "Bordered", plain: "Plain" } },
  dividerStyle: { label: "Divider", options: { line: "Line", short: "Short line", dotted: "Dotted", ornament: "Ornament", space: "Space only" } },
  imageAlign: { label: "Placement", options: { inline: "In line", center: "Centred" } },
  imageFrame: { label: "Frame", options: { none: "None", border: "Border", shadow: "Shadow" } },
  captionStyle: { label: "Captions", options: { inline: "Off", centered: "Centred", quiet: "Left, small" } },
  linkStyle: { label: "Links", options: { hover: "Underline on hover", underline: "Underlined", dotted: "Dotted", ink: "Text colour", plain: "No underline" } },
};

const times = (value: number) => `${value.toFixed(2)}×`;
const ems = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 2).replace(/0$/, "")} em`;

export const MARKDOWN_STYLE_NUMBER_LABELS: Record<MarkdownStyleNumberKey, { label: string; format: (value: number) => string }> = {
  headingSpaceAbove: { label: "Space above", format: times },
  headingSpaceBelow: { label: "Space below", format: times },
  blockGap: { label: "Space between blocks", format: times },
  leading: { label: "Line spacing", format: times },
  listIndent: { label: "Indent", format: ems },
  listItemGap: { label: "Space between items", format: ems },
  imageRadius: { label: "Corner radius", format: (value) => `${Math.round(value)} px` },
};

// ── CSS ─────────────────────────────────────────────────────────────────────

/**
 * The scope the app's own documents use: every `.markdown-body` except one
 * inside a `[data-md-style]` container, which carries a style of its own (a
 * preview in Settings, a pinned document on the web).
 */
export const MARKDOWN_STYLE_APP_SCOPE = ".markdown-body:not([data-md-style] .markdown-body)";

/** The scope for a document inside the container `<div data-md-style="key">`. `key` must come from code. */
export function markdownStyleContainerScope(key: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("A style scope key is lowercase letters, digits and hyphens.");
  return `[data-md-style="${key}"] .markdown-body`;
}

// A rule is its selectors, with `&` standing for the scope, and its declarations.
type Rule = readonly [selectors: string, declarations: string];
type RuleTable<K extends MarkdownStyleChoiceKey> = Record<(typeof MARKDOWN_STYLE_CHOICES)[K][number], readonly Rule[]>;

const HEADINGS = "& h1, & h2, & h3, & h4, & h5, & h6";
// A task list keeps its own markers and indent in both renderers: `.task-list-item`
// in rendered HTML, `ul[data-type="taskList"]` in the editor.
const BULLET_ITEM = 'ul:not([data-type="taskList"]) > li:not(.task-list-item)';
const HEADER_CELL = "& thead th, & tbody th";
const BODY_CELL = "& tbody td";
const INLINE_CODE = "& :not(pre) > code";
const LINK = '& a:not([data-doc-link="none"])';
const CHECKED = '& input[type="checkbox"]:checked, & .ProseMirror ul[data-type="taskList"] li > label input[type="checkbox"]:checked';
const DONE_ITEMS: readonly string[] = [
  "& .task-list-item:has(> input:checked)",
  "& .task-list-item:has(> p:first-child > input:checked)",
  '& ul[data-type="taskList"] > li[data-checked="true"] > div',
];
const PLAIN_HEADER = "text-transform: none; letter-spacing: 0; font-size: 1em";

const sizes = (h1: number, h2: number, h3: number, h4: number, rest?: number): readonly Rule[] => [
  ["& h1", `font-size: ${h1}em`],
  ["& h2", `font-size: ${h2}em`],
  ["& h3", `font-size: ${h3}em`],
  ["& h4", `font-size: ${h4}em`],
  ...(rest === undefined ? [] : ([["& h5, & h6", `font-size: ${rest}em`]] as Rule[])),
];
const weights = (h1: number, h2: number, rest: number): readonly Rule[] => [
  ["& h1", `font-weight: ${h1}`],
  ["& h2", `font-weight: ${h2}`],
  ["& h3, & h4, & h5, & h6", `font-weight: ${rest}`],
];
const doneItems = (declarations: string): readonly Rule[] => DONE_ITEMS.map((selector) => [selector, declarations] as const);

const CHOICE_RULES: { [K in MarkdownStyleChoiceKey]: RuleTable<K> } = {
  headingScale: {
    standard: [],
    compact: sizes(1.6, 1.3, 1.12, 1, 0.92),
    large: sizes(2.5, 1.8, 1.35, 1.15),
    flat: sizes(1.4, 1.2, 1.05, 1),
  },
  headingWeight: {
    bold: [],
    medium: weights(600, 600, 550),
    light: weights(400, 400, 500),
    heavy: weights(800, 750, 700),
  },
  headingCase: {
    none: [],
    upper: [[HEADINGS, "text-transform: uppercase; letter-spacing: 0.04em"]],
    "upper-minor": [["& h4, & h5, & h6", "text-transform: uppercase; letter-spacing: 0.08em"]],
    "small-caps": [[HEADINGS, "font-variant-caps: small-caps; letter-spacing: 0.03em"]],
  },
  headingRule: {
    underline: [],
    title: [["& h2", "border-bottom: none; padding-bottom: 0"]],
    short: [
      ["& h1, & h2", "border-bottom: none; padding-bottom: 0"],
      ["& h1::after, & h2::after", 'content: ""; display: block; width: 2.2em; height: 3px; margin-top: 0.35em; border-radius: 2px; background: var(--blue)'],
    ],
    none: [["& h1, & h2", "border-bottom: none; padding-bottom: 0"]],
  },
  headingAlign: {
    left: [],
    "center-title": [
      ["& h1", "text-align: center"],
      ["& h1::after", "margin-left: auto; margin-right: auto"],
    ],
    center: [
      ["& h1, & h2, & h3", "text-align: center"],
      ["& h1::after, & h2::after", "margin-left: auto; margin-right: auto"],
    ],
  },
  paragraphStyle: {
    block: [],
    indented: [
      ["& p", "margin-top: 0; margin-bottom: 0; text-indent: 1.5em"],
      // The first paragraph of a run starts flush, as a book sets it, and so
      // does anything inside a list, a quote or a table.
      ["& > p:first-child, & :is(h1, h2, h3, h4, h5, h6, hr, blockquote, pre, table, ul, ol, div) + p, & li p, & blockquote p, & td p, & th p", "text-indent: 0"],
      // With no gap of their own, paragraphs need air before whatever follows.
      ["& p + :is(h1, h2, h3, h4, h5, h6)", "margin-top: 1.6em"],
      ["& blockquote p + p", "margin-top: 0.5em"],
    ],
    justified: [["& p", "text-align: justify; hyphens: auto; -webkit-hyphens: auto"]],
  },
  bulletStyle: {
    disc: [],
    nested: [
      [`& ul ${BULLET_ITEM}`, "list-style-type: circle"],
      [`& ul ul ${BULLET_ITEM}`, "list-style-type: square"],
    ],
    dash: [[`& ${BULLET_ITEM}`, 'list-style-type: "\\2013\\2002"']],
    square: [[`& ${BULLET_ITEM}`, "list-style-type: square"]],
    hollow: [[`& ${BULLET_ITEM}`, "list-style-type: circle"]],
    arrow: [[`& ${BULLET_ITEM}`, 'list-style-type: "\\2192\\2002"']],
  },
  orderedStyle: {
    decimal: [],
    // The counter style is declared once, by markdownStyleCss.
    paren: [["& ol > li", "list-style-type: markie-paren"]],
    alpha: [["& ol > li", "list-style-type: lower-alpha"]],
    roman: [["& ol > li", "list-style-type: lower-roman"]],
    outline: [
      ["& ol ol > li", "list-style-type: lower-alpha"],
      ["& ol ol ol > li", "list-style-type: lower-roman"],
    ],
    legal: [
      ["& ol", "counter-reset: markie-ol"],
      ["& ol > li", "counter-increment: markie-ol"],
      ["& ol > li::marker", 'content: counters(markie-ol, ".") ". "'],
    ],
  },
  markerColor: {
    muted: [],
    text: [["& li::marker", "color: var(--foreground)"]],
    accent: [["& li::marker", "color: var(--blue)"]],
  },
  taskStyle: {
    box: [],
    round: [['& input[type="checkbox"]', "border-radius: 50%"]],
    minimal: [
      ['& input[type="checkbox"]', "border-width: 1.5px; border-color: var(--muted)"],
      [CHECKED, "background: transparent; border-color: var(--blue); color: var(--blue)"],
    ],
  },
  taskDone: {
    plain: [],
    dim: doneItems("color: var(--muted)"),
    strike: doneItems("color: var(--muted); text-decoration: line-through"),
  },
  tableStyle: {
    lines: [],
    grid: [[`${HEADER_CELL}, ${BODY_CELL}`, "border: 1px solid var(--doc-rule)"]],
    zebra: [
      [BODY_CELL, "border-bottom-color: transparent"],
      ["& tbody tr:nth-child(even)", "background: var(--surface)"],
    ],
    minimal: [
      [HEADER_CELL, "background: none; border-bottom: 1px solid var(--muted)"],
      [BODY_CELL, "border-bottom: none"],
      ["& tbody tr:hover", "background: none"],
    ],
  },
  tableHeader: {
    caps: [],
    bold: [[HEADER_CELL, `${PLAIN_HEADER}; font-weight: 650; color: var(--foreground); background: none`]],
    filled: [[HEADER_CELL, `${PLAIN_HEADER}; font-weight: 600; color: var(--foreground); background: var(--accent)`]],
    plain: [[HEADER_CELL, `${PLAIN_HEADER}; font-weight: 500; color: var(--muted); background: none`]],
  },
  tableDensity: {
    comfortable: [],
    compact: [
      [HEADER_CELL, "padding: 0.3em 0.65em"],
      [BODY_CELL, "padding: 0.28em 0.65em"],
    ],
    roomy: [
      [HEADER_CELL, "padding: 0.8em 1.2em"],
      [BODY_CELL, "padding: 0.75em 1.2em"],
    ],
  },
  tableWidth: {
    auto: [],
    full: [["& table", "display: table; width: 100%"]],
    centered: [["& table", "width: fit-content; margin-left: auto; margin-right: auto"]],
  },
  quoteStyle: {
    panel: [],
    bar: [["& blockquote", "background: none; border-radius: 0; padding: 0.1em 1em"]],
    italic: [["& blockquote", "background: none; border-radius: 0; padding: 0.1em 1.1em; font-style: italic; color: var(--foreground)"]],
    card: [["& blockquote", "border: 1px solid var(--doc-rule); border-radius: 8px; padding: 0.7em 1.1em"]],
    pull: [["& blockquote", "border-left: none; background: none; border-radius: 0; padding: 0.4em 2em; text-align: center; font-style: italic; font-size: 1.2em; line-height: 1.5; color: var(--foreground)"]],
  },
  quoteAccent: {
    accent: [],
    quiet: [["& blockquote", "border-left-color: var(--muted)"]],
    link: [["& blockquote", "border-left-color: var(--blue)"]],
    text: [["& blockquote", "border-left-color: var(--foreground)"]],
  },
  codeBlockStyle: {
    card: [],
    flat: [["& pre", "border: none; border-radius: 6px"]],
    bordered: [["& pre", "background: transparent !important"]],
    bar: [["& pre", "border: none; border-left: 3px solid var(--muted); border-radius: 0"]],
  },
  inlineCodeStyle: {
    chip: [],
    flat: [[INLINE_CODE, "border: none; color: var(--foreground)"]],
    bordered: [[INLINE_CODE, "background: none; color: var(--foreground)"]],
    plain: [[INLINE_CODE, "border: none; background: none; padding: 0"]],
  },
  dividerStyle: {
    line: [],
    short: [["& hr", "width: 22%; min-width: 4em; margin-left: auto; margin-right: auto"]],
    dotted: [["& hr", "height: 0; background: none; border-top: 2px dotted color-mix(in srgb, var(--muted) 60%, transparent)"]],
    ornament: [
      ["& hr", "height: auto; background: none; text-align: center; overflow: visible"],
      ["& hr::after", 'content: "\\2022\\2003\\2022\\2003\\2022"; color: var(--muted); font-size: 0.9em; line-height: 1'],
    ],
    space: [["& hr", "height: 0; background: none"]],
  },
  imageAlign: {
    inline: [],
    center: [["& > img, & p > img:only-child, & p > img:first-child:has(+ em:last-child), & p > img:first-child:has(+ br + em:last-child)", "display: block; margin-left: auto; margin-right: auto"]],
  },
  imageFrame: {
    none: [],
    border: [["& img", "border: 1px solid var(--doc-rule)"]],
    shadow: [["& img", "box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18)"]],
  },
  captionStyle: {
    inline: [],
    // Emphasis straight after a picture, in the same paragraph, is its caption.
    centered: [["& p > img + em, & p > img + br + em", "display: block; margin-top: -0.5em; text-align: center; font-size: 0.86em; color: var(--muted)"]],
    quiet: [["& p > img + em, & p > img + br + em", "display: block; margin-top: -0.5em; font-size: 0.86em; color: var(--muted)"]],
  },
  linkStyle: {
    hover: [],
    underline: [[LINK, "border-bottom: 1px solid color-mix(in srgb, var(--blue) 55%, transparent)"]],
    dotted: [[LINK, "border-bottom: 1px dotted var(--blue)"]],
    ink: [[LINK, "color: var(--foreground); border-bottom: 1px solid var(--blue)"]],
    plain: [
      [LINK, "border-bottom: none"],
    ],
  },
};

// Spacious's own heading margins, in em of each heading (globals.css).
const HEADING_SPACE: ReadonlyArray<readonly [selector: string, above: number, below: number]> = [
  ["& h1", 1.5, 0.6],
  ["& h2", 1.4, 0.5],
  ["& h3", 1.3, 0.4],
  ["& h4", 1.2, 0.4],
  ["& h5, & h6", 1, 0.3],
];

/** A number as CSS prints it: at most three decimals, no exponent, never NaN. */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 1000) / 1000);
}

function numberRules(style: ResolvedMarkdownStyle): Rule[] {
  const n = style.numbers;
  const defaults = MARKDOWN_STYLE_NUMBERS;
  const rules: Rule[] = [];
  if (n.leading !== defaults.leading.default) rules.push(["&", `line-height: calc(var(--doc-line-height, 1.75) * ${num(n.leading)})`]);
  if (n.blockGap !== defaults.blockGap.default) {
    const g = n.blockGap;
    rules.push(["& p", `margin-top: calc(var(--doc-paragraph-gap, 0.8em) * ${num(g)}); margin-bottom: calc(var(--doc-paragraph-gap, 0.8em) * ${num(g)})`]);
    rules.push(["& blockquote, & pre, & table, & img", `margin-top: ${num(g)}em; margin-bottom: ${num(g)}em`]);
    rules.push(["& ul, & ol", `margin-top: ${num(0.6 * g)}em; margin-bottom: ${num(0.6 * g)}em`]);
    rules.push(["& hr", `margin-top: ${num(2 * g)}em; margin-bottom: ${num(2 * g)}em`]);
    rules.push(["& blockquote p", "margin-top: 0.3em; margin-bottom: 0.3em"]);
  }
  if (n.headingSpaceAbove !== defaults.headingSpaceAbove.default) {
    for (const [selector, above] of HEADING_SPACE) rules.push([selector, `margin-top: ${num(above * n.headingSpaceAbove)}em`]);
    // globals.css starts a document flush with its title; keep that.
    rules.push(["& h1:first-child", "margin-top: 0"]);
  }
  if (n.headingSpaceBelow !== defaults.headingSpaceBelow.default) {
    for (const [selector, , below] of HEADING_SPACE) rules.push([selector, `margin-bottom: ${num(below * n.headingSpaceBelow)}em`]);
  }
  if (n.listIndent !== defaults.listIndent.default) {
    rules.push(['& ul:not([data-type="taskList"]), & ol', `padding-left: ${num(n.listIndent)}em`]);
    // A rendered task item is pulled back over its list's indent (globals.css).
    rules.push(["& .task-list-item", `margin-left: ${num(-(n.listIndent - 0.3))}em`]);
  }
  if (n.listItemGap !== defaults.listItemGap.default) rules.push(["& li", `margin-top: ${num(n.listItemGap)}em; margin-bottom: ${num(n.listItemGap)}em`]);
  if (n.imageRadius !== defaults.imageRadius.default) rules.push(["& img", `border-radius: ${num(n.imageRadius)}px`]);
  return rules;
}

// Numbers first, then choices in this order, so a choice that sets the same
// property as a number or an earlier choice (indented paragraphs over the
// block gap, a table header over a table's borders) is the one that holds.
const CHOICE_ORDER: readonly MarkdownStyleChoiceKey[] = [
  "headingScale", "headingWeight", "headingCase", "headingRule", "headingAlign",
  "paragraphStyle",
  "bulletStyle", "orderedStyle", "markerColor",
  "taskStyle", "taskDone",
  "tableStyle", "tableHeader", "tableDensity", "tableWidth",
  "quoteAccent", "quoteStyle",
  "codeBlockStyle", "inlineCodeStyle",
  "dividerStyle",
  "imageAlign", "imageFrame", "captionStyle",
  "linkStyle",
];

const PAREN_COUNTER = '@counter-style markie-paren { system: extends decimal; suffix: ") "; }';

/**
 * The stylesheet that turns Spacious into `style`, for documents matching
 * `scope`. Empty for Spacious. `scope` is a selector written in code (one of
 * the two above, or `.markdown-body` for a standalone exported page); `style`
 * may be anything and is cleaned here.
 */
export function markdownStyleCss(style: unknown, scope: string = MARKDOWN_STYLE_APP_SCOPE): string {
  const resolved = resolveMarkdownStyle(style);
  const rules: Rule[] = numberRules(resolved);
  for (const key of CHOICE_ORDER) {
    const table = CHOICE_RULES[key] as Record<string, readonly Rule[]>;
    rules.push(...(table[resolved.choices[key]] ?? []));
  }
  if (rules.length === 0) return "";
  const lines = rules.map(([selectors, declarations]) => `${selectors.replaceAll("&", scope)} { ${declarations}; }`);
  if (resolved.choices.orderedStyle === "paren") lines.unshift(PAREN_COUNTER);
  return lines.join("\n");
}

// ── Painting the app ────────────────────────────────────────────────────────

export const MARKDOWN_STYLE_APPLIED_EVENT = "markie:markdown-style-applied";

let painted: MarkdownStyle = { base: "spacious" };

/**
 * The style on screen right now: the account's own, or the one pinned to the
 * open document. An export reads this, so the file is drawn the way the
 * document is being read.
 */
export function paintedMarkdownStyle(): MarkdownStyle {
  return painted;
}
const STYLE_ELEMENT_ID = "markie-markdown-style";

/**
 * Paints `style` on every document in the app. Spacious removes the
 * stylesheet altogether, which leaves the page exactly as it is without this
 * feature.
 */
export function applyMarkdownStyle(style: unknown): void {
  painted = canonicalMarkdownStyle(style);
  // No page to paint (a worker, a test with a stand-in document): the style is
  // still remembered above, so an export made there draws it.
  if (typeof document === "undefined" || typeof document.getElementById !== "function" || !document.head) return;
  const css = markdownStyleCss(style);
  let element = document.getElementById(STYLE_ELEMENT_ID);
  if (!css) {
    element?.remove();
  } else {
    if (!element) {
      element = document.createElement("style");
      element.id = STYLE_ELEMENT_ID;
      document.head.appendChild(element);
    }
    if (element.textContent !== css) element.textContent = css;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MARKDOWN_STYLE_APPLIED_EVENT, { detail: { style: canonicalMarkdownStyle(style) } }));
  }
}

// ── The account's store ─────────────────────────────────────────────────────
//
// It rides inside the theme store (theme.ts ThemeStore.markdownStyle), so it
// syncs with the account by the path themes already use. These are the pure
// transitions; the caller saves and paints.

export const EMPTY_MARKDOWN_STYLE_STORE: MarkdownStyleStore = { activeId: "spacious", profiles: [] };

/** The style store inside a theme store, or the empty one. Cleaned on the way out. */
export function markdownStyleStoreOf(themeStore: { markdownStyle?: unknown } | null | undefined): MarkdownStyleStore {
  return sanitizeMarkdownStyleStore(themeStore?.markdownStyle) ?? { ...EMPTY_MARKDOWN_STYLE_STORE };
}

/** What the active id names, before any unsaved edits. */
export function savedMarkdownStyle(store: MarkdownStyleStore): MarkdownStyle {
  const profile = store.profiles.find((entry) => entry.id === store.activeId);
  if (profile) return canonicalMarkdownStyle({ ...profile.style, name: profile.name });
  const preset = findMarkdownStylePreset(store.activeId) ?? MARKDOWN_STYLE_PRESETS[0];
  return { base: preset.id, name: preset.name };
}

/** True when there are edits on top of the active style that are not saved. */
export function markdownStyleEdited(store: MarkdownStyleStore): boolean {
  return !!store.draft && !sameMarkdownStyle(store.draft, savedMarkdownStyle(store));
}

/** The style being drawn: the unsaved edits when there are any, the saved one otherwise. */
export function activeMarkdownStyle(store: MarkdownStyleStore): MarkdownStyle {
  const saved = savedMarkdownStyle(store);
  if (!markdownStyleEdited(store)) return saved;
  return { ...canonicalMarkdownStyle(store.draft), name: `${saved.name} (edited)` };
}

/** What to call the active style: "Spacious", "My notes", or "Spacious (edited)". */
export function activeMarkdownStyleName(store: MarkdownStyleStore): string {
  return activeMarkdownStyle(store).name ?? "Spacious";
}

export function chooseMarkdownStyle(store: MarkdownStyleStore, id: string): MarkdownStyleStore {
  const known = MARKDOWN_STYLE_PRESET_IDS.includes(id as MarkdownStylePresetId) || store.profiles.some((entry) => entry.id === id);
  return known ? { activeId: id, profiles: store.profiles } : store;
}

function withDraft(store: MarkdownStyleStore, draft: MarkdownStyle): MarkdownStyleStore {
  const next: MarkdownStyleStore = { activeId: store.activeId, profiles: store.profiles };
  const clean = canonicalMarkdownStyle({ ...draft, name: undefined });
  if (!sameMarkdownStyle(clean, savedMarkdownStyle(next))) next.draft = clean;
  return next;
}

/** Change some choices or numbers of the style being drawn. The result is an unsaved edit. */
export function editMarkdownStyle(store: MarkdownStyleStore, patch: { choices?: MarkdownStyleChoices; numbers?: MarkdownStyleNumbers }): MarkdownStyleStore {
  const current = activeMarkdownStyle(store);
  return withDraft(store, {
    base: current.base,
    choices: { ...current.choices, ...patch.choices },
    numbers: { ...current.numbers, ...patch.numbers },
  });
}

/** True when the style being drawn differs from its preset anywhere in this group. */
export function markdownStyleGroupChanged(style: unknown, group: MarkdownStyleGroup): boolean {
  const canonical = canonicalMarkdownStyle(style);
  return group.choices.some((key) => canonical.choices?.[key] !== undefined) || group.numbers.some((key) => canonical.numbers?.[key] !== undefined);
}

/** Put one element back to what the style's preset draws. */
export function resetMarkdownStyleGroup(store: MarkdownStyleStore, group: MarkdownStyleGroup): MarkdownStyleStore {
  const current = canonicalMarkdownStyle(activeMarkdownStyle(store));
  const choices = { ...current.choices } as Record<string, string>;
  const numbers = { ...current.numbers } as Record<string, number>;
  for (const key of group.choices) delete choices[key];
  for (const key of group.numbers) delete numbers[key];
  return withDraft(store, { base: current.base, choices: choices as MarkdownStyleChoices, numbers: numbers as MarkdownStyleNumbers });
}

export function discardMarkdownStyleDraft(store: MarkdownStyleStore): MarkdownStyleStore {
  return { activeId: store.activeId, profiles: store.profiles };
}

/** A new profile id. `taken` are the ids in use; `seed` makes it stable in tests. */
export function newMarkdownStyleProfileId(taken: readonly string[], seed: number = Date.now()): string {
  let id = `style-${seed.toString(36)}`;
  for (let n = 2; taken.includes(id) || !isMarkdownStyleProfileId(id); n += 1) id = `style-${seed.toString(36)}-${n}`;
  return id;
}

function uniqueName(store: MarkdownStyleStore, wanted: string, exceptId?: string): string {
  const taken = new Set([...MARKDOWN_STYLE_PRESETS.map((preset) => preset.name), ...store.profiles.filter((entry) => entry.id !== exceptId).map((entry) => entry.name)].map((name) => name.toLowerCase()));
  const base = cleanMarkdownStyleName(wanted, "My style");
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = cleanMarkdownStyleName(`${base} ${n}`, base);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Save the style being drawn as a new named profile, and make it the active one. */
export function saveMarkdownStyleAs(store: MarkdownStyleStore, name: string, id: string): MarkdownStyleStore {
  if (!isMarkdownStyleProfileId(id) || store.profiles.some((entry) => entry.id === id)) return store;
  const finalName = uniqueName(store, name);
  const style = canonicalMarkdownStyle({ ...activeMarkdownStyle(store), name: finalName });
  return { activeId: id, profiles: [...store.profiles, { id, name: finalName, style }] };
}

/** Write the unsaved edits into the active profile. A preset cannot be overwritten. */
export function saveMarkdownStyleEdits(store: MarkdownStyleStore): MarkdownStyleStore {
  const profile = store.profiles.find((entry) => entry.id === store.activeId);
  if (!profile || !markdownStyleEdited(store)) return store;
  const style = canonicalMarkdownStyle({ ...store.draft, name: profile.name });
  return { activeId: store.activeId, profiles: store.profiles.map((entry) => (entry.id === profile.id ? { ...entry, style } : entry)) };
}

/** A copy of a preset or a profile, as a new profile. It does not become active. */
export function duplicateMarkdownStyle(store: MarkdownStyleStore, sourceId: string, id: string): MarkdownStyleStore {
  if (!isMarkdownStyleProfileId(id) || store.profiles.some((entry) => entry.id === id)) return store;
  const profile = store.profiles.find((entry) => entry.id === sourceId);
  const preset = findMarkdownStylePreset(sourceId);
  if (!profile && !preset) return store;
  const name = uniqueName(store, `${profile?.name ?? preset!.name} copy`);
  const style = canonicalMarkdownStyle({ ...(profile ? profile.style : { base: preset!.id }), name });
  return { ...store, profiles: [...store.profiles, { id, name, style }] };
}

export function renameMarkdownStyle(store: MarkdownStyleStore, id: string, name: string): MarkdownStyleStore {
  if (!store.profiles.some((entry) => entry.id === id)) return store;
  const finalName = uniqueName(store, name, id);
  return { ...store, profiles: store.profiles.map((entry) => (entry.id === id ? { ...entry, name: finalName, style: { ...entry.style, name: finalName } } : entry)) };
}

/** Remove a profile. If it was the active one, the preset it was built on takes over. */
export function deleteMarkdownStyle(store: MarkdownStyleStore, id: string): MarkdownStyleStore {
  const profile = store.profiles.find((entry) => entry.id === id);
  if (!profile) return store;
  const profiles = store.profiles.filter((entry) => entry.id !== id);
  if (store.activeId !== id) return { ...store, profiles };
  return { activeId: profile.style.base, profiles };
}

/** The style a document is pinned with, as it is sent to the server. */
export function pinnableMarkdownStyle(store: MarkdownStyleStore): MarkdownStyle {
  return canonicalMarkdownStyle(activeMarkdownStyle(store));
}
