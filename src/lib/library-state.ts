import type { ElectronAPI, LibraryItem } from "@/lib/electron";

type LibraryAPI = Pick<ElectronAPI, "libraryState">;

export interface LibrarySnapshot {
  signedIn: boolean;
  items: LibraryItem[];
  error: string | null;
}

export function libraryLoadErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  const detail = raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
  return `Library couldn't load: ${detail}`;
}

export async function readLibrarySnapshot(api: LibraryAPI): Promise<LibrarySnapshot> {
  try {
    const state = await api.libraryState();
    // Main answers `{ signedIn: false, items: [], error }` when the library
    // cannot be read, and safeApi folds a rejected invoke into `{ error }`.
    // Either way there is no list here, and callers map over `items`.
    if (!state || state.error || !Array.isArray(state.items)) {
      return {
        signedIn: false,
        items: [],
        error: libraryLoadErrorMessage(state?.error ?? "Unknown error"),
      };
    }
    return { signedIn: state.signedIn, items: state.items, error: null };
  } catch (error) {
    return { signedIn: false, items: [], error: libraryLoadErrorMessage(error) };
  }
}

// ── Which Library tab opens, and which shape the Files tab takes ──
//
// Files became the default in 0.5.0, because it now shows the user's work
// organized into projects rather than a workspace folder tree that is empty
// for most people. Flipping a default must not overrule anyone who chose the
// old one, so the key is versioned and the migration reads the v1 value: an
// explicit "recent" was a click, and absence was never a choice at all (Recent
// was already the default, so most people never touched the toggle).
export type LibTab = "recent" | "files";
export type FilesSubView = "projects" | "folders";

export const LIB_TAB_KEY = "markie.libtab.v2";
export const LIB_TAB_KEY_V1 = "markie.libtab.v1";
export const FILES_SUBVIEW_KEY = "markie.filesview.v1";

// localStorage throws outright in a private window or with site data blocked,
// and a preference that cannot be read is not worth an unmounted panel.
function safeRead(readKey: (key: string) => string | null, key: string): string | null {
  try {
    return readKey(key);
  } catch {
    return null;
  }
}

export function initialLibTab(readKey: (key: string) => string | null): LibTab {
  const v2 = safeRead(readKey, LIB_TAB_KEY);
  if (v2 === "recent" || v2 === "files") return v2;
  return safeRead(readKey, LIB_TAB_KEY_V1) === "recent" ? "recent" : "files";
}

// The folder tree is the only surface with new folder, rename and trash, so it
// stays one toggle away rather than being removed.
export function initialFilesSubView(
  readKey: (key: string) => string | null
): FilesSubView {
  return safeRead(readKey, FILES_SUBVIEW_KEY) === "folders" ? "folders" : "projects";
}
