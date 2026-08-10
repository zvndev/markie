import type { LibraryItem } from "@/lib/electron";

export interface LibraryOverview {
  total: number;
  onDevice: number;
  synced: number;
  shared: number;
  cloudOnly: number;
  missing: number;
  needsAttention: number;
}

export interface OrganizedLibraryItems {
  localFiles: LibraryItem[];
  myCloudOnly: LibraryItem[];
  sharedItems: LibraryItem[];
  sharedCloudOnly: LibraryItem[];
}

export function summarizeLibrary(items: LibraryItem[]): LibraryOverview {
  return items.reduce<LibraryOverview>(
    (summary, item) => {
      summary.total += 1;
      if (item.path && item.exists) summary.onDevice += 1;
      if (item.state === "synced") summary.synced += 1;
      if (item.shared) summary.shared += 1;
      if (item.state === "cloud-only") summary.cloudOnly += 1;
      if (item.path && !item.exists) summary.missing += 1;
      if (libraryItemNeedsAttention(item)) {
        summary.needsAttention += 1;
      }
      return summary;
    },
    {
      total: 0,
      onDevice: 0,
      synced: 0,
      shared: 0,
      cloudOnly: 0,
      missing: 0,
      needsAttention: 0,
    }
  );
}

export function organizeLibraryItems(items: LibraryItem[]): OrganizedLibraryItems {
  const sharedItems = sortLibraryItems(items.filter((item) => item.shared));
  return {
    localFiles: sortLibraryItems(items.filter((item) => item.path)),
    myCloudOnly: sortLibraryItems(items.filter((item) => !item.path && !item.shared)),
    sharedItems,
    sharedCloudOnly: sharedItems.filter((item) => !item.path),
  };
}

export function libraryItemNeedsAttention(item: LibraryItem): boolean {
  return (
    item.state === "unpushed" ||
    item.state === "conflict" ||
    item.state === "behind" ||
    !!(item.path && !item.exists)
  );
}

function sortLibraryItems(items: LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) => {
    const attention = attentionRank(b) - attentionRank(a);
    if (attention !== 0) return attention;

    const time = timestamp(b.lastOpenedAt) - timestamp(a.lastOpenedAt);
    if (time !== 0) return time;

    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function attentionRank(item: LibraryItem): number {
  // "unpushed" outranks the rest: it is the only state where an edit exists in
  // exactly one place, so it is the one the user should see first.
  if (item.state === "unpushed") return 4;
  if (item.state === "conflict") return 3;
  if (item.state === "behind") return 2;
  if (item.path && !item.exists) return 1;
  return 0;
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
