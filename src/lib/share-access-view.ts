import type { ShareAccess } from "./auth-client";

export interface ShareCapabilityView {
  label: "Read" | "Comment" | "Edit" | "Manage";
  enabled: boolean;
}

export function shareRoleLabel(access: ShareAccess | null): string {
  if (!access) return "Checking access";
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

export function shareAccessLine(access: ShareAccess | null): string {
  if (!access) return "Checking server access…";
  if (access.canManage) return "Can invite people, remove access, publish links, pin the doc theme, edit, and comment.";
  if (access.canEdit) return "Can edit and comment; owner-only controls stay locked.";
  return "Can view only; commenting, editing, and owner controls stay locked.";
}
