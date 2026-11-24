// The bundled font files, as this build serves them.
//
// Vite gives each woff2 under src/assets/fonts a hashed URL beside the rest of
// the build: app://markie/assets on the desktop, /app/assets on the server
// (served with a year's immutable cache, and already inside the page policy's
// font-src 'self'), and inside the app bundle on the phone. Nothing is fetched
// from anywhere else.
//
// The rules are written once per page. A browser only downloads a face when
// some text is actually set in it, so declaring all of them costs nothing.
import { BUNDLED_FAMILIES, fontFaceRules, type BundledFamily } from "./registry";

const urls = import.meta.glob<string>("../../assets/fonts/*/*.woff2", { eager: true, query: "?url", import: "default" });

// Each family's own license text ships in the build beside its files.
const licenses = import.meta.glob<string>("../../assets/fonts/*/LICENSE.txt", { eager: true, query: "?url", import: "default" });

/** The URL this build serves a bundled family's license text from. */
export function bundledFontLicenseUrl(licenseFile: string): string | undefined {
  return licenses[`../../assets/fonts/${licenseFile}`];
}

/** The URL this build serves a bundled font file from. */
export function bundledFontUrl(file: string): string | undefined {
  return urls[`../../assets/fonts/${file}`];
}

const STYLE_ID = "markie-bundled-fonts";

// Document code is set in the theme's code font only while one is chosen
// (code-font.ts sets the attribute), so the stylesheet's own rule, and how
// everything looked before, stays in charge otherwise.
// Ligatures off: JetBrains Mono and Fira Code would otherwise draw != as a
// single not-equal sign, and code should show the characters that were typed.
const CODE_RULE =
  ":root[data-doc-code-font] .markdown-body :is(code, pre, kbd, samp){font-family:var(--doc-code-family),ui-monospace,monospace;font-variant-ligatures:none}";

/** Declares every bundled face on the page. Safe to call more than once. */
export function installBundledFonts(target: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!target || target.getElementById(STYLE_ID)) return;
  const style = target.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${fontFaceRules(bundledFontUrl)}\n${CODE_RULE}`;
  target.head.appendChild(style);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** A font's bytes as a data: URL an exported file can carry. */
export function fontDataUrl(bytes: Uint8Array, type = "font/woff2"): string {
  return `data:${type};base64,${base64(bytes)}`;
}

const inlined = new Map<string, Promise<string | undefined>>();

function inlineFile(file: string): Promise<string | undefined> {
  let pending = inlined.get(file);
  if (!pending) {
    const url = bundledFontUrl(file);
    pending = url
      ? fetch(url).then(async (response) => (response.ok ? fontDataUrl(new Uint8Array(await response.arrayBuffer())) : undefined)).catch(() => undefined)
      : Promise.resolve(undefined);
    inlined.set(file, pending);
  }
  return pending;
}

/**
 * The @font-face rules for some families with the files inside them, for a
 * page that has no build beside it: an exported HTML file, the PDF window. A
 * file that cannot be read is left out, and the text falls back down its stack.
 */
export async function inlineFontFaceRules(families: readonly BundledFamily[] = BUNDLED_FAMILIES): Promise<string> {
  const files = families.flatMap((family) => family.files.map((file) => file.file));
  const data = new Map(await Promise.all(files.map(async (file) => [file, await inlineFile(file)] as const)));
  return fontFaceRules((file) => data.get(file), families);
}
