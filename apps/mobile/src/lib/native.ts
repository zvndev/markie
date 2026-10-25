// Thin wrappers over the device: haptics, the share sheet, the browser and the
// status bar. Each one is a no-op (or the web equivalent) in a desktop browser,
// so the app runs under `npm run dev` too.
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Share } from "@capacitor/share";
import type { Tone } from "./theme-mode";

const native = () => Capacitor.isNativePlatform();

export const haptics = {
  tap(): void {
    if (native()) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
  },
  selection(): void {
    if (native()) void Haptics.selectionChanged().catch(() => undefined);
  },
  success(): void {
    if (native()) void Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);
  },
};

/** The system share sheet with the document's link. Returns false when the person dismissed it. */
export async function shareLink(title: string, url: string): Promise<boolean> {
  try {
    if (native()) {
      await Share.share({ title, url, dialogTitle: "Share link" });
      return true;
    }
    if (navigator.share) {
      await navigator.share({ title, url });
      return true;
    }
    await navigator.clipboard?.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/** An ordinary web link: the system's browser, never a Markie web view. */
export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  if (native()) await Browser.open({ url: parsed.href, presentationStyle: "popover" });
  else window.open(parsed.href, "_blank", "noopener,noreferrer");
}

/** mailto: and tel: go to the system, which picks the right app. */
export function openSystemUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "mailto:" && parsed.protocol !== "tel:") return;
  window.location.href = parsed.href;
}

export function setSystemBars(tone: Tone): void {
  if (!native()) return;
  void SystemBars.setStyle({ style: tone === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
}

export function platformName(): "ios" | "android" | "web" {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : "web";
}
