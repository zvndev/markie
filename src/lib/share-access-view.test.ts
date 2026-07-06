import { describe, expect, it } from "vitest";
import type { ShareAccess } from "./auth-client";
import {
  shareAccessLine,
  shareCapabilityView,
  shareMembersEmptyLine,
  sharePublicLinkUnavailableLine,
  shareRoleLabel,
} from "./share-access-view";

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
    expect(shareRoleLabel(null, true)).toBe("Checking access");
    expect(shareRoleLabel(null)).toBe("Access unavailable");
  });

  it("maps owner permissions to read, edit, and manage", () => {
    expect(shareCapabilityView(access("owner"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Comment", enabled: true },
      { label: "Edit", enabled: true },
      { label: "Manage", enabled: true },
    ]);
    expect(shareAccessLine(access("owner"))).toMatch(/edit, and comment/);
  });

  it("maps editor permissions without owner management", () => {
    expect(shareCapabilityView(access("editor"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Comment", enabled: true },
      { label: "Edit", enabled: true },
      { label: "Manage", enabled: false },
    ]);
    expect(shareAccessLine(access("editor"))).toMatch(/edit and comment/);
  });

  it("maps viewer permissions as read-only", () => {
    expect(shareCapabilityView(access("viewer"))).toEqual([
      { label: "Read", enabled: true },
      { label: "Comment", enabled: false },
      { label: "Edit", enabled: false },
      { label: "Manage", enabled: false },
    ]);
    expect(shareAccessLine(access("viewer"))).toBe(
      "Can view only; commenting, editing, and owner controls stay locked."
    );
  });

  it("separates checking and unavailable access copy", () => {
    expect(shareAccessLine(null, true)).toBe("Checking server access...");
    expect(shareAccessLine(null)).toBe(
      "Access details could not be loaded. Sign in again or check your connection before changing sharing."
    );
  });

  it("uses role-aware empty member copy", () => {
    expect(shareMembersEmptyLine(null)).toBe("People with access could not be loaded.");
    expect(shareMembersEmptyLine(access("owner"))).toBe("Not shared with anyone yet.");
    expect(shareMembersEmptyLine(access("editor"))).toBe(
      "No other joined collaborators are visible yet."
    );
    expect(shareMembersEmptyLine(access("viewer"))).toBe(
      "No other joined collaborators are visible yet."
    );
  });

  it("uses role-aware public link unavailable copy", () => {
    expect(sharePublicLinkUnavailableLine(null)).toBe(
      "Public-link status could not be loaded."
    );
    expect(sharePublicLinkUnavailableLine(access("owner"))).toBe(
      "Create a public link when this doc is ready to share outside Markie."
    );
    expect(sharePublicLinkUnavailableLine(access("viewer"))).toBe(
      "Only the owner can create a public link."
    );
  });
});
