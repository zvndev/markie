// What the current user may do with the open document, resolved once and read
// by everything that has to obey it: the rich pane, the source pane, the viewer
// banner, and the sync push gate. Each of those used to decide for itself, which
// is how the source pane came to disagree with the rich one.
//
// The renderer's copy of the role is never the authority. The server re-reads
// access on every collab message and refuses writes it does not like; this
// exists so the UI does not invite an edit that is going to be thrown away.
import type { ShareMember } from "./auth-client";

export type ShareRole = "owner" | "editor" | "viewer";

// "local": no cloud copy, or signed out. Nothing to enforce.
// "checking": the document has a cloud copy and the server has not answered yet.
// "unreachable": the server could not be asked and this document has no role we
//   ever proved. Distinct from "checking" because the wait is over: saying
//   "Checking your access…" forever would be a lie about a request that failed.
export type ShareRoleState = "local" | "checking" | "unreachable" | ShareRole;

export function roleFor(
  members: ShareMember[] | null | undefined,
  myUserId: string | null | undefined,
  ownerId: string | null | undefined
): ShareRole {
  // Owners are deliberately absent from the member list (server/src/shares.ts),
  // so ownership can only come from the id the server reported for this doc.
  if (myUserId && ownerId && myUserId === ownerId) return "owner";
  if (!myUserId || !Array.isArray(members)) return "viewer";
  const mine = members.find((m) => m.user_id === myUserId);
  // Only an explicit editor grant unlocks editing. A missing entry, a failed
  // request, or an unknown user means we could not prove the right to edit,
  // which is not the same as having it.
  return mine?.role === "editor" ? "editor" : "viewer";
}

export function canEditDoc(role: ShareRole): boolean {
  return role === "owner" || role === "editor";
}

export function isReadOnlyShare(role: ShareRole): boolean {
  return role === "viewer";
}

// Editability for the panes. "checking" is read-only on purpose: the collab
// config is null until membership resolves, and treating that as editable let a
// viewer type into a shared document during the resolution window.
export function canEditDocument(state: ShareRoleState): boolean {
  if (state === "local") return true;
  if (state === "checking" || state === "unreachable") return false;
  return canEditDoc(state);
}

export interface ShareBannerView {
  kind: "checking" | "unreachable" | "view-only";
  message: string;
}

// The strip above the document. It is the only thing on screen that explains
// why typing does nothing, so it is not dismissible and it is not an icon.
export function shareBannerFor(
  state: ShareRoleState,
  sharedBy: string | null
): ShareBannerView | null {
  if (state === "checking") {
    return { kind: "checking", message: "Checking your access…" };
  }
  if (state === "unreachable") {
    return {
      kind: "unreachable",
      message:
        "Can't reach the server, and this document's access was never confirmed on this machine. Read-only until it is.",
    };
  }
  if (state === "viewer") {
    return {
      kind: "view-only",
      message: sharedBy
        ? `Shared with you by ${sharedBy} · view only`
        : "Shared with you · view only",
    };
  }
  return null;
}
