// The frame a compiled Darkmown preview runs in, shared by every host that
// shows one (the desktop editor, the mobile app), so the sandbox cannot drift
// between them.
//
// A trusted preview may run the pinned interpreter and nothing else: scripts,
// with no same-origin, forms, popups, navigation or storage. An untrusted
// preview gets an empty sandbox, which runs no script at all. The srcdoc's own
// CSP (preview.ts) is the second wall: it names only the interpreter's hashes.

export const DARKMOWN_THEME_MESSAGE = "markie:preview-theme";

export function darkmownFrameSandbox(trusted: boolean): string {
  return trusted ? "allow-scripts" : "";
}

/**
 * The one message a host sends into a running frame: a literal light or dark.
 * One-way by design; the frame has no channel back.
 */
export function projectDarkmownTheme(frame: HTMLIFrameElement | null | undefined, theme: "light" | "dark"): void {
  frame?.contentWindow?.postMessage({ type: DARKMOWN_THEME_MESSAGE, theme: theme === "dark" ? "dark" : "light" }, "*");
}
