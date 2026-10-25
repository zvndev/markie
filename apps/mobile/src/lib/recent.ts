// The home screen's list logic: paging, search, the shared filter, and the
// labels each row shows. Pure, so it is tested without a device.
import { updatedAgo } from "@/lib/relative-time";
import type { RecentDoc } from "./docs";

export const PAGE_SIZE = 50;

export type RecentScope = "all" | "shared";

/** Newest first, one row per id, the newer copy winning when pages overlap. */
export function mergeRecent(existing: readonly RecentDoc[], incoming: readonly RecentDoc[]): RecentDoc[] {
  const byId = new Map<string, RecentDoc>();
  for (const doc of [...existing, ...incoming]) {
    const seen = byId.get(doc.id);
    if (!seen || Date.parse(doc.updatedAt) >= Date.parse(seen.updatedAt)) byId.set(doc.id, doc);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name));
}

/** The `before` cursor for the next page, or null when this page was the last. */
export function nextCursor(page: readonly RecentDoc[], limit = PAGE_SIZE): string | null {
  if (page.length < limit || page.length === 0) return null;
  return page.reduce((oldest, doc) => (Date.parse(doc.updatedAt) < Date.parse(oldest) ? doc.updatedAt : oldest), page[0].updatedAt);
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Search matches the name only: the list never holds document bodies. */
export function filterRecent(docs: readonly RecentDoc[], query: string, scope: RecentScope): RecentDoc[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return docs.filter((doc) => {
    if (scope === "shared" && !doc.shared) return false;
    if (!words.length) return true;
    const name = fold(doc.name);
    return words.every((word) => name.includes(word));
  });
}

/** "from Claude Code" for an agent-made document, otherwise null. */
export function agentBadge(doc: Pick<RecentDoc, "origin">): string | null {
  if (doc.origin.kind !== "agent") return null;
  return `from ${doc.origin.agent ?? "an agent"}`;
}

/** The name without the extension the format icon already shows. */
export function displayName(name: string): string {
  const stripped = name.replace(/\.(md|markdown|mdx|wd|txt|text|log)$/i, "");
  return stripped || name;
}

export function timeLabel(iso: string, now = Date.now()): string {
  return updatedAgo(Date.parse(iso), now);
}

/** The second line of a row, after the badge: who shared it, if anyone. */
export function sharedLabel(doc: Pick<RecentDoc, "shared" | "sharedBy">): string | null {
  if (!doc.shared) return null;
  return doc.sharedBy ? `Shared by ${doc.sharedBy}` : "Shared with you";
}

export interface RecentSection {
  title: string;
  docs: RecentDoc[];
}

/** Today, Yesterday, Previous 7 Days, then month by month: the shape of a phone's own lists. */
export function sectionRecent(docs: readonly RecentDoc[], now = Date.now()): RecentSection[] {
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const sections: RecentSection[] = [];
  const push = (title: string, doc: RecentDoc) => {
    const last = sections[sections.length - 1];
    if (last?.title === title) last.docs.push(doc);
    else sections.push({ title, docs: [doc] });
  };
  for (const doc of docs) {
    const at = Date.parse(doc.updatedAt);
    if (at >= startToday) push("Today", doc);
    else if (at >= startToday - day) push("Yesterday", doc);
    else if (at >= startToday - 7 * day) push("Previous 7 Days", doc);
    else {
      const date = new Date(at);
      const sameYear = date.getFullYear() === today.getFullYear();
      push(date.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" }), doc);
    }
  }
  return sections;
}
