import type { ShareAccess } from "./auth-client";

export interface ShareCapabilityView {
  label: "Read" | "Edit" | "Manage";
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
    { label: "Edit", enabled: !!access?.canEdit },
    { label: "Manage", enabled: !!access?.canManage },
  ];
}

export function shareAccessLine(access: ShareAccess | null): string {
  if (!access) return "Checking server access…";
  if (access.canManage) return "Can invite people, remove access, publish links, and pin the doc theme.";
  if (access.canEdit) return "Can edit the document; owner-only controls stay locked.";
  return "Can view and comment; editing and owner controls stay locked.";
}
