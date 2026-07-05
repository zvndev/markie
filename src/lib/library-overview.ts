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

export function summarizeLibrary(items: LibraryItem[]): LibraryOverview {
  return items.reduce<LibraryOverview>(
    (summary, item) => {
      summary.total += 1;
      if (item.path && item.exists) summary.onDevice += 1;
      if (item.state === "synced") summary.synced += 1;
      if (item.shared) summary.shared += 1;
      if (item.state === "cloud-only") summary.cloudOnly += 1;
      if (item.path && !item.exists) summary.missing += 1;
      if (item.state === "behind" || item.state === "conflict" || (item.path && !item.exists)) {
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
