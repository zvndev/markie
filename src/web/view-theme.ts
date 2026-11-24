// The look an owner pinned to a document, on its hosted page.
//
// Only its type is used here: the body and heading faces, the line height and
// the paragraph spacing, as custom properties on the document itself. The page
// around it keeps its own colours and chrome.
//
// The tokens were written by another account, so nothing in them is trusted.
// typographyVars keeps a font to an id the registry knows and a number to its
// range; a font from the owner's own computer arrives as a local id and paints
// as the bundled face that id names. A bundled face is loaded from this
// server's own /app/assets (src/lib/fonts/bundled-fonts.ts).
import { typographyVars, type ThemeTokens } from "@/lib/theme";
import { adoptLocalTypefacesIn } from "@/lib/fonts/registry";

const PAINTED = ["--doc-font-family", "--doc-heading-family", "--doc-line-height", "--doc-paragraph-gap"] as const;

/** The custom properties a pinned look sets on a hosted document, or null for none. */
export function pinnedTypeVars(tokens: unknown): Record<string, string> | null {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const raw = tokens as Partial<ThemeTokens>;
  adoptLocalTypefacesIn({ bodyFont: raw.bodyFont, headingFont: raw.headingFont });
  const type = typographyVars(raw);
  const vars: Record<string, string> = {};
  for (const name of PAINTED) if (type[name]) vars[name] = type[name];
  return vars;
}
