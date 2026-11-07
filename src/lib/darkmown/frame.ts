// The frame a compiled Darkmown preview runs in, shared by every host that
// shows one (the desktop editor, the mobile app), so the sandbox cannot drift
// between them.
//
// A trusted preview may run the pinned interpreter and nothing else: scripts,
// with no same-origin, forms, popups, navigation or storage. An untrusted
// preview gets an empty sandbox, which runs no script at all. The srcdoc's own
// CSP (preview.ts) is the second wall: it names only the interpreter's hashes.
//
// The desktop editor can opt in to links (super-nightly). Then even an
// untrusted preview runs one script, the pinned link bridge, and nothing else:
// its CSP names only that hash. Links still never navigate the frame: each one
// opens a new window, which this sandbox refuses because it never grants
// allow-popups. The bridge posts a real click's href to the host instead, and
// darkmownLinkFromMessage below decides whether the host believes it.

import { darkmownLinkTarget } from "./links";

export const DARKMOWN_THEME_MESSAGE = "markie:preview-theme";
export const DARKMOWN_LINK_MESSAGE = "markie:wd-link";

export function darkmownFrameSandbox(trusted: boolean, { links = false }: { links?: boolean } = {}): string {
  return trusted || links ? "allow-scripts" : "";
}

/**
 * The one message a host sends into a running frame: a literal light or dark.
 * One-way by design; the frame has no channel back.
 */
export function projectDarkmownTheme(frame: HTMLIFrameElement | null | undefined, theme: "light" | "dark"): void {
  frame?.contentWindow?.postMessage({ type: DARKMOWN_THEME_MESSAGE, theme: theme === "dark" ? "dark" : "light" }, "*");
}

/**
 * The link to open for a message from a preview frame, or null.
 *
 * Believed only when it comes from this exact frame's window, from an opaque
 * origin, in exactly the bridge's shape, while the page holds the transient
 * activation a real click in the frame gives it, and when the href is a web
 * page or a mail draft. Main checks the href again before opening it.
 */
export function darkmownLinkFromMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frame: HTMLIFrameElement | null | undefined,
  activation: Pick<UserActivation, "isActive"> | undefined = typeof navigator === "undefined" ? undefined : navigator.userActivation,
): string | null {
  const source = frame?.contentWindow;
  if (!source || event.source !== source || event.origin !== "null") return null;
  const data: unknown = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("href")) return null;
  const message = data as { type: unknown; href: unknown };
  if (message.type !== DARKMOWN_LINK_MESSAGE || typeof message.href !== "string") return null;
  // A click in a child frame activates its ancestors too. No activation, no
  // click: a frame cannot open a link on its own schedule.
  if (activation?.isActive !== true) return null;
  return darkmownLinkTarget(message.href);
}
