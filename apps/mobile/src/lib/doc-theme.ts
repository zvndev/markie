// The theme a document's owner pinned to it (server/src/themes.ts), for the
// reading screen. The desktop and the web page paint a member's whole window
// with it. The phone is more careful, because the tokens come from another
// account and the phone has its own light and dark:
//
//   - Type always follows the owner: body and heading face, line height, the
//     space between paragraphs, and their size relative to the default.
//   - Colours follow the owner only when their theme is the same tone the
//     phone is in. A dark theme is never painted into a light app (code
//     colours and the app's own chrome would not match it), so the reader's
//     own light or dark choice always wins.
//   - Every colour must be a plain colour. Anything else (a url(), a var(),
//     a gradient) drops the colours, never the document.
//
// The result is a set of CSS variables for the element around the article,
// so nothing outside the document changes.
import { adoptLocalTypefacesIn } from "@/lib/fonts/registry";
import { DEFAULT_TYPOGRAPHY, editorThemeForTokens, typographyVars, typographyOf, type ThemeTokens } from "@/lib/theme";
import { pinnedLookFrom, pinnedLookType, plainColor } from "@/lib/pinned-look";
import { markdownStyleCss, markdownStyleFontCss, markdownStyleFontTokens } from "@/lib/markdown-style";
import type { Tone } from "./theme-mode";

const SOLID_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// The colour check is shared with the web read view (src/lib/pinned-look.ts).
export { plainColor };

/** The pinned size against the desktop's default, held to a range a phone column can take. */
const MIN_SIZE_RATIO = 0.9;
const MAX_SIZE_RATIO = 1.35;

export interface DocThemeStyle {
  /** CSS custom properties for the element that wraps the article. */
  vars: Record<string, string>;
  /** True when the owner's colours are in `vars` too, so the wrapper paints its own background. */
  colors: boolean;
}

const REQUIRED = ["background", "surface", "surface2", "foreground", "muted", "border", "accent", "link"] as const;
const STATUS: Array<[keyof ThemeTokens, string, "foreground" | "link"]> = [
  ["statusGreen", "--status-green", "foreground"],
  ["statusYellow", "--status-yellow", "foreground"],
  ["statusRed", "--status-red", "foreground"],
  ["statusBlue", "--status-blue", "link"],
  ["statusPurple", "--status-purple", "foreground"],
];

/**
 * The selector a pinned Markdown style's rules are written for: the article
 * inside the themed wrapper, named strongly enough to hold over the phone's
 * own `.m-markdown` rules.
 */
export const DOC_STYLE_SCOPE = ".m-doc-themed.m-doc-themed .markdown-body.m-markdown";

/**
 * The rules for the Markdown style pinned beside a theme (how headings,
 * lists, tables and the rest are drawn), or "" for none. The style is cleaned
 * and the rules are looked up from the desktop's own tables
 * (src/lib/markdown-style.ts), so nothing the server sent is ever CSS.
 */
export function docStyleCss(style: unknown): string {
  // The code face is a rule of its own here. The text and heading faces reach
  // the article as custom properties, with the rest of the type (docLookTokens).
  const code = markdownStyleFontTokens(style).codeFont;
  const faces = code ? markdownStyleFontCss({ choices: { codeFont: code } }, DOC_STYLE_SCOPE) : "";
  return [faces, markdownStyleCss(style, DOC_STYLE_SCOPE)].filter(Boolean).join("\n");
}

/**
 * The pinned tokens with the pinned style's faces settled into them, for
 * docThemeStyle: the tokens' own body and heading faces stand, and the style
 * supplies what they do not name. Anything that is not a token set is
 * returned as it came.
 */
export function docLookTokens(tokens: unknown, style: unknown): unknown {
  const look = pinnedLookFrom({ tokens, style });
  if (!look) return tokens;
  return { ...(tokens as object), ...pinnedLookType(look) };
}

/** What of a pinned theme the reading screen uses, or null when there is nothing usable. */
export function docThemeStyle(tokens: unknown, tone: Tone): DocThemeStyle | null {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const raw = tokens as Partial<ThemeTokens>;
  const vars: Record<string, string> = {};

  // Type. typographyOf keeps faces to the desktop's own list and numbers in range.
  // A font from the owner's computer arrives as a local id; here it paints as
  // the bundled face that id names.
  adoptLocalTypefacesIn(raw);
  const type = typographyVars(raw);
  if (type["--doc-font-family"]) vars["--doc-font-family"] = type["--doc-font-family"];
  if (type["--doc-heading-family"]) vars["--doc-heading-family"] = type["--doc-heading-family"];
  vars["--doc-line-height"] = type["--doc-line-height"];
  vars["--doc-paragraph-gap"] = type["--doc-paragraph-gap"];
  const ratio = typographyOf(raw).fontSize / DEFAULT_TYPOGRAPHY.fontSize;
  vars["--m-doc-theme-scale"] = String(Math.round(Math.min(MAX_SIZE_RATIO, Math.max(MIN_SIZE_RATIO, ratio)) * 1000) / 1000);

  // Colours: all of them plain, and the same tone as the phone, or none.
  const colors: Record<string, string> = {};
  for (const name of REQUIRED) {
    const color = plainColor(raw[name]);
    if (!color) return { vars, colors: false };
    colors[name] = color;
  }
  // The tone is read from the background, which only a six-digit hex can say.
  if (!SOLID_HEX.test(colors.background) || editorThemeForTokens({ background: colors.background }) !== tone) return { vars, colors: false };
  vars["--background"] = colors.background;
  vars["--surface"] = colors.surface;
  vars["--surface-2"] = colors.surface2;
  vars["--foreground"] = colors.foreground;
  vars["--muted"] = colors.muted;
  vars["--border"] = colors.border;
  vars["--doc-rule"] = plainColor(raw.docRule) ?? `color-mix(in srgb, ${colors.border} 42%, ${colors.surface})`;
  vars["--accent"] = colors.accent;
  vars["--blue"] = colors.link;
  for (const [token, name, fallback] of STATUS) vars[name] = plainColor(raw[token]) ?? colors[fallback];
  return { vars, colors: true };
}
