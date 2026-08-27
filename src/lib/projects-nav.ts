// Where you are inside the Projects destination, and what the search field is
// therefore searching.
//
// Projects is two levels deep: an index of auto folders and projects, and one
// project (or one folder) opened. "Back" has to mean something concrete, the
// search has to say what it covers, and coming back tomorrow should land you
// where you were rather than at the top again.

export type ProjectsLocation =
  | { kind: "index" }
  | { kind: "project"; key: string }
  | { kind: "folder"; id: string };

export const PROJECTS_AT_KEY = "markie.projects.at.v1";

export const INDEX: ProjectsLocation = { kind: "index" };

// Storage can throw outright in a hardened context, and a preference that
// cannot be read is never worth a broken view.
function safeRead(readKey: (key: string) => string | null, key: string): string | null {
  try {
    return readKey(key);
  } catch {
    return null;
  }
}

export function parseLocation(raw: string | null): ProjectsLocation {
  if (!raw) return INDEX;
  const at = raw.indexOf(":");
  if (at === -1) return INDEX;
  const kind = raw.slice(0, at);
  const value = raw.slice(at + 1);
  if (!value) return INDEX;
  if (kind === "project") return { kind: "project", key: value };
  if (kind === "folder") return { kind: "folder", id: value };
  return INDEX;
}

export function serializeLocation(loc: ProjectsLocation): string {
  if (loc.kind === "project") return `project:${loc.key}`;
  if (loc.kind === "folder") return `folder:${loc.id}`;
  return "index:";
}

export function readLocation(readKey: (key: string) => string | null): ProjectsLocation {
  return parseLocation(safeRead(readKey, PROJECTS_AT_KEY));
}

export function writeLocation(
  writeKey: (key: string, value: string) => void,
  loc: ProjectsLocation
): void {
  try {
    writeKey(PROJECTS_AT_KEY, serializeLocation(loc));
  } catch {
    // storage unavailable
  }
}

// A remembered project can be gone by the next launch: the repository was
// deleted, the rule that named it was edited, the files moved. Landing on a
// destination that no longer exists is worse than landing at the top, so a
// location is only restored when the taxonomy still contains it.
export function resolveLocation(
  loc: ProjectsLocation,
  known: { projectKeys: Iterable<string>; folderIds: Iterable<string> }
): ProjectsLocation {
  if (loc.kind === "project") {
    return [...known.projectKeys].includes(loc.key) ? loc : INDEX;
  }
  if (loc.kind === "folder") {
    return [...known.folderIds].includes(loc.id) ? loc : INDEX;
  }
  return INDEX;
}

export function sameLocation(a: ProjectsLocation, b: ProjectsLocation): boolean {
  return serializeLocation(a) === serializeLocation(b);
}

// What the search field says about itself. A field that reads "Search" while
// its results silently changed scope is the thing this replaces.
export function searchScope(
  loc: ProjectsLocation,
  title: string
): { placeholder: string; label: string; badge: string } {
  if (loc.kind === "index") {
    return {
      placeholder: "Search every project and file",
      label: "Search every project and file",
      badge: "All projects",
    };
  }
  return {
    placeholder: `Search inside ${title}`,
    label: `Search inside ${title}`,
    badge: `In ${title}`,
  };
}
