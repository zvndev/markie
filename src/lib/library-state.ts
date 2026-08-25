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
