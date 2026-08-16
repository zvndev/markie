// The one sentence that answers "who can see this?"
//
// Markie had every piece of this already — members, roles, pending invites, a
// public link — and no single place that said what they added up to. That is
// how three documents stayed publicly readable for two months while their owner
// believed he had shared them with one person each.
//
// So the state is named, computed in one place, and written out in words the
// owner can act on. The wording is part of the feature, not decoration: a
// person cannot keep a document private if the screen does not tell them it is
// not.

export type GeneralAccess = "restricted" | "link";

export interface AccessSummary {
  // What the world can do, independent of who has been invited.
  general: GeneralAccess;
  // Everyone named on the document, whether or not they have joined yet.
  namedCount: number;
  invitedCount: number;
}

// Deliberately not derived from "is there a token": the caller passes what it
// knows, so a failed request cannot read as "restricted" and quietly reassure
// somebody. Unknown is its own answer, handled by the caller.
export function generalAccessFor(publicUrl: string | null): GeneralAccess {
  return publicUrl ? "link" : "restricted";
}

export function generalAccessLabel(general: GeneralAccess): string {
  return general === "link" ? "Anyone with the link" : "Restricted";
}

// The line under the selector. It says what is true now, in the second person,
// with no hedging.
export function generalAccessLine(summary: AccessSummary): string {
  if (summary.general === "link") {
    return "Anyone on the internet with the link can read this document, without signing in.";
  }
  if (summary.namedCount + summary.invitedCount === 0) {
    return "Only you can open this document.";
  }
  const people = [
    summary.namedCount > 0 ? `${summary.namedCount} ${plural(summary.namedCount, "person", "people")}` : null,
    summary.invitedCount > 0 ? `${summary.invitedCount} invited` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return `Only you and ${people} can open this document.`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Shown before the owner turns public access on. Publishing is the one action
// here that cannot be undone for anybody who already copied the URL, so it is
// stated before the click rather than confirmed after it.
export function publishWarning(fileName: string): string {
  return `Anyone who gets the link will be able to read “${fileName}” without an account. You can revoke it later, but not un-see it.`;
}

// Shown before revoking, because it breaks other people's links.
export function revokeWarning(): string {
  return "The existing link stops working immediately for everyone who has it.";
}

// What a role actually permits, spelled out rather than implied by a word.
export function roleDescription(role: "viewer" | "editor" | "owner"): string {
  if (role === "owner") return "Can edit, share, and delete";
  if (role === "editor") return "Can edit, but not share";
  return "Can read, but not edit";
}

// A pending invite is not access yet, and saying so prevents the mistake of
// assuming somebody has seen a document when they have never signed in.
export function memberStatusLine(joined: boolean): string {
  return joined ? "" : "Invited, not joined yet";
}
