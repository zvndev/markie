// The fonts an exported file carries.
//
// An exported HTML file, and the page a PDF is printed from, stand alone: no
// build beside them and no network. So the bundled fonts a document uses are
// written into the file as data: URLs, and the document is set in the same
// faces the screen shows.
//
// A theme on the system face adds nothing, so an export of the default look
// is what it always was.
import { HEADING_SAME_AS_BODY, loadThemeStore, findTheme, typefaceStack, typographyOf, THEME_APPLIED_EVENT, type ThemeTokens } from "@/lib/theme";
import { BUNDLED_FAMILIES, bundledFamiliesUsed, type BundledFamily } from "./registry";
import { inlineFontFaceRules } from "./bundled-fonts";
import { codeFontStack, loadCodeFont } from "./code-font";

// The tokens on screen right now: the person's own theme, or the look an owner
// pinned to the open document.
let painted: Partial<ThemeTokens> | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(THEME_APPLIED_EVENT, (event) => {
    painted = (event as CustomEvent<{ tokens?: Partial<ThemeTokens> }>).detail?.tokens ?? null;
  });
}

export function paintedThemeTokens(): Partial<ThemeTokens> {
  if (painted) return painted;
  const store = loadThemeStore();
  return findTheme(store, store.activeId).tokens;
}

// The app's own custom properties mean nothing in an exported file.
const SYSTEM_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const SYSTEM_MONO = "'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace";
function standalone(stack: string): string {
  return stack.replace(/var\(--font-geist-sans\)/g, SYSTEM_SANS).replace(/var\(--font-geist-mono\)/g, SYSTEM_MONO);
}

/** Bundled families a document's own inline font styles name. */
export function bundledFamiliesInHtml(html: string): BundledFamily[] {
  const styles = html.match(/font-family\s*:[^;"<>]{1,400}/gi) ?? [];
  if (!styles.length) return [];
  const named = styles.join("\n").toLowerCase();
  return BUNDLED_FAMILIES.filter((family) => named.includes(family.family.toLowerCase()));
}

export interface ExportFontChoice {
  bodyFont: string;
  headingFont: string;
  /** A monospace typeface id, or "" for the export's own. */
  codeFont: string;
}

/** The rules that set an exported document in the chosen faces. No font files. */
export function exportFontRules(choice: ExportFontChoice): string {
  const rules: string[] = [];
  if (choice.bodyFont !== "system") rules.push(`body,.markdown-body{font-family:${standalone(typefaceStack(choice.bodyFont))}}`);
  if (choice.headingFont !== HEADING_SAME_AS_BODY) {
    rules.push(`.markdown-body :is(h1,h2,h3,h4,h5,h6){font-family:${standalone(typefaceStack(choice.headingFont))}}`);
  }
  const code = codeFontStack(choice.codeFont);
  if (code) rules.push(`.markdown-body :is(code,pre,kbd,samp),.markdown-body pre code{font-family:${standalone(code)};font-variant-ligatures:none}`);
  return rules.join("\n");
}

/**
 * The stylesheet an export adds for fonts: the files, inside the sheet, for
 * every bundled face the theme or the document's own text uses, and the rules
 * that apply the theme's faces. Empty when there is nothing to add.
 */
export async function exportFontCss(html = "", tokens: Partial<ThemeTokens> = paintedThemeTokens(), codeFont: string = loadCodeFont()): Promise<string> {
  const type = typographyOf(tokens);
  const choice: ExportFontChoice = { bodyFont: type.bodyFont, headingFont: type.headingFont, codeFont };
  const used = new Set([...bundledFamiliesUsed([choice.bodyFont, choice.headingFont, choice.codeFont]), ...bundledFamiliesInHtml(html)]);
  const families = BUNDLED_FAMILIES.filter((family) => used.has(family));
  const faces = families.length ? await inlineFontFaceRules(families) : "";
  return [faces, exportFontRules(choice)].filter(Boolean).join("\n");
}
