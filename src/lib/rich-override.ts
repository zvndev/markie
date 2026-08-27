// The user's explicit "yes, normalize this document" consent, per document,
// per machine. localStorage on purpose: this is an editing preference, not
// document data, and it must survive restarts but need not sync.
const KEY = (path: string | null) =>
  `markie.richoverride.v1:${path ?? "untitled"}`;

export function richOverride(path: string | null): boolean {
  try {
    return window.localStorage.getItem(KEY(path)) === "1";
  } catch {
    return false;
  }
}

export function setRichOverride(path: string | null, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY(path), "1");
    else window.localStorage.removeItem(KEY(path));
  } catch {
    // storage unavailable: the choice lasts for the session via page state
  }
}
