// The system's text size: Dynamic Type on iOS, font scale on Android.
//
// A web view does not follow either on its own in a way the app can rely on,
// so the app reads the setting and applies it itself, the same way on both:
//
//   - What a person reads and writes (a document, the editors, comments)
//     follows the setting all the way, up to MAX_TEXT_SCALE.
//   - The app's own labels (bars, rows, buttons) follow it up to
//     MAX_CHROME_SCALE and no further, so a bar or a row of buttons never
//     outgrows a 360-point screen.
//
// Where the number comes from:
//   - iOS: the size WebKit gives `font: -apple-system-body`, which is the
//     Dynamic Type body size. 17px is the default setting.
//   - Android: the activity's font scale, from the app's own MarkieTextSize
//     plugin (TextSizePlugin.java). MainActivity pins the web view's own text
//     zoom to the chrome part, so nothing is scaled twice.
//
// How it is applied: `--m-text-scale` on the root is what content multiplies
// its size by (styles.css). The chrome part is the web view's whole-page text
// zoom: `-webkit-text-size-adjust` on iOS, WebSettings.setTextZoom on Android.
import { registerPlugin } from "@capacitor/core";

export const MIN_TEXT_SCALE = 0.85;
export const MAX_TEXT_SCALE = 2;
/** Keep in step with TextSizePlugin.MAX_CHROME_SCALE. */
export const MAX_CHROME_SCALE = 1.15;
/** The Dynamic Type body size at the default setting ("Large"), in points. */
const APPLE_DEFAULT_BODY = 17;

/** A usable scale from whatever was measured: 1 when it is not a number. */
export function clampTextScale(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.round(Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, value)) * 1000) / 1000;
}

/**
 * The whole-page part and what content multiplies on top of it. Their
 * product is always the clamped scale.
 */
export function splitTextScale(raw: unknown): { chrome: number; content: number } {
  const total = clampTextScale(raw);
  const chrome = Math.min(total, MAX_CHROME_SCALE);
  return { chrome, content: Math.round((total / chrome) * 1000) / 1000 };
}

/** iOS: Dynamic Type, read from the body text style. Null where WebKit has no such font. */
export function measureAppleScale(doc: Document = document): number | null {
  try {
    const probe = doc.createElement("span");
    // Its own size adjust, so the page's zoom is not measured back into it.
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body;-webkit-text-size-adjust:100%;";
    probe.textContent = "M";
    doc.body.appendChild(probe);
    const size = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return Number.isFinite(size) && size > 0 ? size / APPLE_DEFAULT_BODY : null;
  } catch {
    return null;
  }
}

/** Paints a scale. `pageZoom` is false where the native side already zoomed the page (Android). */
export function applyTextScale(raw: unknown, { pageZoom }: { pageZoom: boolean }, root: HTMLElement = document.documentElement): void {
  const { chrome, content } = splitTextScale(raw);
  root.style.setProperty("--m-text-scale", String(content));
  root.style.setProperty("--m-chrome-scale", String(chrome));
  if (pageZoom) {
    const percent = `${Math.round(chrome * 100)}%`;
    root.style.setProperty("-webkit-text-size-adjust", percent);
    root.style.setProperty("text-size-adjust", percent);
  }
}

interface TextSizePlugin {
  /** Android: the system font scale, 1 at the default. */
  get(): Promise<{ scale?: unknown }>;
}

const NativeTextSize = registerPlugin<TextSizePlugin>("MarkieTextSize");

/**
 * Reads the setting now and again whenever the app comes back to the front,
 * which is the only time it can have changed. In a desktop browser it does
 * nothing: the browser's own zoom is the reader's control there.
 */
export function startTextSize(platform: string, plugin: TextSizePlugin = NativeTextSize): () => void {
  if (platform !== "ios" && platform !== "android") return () => undefined;
  let stopped = false;
  const read = () => {
    if (platform === "ios") {
      const measured = measureAppleScale();
      if (measured !== null) applyTextScale(measured, { pageZoom: true });
      return;
    }
    void plugin.get().then((answer) => { if (!stopped) applyTextScale(answer?.scale, { pageZoom: false }); }).catch(() => undefined);
  };
  read();
  const onVisible = () => { if (document.visibilityState === "visible") read(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", read);
  window.addEventListener("pageshow", read);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", read);
    window.removeEventListener("pageshow", read);
  };
}
