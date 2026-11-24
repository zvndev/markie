// Fonts installed on this computer.
//
// Chromium's Local Font Access (window.queryLocalFonts) lists them: Electron
// has it on every desktop, and so does a Chromium browser on the web app. It
// is absent on the phone, in Safari and in Firefox, where nothing is offered.
// Only family names are read. No font file is opened, copied or uploaded.
import { localFontKind, localTypefaceId, type TypefaceKind } from "./registry";

export interface LocalFontFamily {
  family: string;
  kind: TypefaceKind;
  /** The id to store, or null when the name is one Markie will not store. */
  id: string | null;
}

interface LocalFontData { family: string }
type QueryLocalFonts = () => Promise<LocalFontData[]>;

function query(): QueryLocalFonts | undefined {
  const fn = typeof window === "undefined" ? undefined : (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  return typeof fn === "function" ? fn.bind(window) : undefined;
}

/** Whether this browser can list installed fonts at all. */
export function canListLocalFonts(): boolean {
  return !!query();
}

/** Family names as a font listing gives them, de-duplicated and sorted. */
export function familiesFrom(fonts: readonly { family?: unknown }[]): LocalFontFamily[] {
  const seen = new Map<string, LocalFontFamily>();
  for (const font of fonts) {
    const family = typeof font.family === "string" ? font.family.trim() : "";
    // A leading dot is how macOS names its private system faces.
    if (!family || family.startsWith(".") || seen.has(family.toLowerCase())) continue;
    const kind = localFontKind(family);
    seen.set(family.toLowerCase(), { family, kind, id: localTypefaceId(family, kind) });
  }
  return [...seen.values()].sort((a, b) => a.family.localeCompare(b.family));
}

let cached: LocalFontFamily[] | null = null;

/** The listing from earlier in this session, if there was one. */
export function knownLocalFonts(): LocalFontFamily[] | null {
  return cached;
}

/** Drops the session's listing, so the next one is read again. */
export function forgetLocalFonts(): void {
  cached = null;
}

/**
 * Lists the installed families. Call from a click: a browser asks the person
 * first, and only does so on a gesture. Rejects when they say no.
 */
export async function listLocalFonts(): Promise<LocalFontFamily[]> {
  const run = query();
  if (!run) return [];
  cached = familiesFrom(await run());
  return cached;
}

/**
 * The listing without ever asking: only when permission is already held, as
 * it is in the desktop app. Null when it is not.
 */
export async function listLocalFontsQuietly(): Promise<LocalFontFamily[] | null> {
  if (cached) return cached;
  if (!query()) return null;
  try {
    const status = await navigator.permissions.query({ name: "local-fonts" as PermissionName });
    if (status.state !== "granted") return null;
    return await listLocalFonts();
  } catch {
    return null;
  }
}
