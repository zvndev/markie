import { describe, expect, it } from "vitest";
import type { ShareAccess } from "./auth-client";
import { shareAccessLine, shareCapabilityView, shareRoleLabel } from "./share-access-view";

const access = (role: ShareAccess["role"]): ShareAccess => ({
  role,
  canRead: true,
  canEdit: role === "owner" || role === "editor",
  canManage: role === "owner",
});

describe("share access view", () => {
  it("labels the server-derived role", () => {
    expect(shareRoleLabel(access("owner"))).toBe("Owner");
    expect(shareRoleLabel(access("editor"))).toBe("Editor");
    expect(shareRoleLabel(access("viewer"))).toBe("Viewer");
    expect(shareRoleLabel(null)).toBe("Checking access");
  });

  it("maps owner permissions to read, edit, and manage", () => {
    expect(shareCapabilityView(access("owner"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Edit", enabled: true },
      { label: "Manage", enabled: true },
    ]);
    expect(shareAccessLine(access("owner"))).toMatch(/invite people/);
  });

  it("maps editor permissions without owner management", () => {
    expect(shareCapabilityView(access("editor"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Edit", enabled: true },
      { label: "Manage", enabled: false },
    ]);
    expect(shareAccessLine(access("editor"))).toMatch(/owner-only controls/);
  });

  it("maps viewer permissions as read-only", () => {
    expect(shareCapabilityView(access("viewer"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Edit", enabled: false },
      { label: "Manage", enabled: false },
    ]);
    expect(shareAccessLine(access("viewer"))).toMatch(/editing and owner controls/);
  });
});
