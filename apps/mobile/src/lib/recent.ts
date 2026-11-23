// The home screen's list logic: paging, search, the shared filter, and the
// labels each row shows. Pure, so it is tested without a device.
import { updatedAgo } from "@/lib/relative-time";
import { DOC_ID, docTypeGroup, formatFromName, kindFromName, privateLinkFor, type DocTypeFilter, type RecentDoc } from "./docs";

export const PAGE_SIZE = 50;

/** All, shared with this account, or owned by it and shared with someone else. */
export type RecentScope = "all" | "shared" | "mine";

/**
 * One owned document that other people can reach, from
 * `GET /api/docs/shared-by-me`. The server says how many, not who: the names
 * are one tap away, in the document's share sheet.
 */
export interface SharedOutDoc {
  id: string;
  name: string;
  updatedAt: string;
  /** People who have it, or were sent it and haven't accepted the sender yet. */
  memberCount: number;
  /** Invites to addresses with no Markie account yet. */
  pendingCount: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The `{ docs: [...] }` answer, with anything malformed left out. */
export function parseSharedByMe(value: unknown): SharedOutDoc[] {
  const list = value && typeof value === "object" && Array.isArray((value as { docs?: unknown }).docs) ? (value as { docs: unknown[] }).docs : null;
  if (!list) throw new Error("The server's shared list wasn't in the expected shape.");
  const out: SharedOutDoc[] = [];
  for (const item of list.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !DOC_ID.test(raw.id)) continue;
    const stamp = typeof raw.updated_at === "string" ? raw.updated_at : typeof raw.updatedAt === "string" ? raw.updatedAt : "";
    const at = Date.parse(stamp);
    if (Number.isNaN(at)) continue;
    const memberCount = count(raw.memberCount);
    const pendingCount = count(raw.pendingCount);
    if (memberCount + pendingCount === 0) continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 512) : "Untitled";
    out.push({ id: raw.id, name, updatedAt: new Date(at).toISOString(), memberCount, pendingCount });
  }
  return out;
}

/** Looked up by document id when a row is drawn. */
export function sharedOutIndex(list: readonly SharedOutDoc[]): Map<string, SharedOutDoc> {
  return new Map(list.map((doc) => [doc.id, doc]));
}

/**
 * The "Shared by me" list as rows. It comes from the server's own list, not
 * from the pages of Recent loaded so far, so a document shared long ago is
 * here before anyone scrolls to it. A row already loaded is used as it is
 * (it knows its format and whether an agent made it).
 */
export function sharedOutRows(list: readonly SharedOutDoc[], loaded: readonly RecentDoc[], serverOrigin: string): RecentDoc[] {
  const known = new Map(loaded.filter((doc) => doc.store === "docs").map((doc) => [doc.id, doc]));
  const rows = list.map((item): RecentDoc => {
    const seen = known.get(item.id);
    if (seen) return seen;
    const format = formatFromName(item.name);
    return {
      id: item.id, store: "docs", kind: kindFromName(item.name, format), name: item.name, format,
      createdAt: null, updatedAt: item.updatedAt, origin: { kind: "app", agent: null },
      shared: false, role: "owner", sharedBy: null, privateLink: privateLinkFor(serverOrigin, item.id),
    };
  });
  return mergeRecent([], rows);
}

/**
 * "Shared with 3 people", "2 people invited", or, for both, the short
 * "Shared with 3, invited 2": a row has one line for it on a small phone.
 * Null when nobody else can reach the document.
 */
export function sharedOutLabel(doc: Pick<SharedOutDoc, "memberCount" | "pendingCount"> | undefined): string | null {
  if (!doc) return null;
  const { memberCount, pendingCount } = doc;
  if (memberCount > 0 && pendingCount > 0) return `Shared with ${memberCount}, invited ${pendingCount}`;
  if (memberCount > 0) return memberCount === 1 ? "Shared with 1 person" : `Shared with ${memberCount} people`;
  if (pendingCount > 0) return pendingCount === 1 ? "1 person invited" : `${pendingCount} people invited`;
  return null;
}

/** Rows from the document platform, folded into the list: everything it has, since it does not page. */
export function withPlatform(docs: readonly RecentDoc[], platform: readonly RecentDoc[]): RecentDoc[] {
  return mergeRecent(docs.filter((doc) => doc.store !== "platform"), platform);
}

/** Newest first, one row per id, the newer copy winning when pages overlap. */
export function mergeRecent(existing: readonly RecentDoc[], incoming: readonly RecentDoc[]): RecentDoc[] {
  const byId = new Map<string, RecentDoc>();
  // The two stores mint their own ids, so a row is known by store and id.
  for (const doc of [...existing, ...incoming]) {
    const key = `${doc.store}:${doc.id}`;
    const seen = byId.get(key);
    if (!seen || Date.parse(doc.updatedAt) >= Date.parse(seen.updatedAt)) byId.set(key, doc);
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

/**
 * Search matches the name only: the list never holds document bodies.
 * For "mine", pass the rows from sharedOutRows: they are the scope already.
 */
export function filterRecent(docs: readonly RecentDoc[], query: string, scope: RecentScope, type: DocTypeFilter = "all"): RecentDoc[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return docs.filter((doc) => {
    if (scope === "shared" && !doc.shared) return false;
    if (type !== "all" && docTypeGroup(doc) !== type) return false;
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
