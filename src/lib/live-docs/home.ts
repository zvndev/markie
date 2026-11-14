// What the Live Docs area's home lists (super-nightly, step M3).
//
// The home lists every Live Doc a person has, in one section per source. M3
// has one source: project folders on this Mac, which main keeps
// (electron/live-docs-projects.cjs). Hosted Live Docs join in H4 as a second
// source with its own `kind` and its own loader. The home renders sections by
// `kind`, so H4 adds a section here and a case in the row renderer, and the
// local list does not change.
import type { LiveDocsLocalProject } from "@/lib/electron";

export type LiveDocsHomeSection = { kind: "local"; label: string; entries: LiveDocsLocalProject[] };

export function liveDocsHomeSections(local: readonly LiveDocsLocalProject[]): LiveDocsHomeSection[] {
  return [{ kind: "local", label: "On this Mac", entries: [...local] }];
}

/** A refusal's words. The private build's locked answer carries `error`. */
export function refusalMessage(value: { message?: string; error?: string }, fallback = "Something went wrong."): string {
  return value.message || value.error || fallback;
}
