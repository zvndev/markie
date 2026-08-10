import { describe, expect, it } from "vitest";
import type { ShareMember } from "./auth-client";
import {
  canEditDoc,
  canEditDocument,
  isReadOnlyShare,
  roleFor,
  shareBannerFor,
} from "./share-role";

const member = (
  user_id: string | null,
  role: "viewer" | "editor"
): ShareMember => ({
  user_id,
  role,
  created_at: "2026-08-01T00:00:00.000Z",
  email: `${user_id ?? "pending"}@example.com`,
  name: null,
});

describe("roleFor", () => {
  it("resolves the owner from the id the server reported", () => {
    // Owners are deliberately absent from the member list, so the list alone
    // can never prove ownership.
    expect(roleFor([], "u1", "u1")).toBe("owner");
    expect(roleFor([member("u2", "editor")], "u1", "u1")).toBe("owner");
  });

  it("resolves an editor grant", () => {
    expect(roleFor([member("u1", "editor")], "u1", "owner-1")).toBe("editor");
  });

  it("resolves a viewer grant", () => {
    expect(roleFor([member("u1", "viewer")], "u1", "owner-1")).toBe("viewer");
  });

  it("picks my entry out of a list of several members", () => {
    const members = [
      member("u2", "editor"),
      member("u1", "editor"),
      member("u3", "viewer"),
    ];
    expect(roleFor(members, "u1", "owner-1")).toBe("editor");
  });

  it("resolves a user with no member entry to viewer, never editor", () => {
    expect(roleFor([member("u2", "editor")], "u1", "owner-1")).toBe("viewer");
  });

  it("resolves an empty member list to viewer", () => {
    expect(roleFor([], "u1", "owner-1")).toBe("viewer");
  });

  it("resolves a member list that failed to load to viewer", () => {
    // sharesClient.list() answers null when the request fails. Guessing
    // "editor" here would let someone type into a doc the server will not take.
    expect(roleFor(null, "u1", "owner-1")).toBe("viewer");
    expect(roleFor(undefined, "u1", "owner-1")).toBe("viewer");
  });

  it("resolves an unknown user to viewer even against a list of editors", () => {
    const members = [member("u2", "editor"), member("u3", "editor")];
    expect(roleFor(members, null, "owner-1")).toBe("viewer");
    expect(roleFor(members, undefined, "owner-1")).toBe("viewer");
    expect(roleFor(members, "", "owner-1")).toBe("viewer");
  });

  it("does not hand a pending invite someone else's edit rights", () => {
    // A pending invite carries user_id null; so does an unresolved user.
    expect(roleFor([member(null, "editor")], null, "owner-1")).toBe("viewer");
    expect(roleFor([member(null, "editor")], "u1", "owner-1")).toBe("viewer");
  });

  it("does not treat an unknown owner id as a match for an unknown user", () => {
    expect(roleFor([], null, null)).toBe("viewer");
    expect(roleFor([], undefined, undefined)).toBe("viewer");
    expect(roleFor([], "u1", null)).toBe("viewer");
    expect(roleFor([], null, "owner-1")).toBe("viewer");
  });

  it("keeps the owner an owner when the member list failed to load", () => {
    // The access summary is a positive answer from the server, not a guess, so
    // a failed member list must not lock owners out of their own document.
    expect(roleFor(null, "u1", "u1")).toBe("owner");
  });
});

describe("role capabilities", () => {
  it("lets owners and editors edit", () => {
    expect(canEditDoc("owner")).toBe(true);
    expect(canEditDoc("editor")).toBe(true);
    expect(canEditDoc("viewer")).toBe(false);
  });

  it("marks only viewers read-only", () => {
    expect(isReadOnlyShare("viewer")).toBe(true);
    expect(isReadOnlyShare("editor")).toBe(false);
    expect(isReadOnlyShare("owner")).toBe(false);
  });
});

describe("canEditDocument", () => {
  it("leaves a document with no cloud copy editable", () => {
    expect(canEditDocument("local")).toBe(true);
  });

  it("locks the document while the role is still being checked", () => {
    // The window this closes: collab config used to be null until membership
    // resolved, and a null config read as "editable".
    expect(canEditDocument("checking")).toBe(false);
  });

  it("follows the resolved role", () => {
    expect(canEditDocument("owner")).toBe(true);
    expect(canEditDocument("editor")).toBe(true);
    expect(canEditDocument("viewer")).toBe(false);
  });
});

describe("shareBannerFor", () => {
  it("says the access is still being checked, with no action", () => {
    expect(shareBannerFor("checking", null)).toEqual({
      kind: "checking",
      message: "Checking your access…",
    });
  });

  it("names who shared the document with a viewer", () => {
    expect(shareBannerFor("viewer", "Kirby")).toEqual({
      kind: "view-only",
      message: "Shared with you by Kirby · view only",
    });
  });

  it("still says view only when the sharer's name is unknown", () => {
    expect(shareBannerFor("viewer", null)).toEqual({
      kind: "view-only",
      message: "Shared with you · view only",
    });
  });

  it("shows nothing to people who can edit", () => {
    expect(shareBannerFor("owner", "Kirby")).toBeNull();
    expect(shareBannerFor("editor", "Kirby")).toBeNull();
    expect(shareBannerFor("local", null)).toBeNull();
  });

  // "Checking your access…" describes a request that is still running. Leaving
  // it up after the request failed tells the user to wait for something that is
  // never going to arrive.
  it("stops claiming to be checking once the server could not be reached", () => {
    const view = shareBannerFor("unreachable", null);
    expect(view?.kind).toBe("unreachable");
    expect(view?.message).not.toContain("Checking");
    expect(view?.message).toContain("Can't reach the server");
  });
});

describe("offline access", () => {
  // Being offline is an ordinary state for a local-first app. A role the server
  // already confirmed is the best evidence available, so it keeps applying.
  it("keeps honouring a role the server previously confirmed", () => {
    expect(canEditDocument("owner")).toBe(true);
    expect(canEditDocument("editor")).toBe(true);
  });

  // ...but a role that was never confirmed is not evidence of anything.
  it("locks a document whose access was never confirmed on this machine", () => {
    expect(canEditDocument("unreachable")).toBe(false);
  });

  it("still refuses to edit as a remembered viewer", () => {
    expect(canEditDocument("viewer")).toBe(false);
    expect(isReadOnlyShare("viewer")).toBe(true);
  });
});
