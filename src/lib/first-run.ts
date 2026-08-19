// Whether this launch is someone's first look at Markie.
//
// Markie is the default handler for .md on most machines that install it, so
// the overwhelmingly common launch is "the OS handed us a file". That launch
// must go straight to the file: a welcome document in its place is a bug, not
// an introduction. Only a cold launch with nothing to open gets the welcome,
// and only once.

const SEEN_KEY = "markie.seen.v1";

export interface FirstRunStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface FirstRunOptions {
  storage?: FirstRunStorage | null;
  openedFile?: boolean;
}

function defaultStorage(): FirstRunStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(opts?: FirstRunOptions): FirstRunStorage | null {
  return opts && "storage" in opts ? opts.storage ?? null : defaultStorage();
}

export function shouldShowWelcome(opts?: FirstRunOptions): boolean {
  if (opts?.openedFile) return false;
  const storage = resolveStorage(opts);
  // No storage to read means we cannot prove they've seen it. Guessing "seen"
  // would silently delete onboarding for everyone whose storage is unavailable;
  // guessing "not seen" costs at most one extra document.
  if (!storage) return true;
  try {
    return storage.getItem(SEEN_KEY) === null;
  } catch {
    return true;
  }
}

export function markWelcomeSeen(opts?: FirstRunOptions): void {
  const storage = resolveStorage(opts);
  if (!storage) return;
  try {
    storage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    // Storage unavailable. The cost is showing the welcome doc again, which is
    // not worth failing a launch over.
  }
}
