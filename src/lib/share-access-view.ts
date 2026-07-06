import type { ShareAccess } from "./auth-client";

export interface ShareCapabilityView {
  label: "Read" | "Comment" | "Edit" | "Manage";
  enabled: boolean;
}

export function shareRoleLabel(access: ShareAccess | null, checking = false): string {
  if (!access) return checking ? "Checking access" : "Access unavailable";
  if (access.role === "owner") return "Owner";
  if (access.role === "editor") return "Editor";
  return "Viewer";
}

export function shareCapabilityView(access: ShareAccess | null): ShareCapabilityView[] {
  return [
    { label: "Read", enabled: !!access?.canRead },
    { label: "Comment", enabled: !!access?.canEdit },
    { label: "Edit", enabled: !!access?.canEdit },
    { label: "Manage", enabled: !!access?.canManage },
  ];
}

export function shareAccessLine(access: ShareAccess | null, checking = false): string {
  if (!access) {
    return checking
      ? "Checking server access..."
      : "Access details could not be loaded. Sign in again or check your connection before changing sharing.";
  }
  if (access.canManage) return "Can invite people, remove access, publish links, pin the doc theme, edit, and comment.";
  if (access.canEdit) return "Can edit and comment; owner-only controls stay locked.";
  return "Can view only; commenting, editing, and owner controls stay locked.";
}

export function shareMembersEmptyLine(access: ShareAccess | null): string {
  if (!access) return "People with access could not be loaded.";
  if (access.canManage) return "Not shared with anyone yet.";
  return "No other joined collaborators are visible yet.";
}

export function sharePublicLinkUnavailableLine(access: ShareAccess | null): string {
  if (!access) return "Public-link status could not be loaded.";
  return access.canManage
    ? "Create a public link when this doc is ready to share outside Markie."
    : "Only the owner can create a public link.";
}
