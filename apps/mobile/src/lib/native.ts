// Thin wrappers over the device: haptics, the share sheet, the browser and the
// status bar. Each one is a no-op (or the web equivalent) in a desktop browser,
// so the app runs under `npm run dev` too.
import { Capacitor, SystemBars, SystemBarsStyle, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Share } from "@capacitor/share";
import type { ExportDevice, PrintJob } from "./export";
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

/**
 * An ordinary web link: the person's default browser, never a Markie web view
 * and never an in-app browser sheet (DESIGN.md, "Ordinary HTTP(S) links use
 * the device's default browser"). On a device the app's own web view is told
 * to go there, and Capacitor hands any top-level navigation off the app's
 * origin to the system instead of following it: UIApplication.open on iOS,
 * an ACTION_VIEW intent on Android. Either way the default browser opens it,
 * with none of the app's state.
 */
export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  if (native()) window.location.assign(parsed.href);
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

// ── Files for the share sheet (src/lib/export.ts) ────────────────────────
//
// An exported file lives in one folder of the app's cache, the only folder
// the Android FileProvider may hand to another app
// (android/app/src/main/res/xml/file_paths.xml). The cache is never in an
// iCloud or Android backup. A file is there only while the share sheet has
// it: export.ts removes it afterwards, and sweepShareFiles clears the folder
// at every launch, for a file left by a crash or by an app closed mid-share.
export const SHARE_FOLDER = "shared";

/**
 * The app's own PDF printer: ios/App/App/MarkiePdfPlugin.swift and
 * android/app/src/main/java/com/zvn/markie/mobile/MarkiePdfPlugin.java. It
 * loads a page in a web view nobody sees, prints it with the platform's own
 * web view printing, and writes the PDF into the app's cache.
 */
interface MarkiePdfPlugin {
  render(options: {
    html: string;
    /** Inside the cache folder. */
    path: string;
    /** PDF points. */
    pageWidth: number;
    pageHeight: number;
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
    /** #rrggbb */
    background: string;
  }): Promise<{ uri: string }>;
}
const MarkiePdf = registerPlugin<MarkiePdfPlugin>("MarkiePdf");

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Clears every exported file. Called at launch (main.tsx). */
export async function sweepShareFiles(): Promise<void> {
  if (!native()) return;
  await Filesystem.rmdir({ path: SHARE_FOLDER, directory: Directory.Cache, recursive: true }).catch(() => undefined);
}

export const exportDevice: ExportDevice = {
  get platform() { return platformName(); },

  async write(path, data) {
    const target = { path: `${SHARE_FOLDER}/${path}`, directory: Directory.Cache, recursive: true };
    const result = typeof data === "string"
      ? await Filesystem.writeFile({ ...target, data, encoding: Encoding.UTF8 })
      // No encoding: the plugin takes the data as base64 and writes the bytes.
      : await Filesystem.writeFile({ ...target, data: base64Of(data) });
    return result.uri;
  },

  async print(job: PrintJob, path) {
    const result = await MarkiePdf.render({
      html: job.html,
      path: `${SHARE_FOLDER}/${path}`,
      pageWidth: job.page.width,
      pageHeight: job.page.height,
      marginTop: job.margins.top,
      marginRight: job.margins.right,
      marginBottom: job.margins.bottom,
      marginLeft: job.margins.left,
      background: job.background,
    });
    return result.uri;
  },

  async share(uri, title) {
    try {
      await Share.share({ files: [uri], dialogTitle: title });
      return true;
    } catch (failure) {
      // Both platforms reject with "Share canceled" when the person backs out.
      if (/cancel/i.test(failure instanceof Error ? failure.message : String(failure))) return false;
      throw failure;
    }
  },

  async remove(folder) {
    await Filesystem.rmdir({ path: `${SHARE_FOLDER}/${folder}`, directory: Directory.Cache, recursive: true }).catch(() => undefined);
  },

  download(name, data, mimeType) {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  // The desktop's own browser fallback (src/lib/use-export.ts): the page in a
  // window of its own, and the browser's print dialog, where "Save as PDF" is.
  printWindow(html) {
    const popup = window.open("", "_blank");
    if (!popup) throw new Error("Allow a print window for Markie, then try again.");
    popup.document.write(html);
    popup.document.close();
    popup.onload = () => popup.print();
  },

  later(work, ms) {
    setTimeout(work, ms);
  },
};
