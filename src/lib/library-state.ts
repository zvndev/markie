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

// ── Which Library tab opens ──
//
// The Library is Recent and Folders now, one flat row, and that is the whole
// list. Projects used to be a third thing reached by a tab inside a tab: you
// picked Files, then picked Projects inside it, and the panel spent two rows
// of its width explaining where you were. Projects is its own destination in
// the left rail instead, so the nesting is gone rather than restyled.
export type LibTab = "recent" | "folders";

export const LIB_TAB_KEY = "markie.libtab.v3";
export const LIB_TAB_KEY_V2 = "markie.libtab.v2";
export const LIB_TAB_KEY_V1 = "markie.libtab.v1";
// Read only by the migration below. Nothing writes it any more.
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

// Nobody may be stranded on a tab that no longer exists, and nobody may be
// moved off one that does.
//
//   v2 "files" + subview "folders"  -> Folders. Same tab, same content, and
//                                      the only surface with new folder,
//                                      rename and trash. They keep it.
//   v2 "files" + subview "projects" -> Recent. The thing they chose moved out
//                                      of this panel entirely; the Library's
//                                      own default is the honest landing, and
//                                      Projects is one rail click away.
//   v2 "recent"                     -> Recent.
//   nothing stored                  -> Recent, which is what the Library is
//                                      for: what you had open lately.
export function initialLibTab(readKey: (key: string) => string | null): LibTab {
  const v3 = safeRead(readKey, LIB_TAB_KEY);
  if (v3 === "recent" || v3 === "folders") return v3;
  const v2 = safeRead(readKey, LIB_TAB_KEY_V2);
  if (v2 === "files") {
    return safeRead(readKey, FILES_SUBVIEW_KEY) === "folders" ? "folders" : "recent";
  }
  return "recent";
}
