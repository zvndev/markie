// The look an owner pinned to a document, as a reader's client may use it:
// theme tokens (colours and faces) and a Markdown style. Both come from
// another account by way of a server, so both are checked here before
// anything is painted. The style is cleaned by its own schema
// (markdown-style-schema.ts); this file holds the check for colours, which
// the phone has always made (apps/mobile/src/lib/doc-theme.ts) and the web
// read view now makes too.
import type { ThemeTokens } from "./theme";
import { sanitizeMarkdownStyle, type MarkdownStyle } from "./markdown-style-schema";
import { markdownStyleFontTokens } from "./markdown-style";

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d\s.,%/+-]|deg|turn|rad|none)+\)$/i;

/** A colour and nothing else: hex, or a colour function over plain numbers. */
export function plainColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 64) return null;
  return HEX.test(text) || FUNCTIONAL.test(text) ? text : null;
}

const REQUIRED = ["background", "surface", "surface2", "foreground", "muted", "border", "accent", "link"] as const;
const OPTIONAL = ["docRule", "statusGreen", "statusYellow", "statusRed", "statusBlue", "statusPurple"] as const;
const TYPE = ["fontSize", "contentWidth", "bodyFont", "headingFont", "codeFont", "lineHeight", "paragraphGap"] as const;

/**
 * Pinned tokens that are safe to hand to applyTheme: every colour a plain
 * colour, or null when a required one is not. Faces and numbers pass through
 * as they are, because applyTheme already holds them to its own lists and
 * ranges (theme.ts typographyOf).
 */
export function safePinnedTokens(raw: unknown): ThemeTokens | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of REQUIRED) {
    const color = plainColor(source[key]);
    if (!color) return null;
    out[key] = color;
  }
  for (const key of OPTIONAL) {
    const color = plainColor(source[key]);
    if (color) out[key] = color;
  }
  for (const key of TYPE) {
    const value = source[key];
    if ((typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out as unknown as ThemeTokens;
}

/** The type fields of some tokens, each a plain string or number. Their values are checked where they are painted. */
function typeOnly(raw: unknown): Partial<ThemeTokens> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of TYPE) {
      const value = (raw as Record<string, unknown>)[key];
      if ((typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    }
  }
  return out as Partial<ThemeTokens>;
}

/**
 * A pinned look, checked. `tokens` is null when the colours could not be
 * used; the style and the type still apply.
 */
export interface PinnedLook {
  tokens: ThemeTokens | null;
  /** The pinned faces and spacing alone, for a reader who takes the type but not the colours. */
  type: Partial<ThemeTokens>;
  style: MarkdownStyle | null;
}

/**
 * The faces a pinned look is read in, as theme tokens. The pinned tokens'
 * own body and heading faces come first: they are what the owner had on
 * screen. The style supplies whatever the tokens do not name, and the code
 * face, which only a style carries to every reader (a public link is handed
 * no token outside its checked list).
 */
function lookFonts(type: Partial<ThemeTokens>, style: MarkdownStyle | null): Partial<ThemeTokens> {
  const fromStyle = markdownStyleFontTokens(style);
  const fonts: Partial<ThemeTokens> = {};
  const bodyFont = type.bodyFont ?? fromStyle.bodyFont;
  const headingFont = type.headingFont ?? fromStyle.headingFont;
  const codeFont = fromStyle.codeFont ?? type.codeFont;
  if (bodyFont) fonts.bodyFont = bodyFont;
  if (headingFont) fonts.headingFont = headingFont;
  if (codeFont) fonts.codeFont = codeFont;
  return fonts;
}

/**
 * The whole look as one set of tokens to paint with applyTheme: the owner's
 * colours and spacing, in the faces lookFonts settles on. Null when the
 * colours could not be used.
 */
export function pinnedLookTokens(look: Pick<PinnedLook, "tokens" | "style"> & { type?: Partial<ThemeTokens> }): ThemeTokens | null {
  if (!look.tokens) return null;
  return { ...look.tokens, ...lookFonts(look.type ?? typeOnly(look.tokens), look.style) };
}

/** The look's type alone (faces, line height, paragraph spacing), for a reader who keeps their own colours. */
export function pinnedLookType(look: Pick<PinnedLook, "type" | "style">): Partial<ThemeTokens> {
  return { ...look.type, ...lookFonts(look.type, look.style) };
}

/** What a server's `{ tokens, style }` answer amounts to. Null when nothing is pinned. */
export function pinnedLookFrom(data: unknown): PinnedLook | null {
  if (!data || typeof data !== "object") return null;
  const { tokens, style } = data as { tokens?: unknown; style?: unknown };
  if (!tokens || typeof tokens !== "object") return null;
  return { tokens: safePinnedTokens(tokens), type: typeOnly(tokens), style: sanitizeMarkdownStyle(style) };
}
