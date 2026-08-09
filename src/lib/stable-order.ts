// Recent is ordered by last-opened, and opening a file updates last-opened, so
// clicking a row sent it to the top and shifted every other row under the
// cursor. Two clicks in and the list you were reading is gone. That is a list
// that reorders as a *result* of being used, which is the one thing a list you
// navigate by position must never do.
//
// So: remember the order the panel was opened with and keep it for as long as
// it stays open. Files that appear while you are looking (an agent just wrote
// one) still go to the front, because that is new information rather than a
// reaction to your own click.

export function stableOrder<T>(
  items: T[],
  keyOf: (item: T) => string,
  remembered: readonly string[]
): T[] {
  if (remembered.length === 0) return items;

  const rank = new Map<string, number>();
  remembered.forEach((key, i) => rank.set(key, i));

  const known: T[] = [];
  const fresh: T[] = [];
  for (const item of items) {
    (rank.has(keyOf(item)) ? known : fresh).push(item);
  }

  known.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  // Anything the panel has not seen before leads, in the order it arrived.
  return [...fresh, ...known];
}

// Case-insensitive match on a file's name or its path, so "plan" finds
// ~/work/plans/Q3.md and "q3" finds it too.
export function matchesFilter(
  item: { name: string; path?: string | null },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.name.toLowerCase().includes(q) ||
    (item.path ?? "").toLowerCase().includes(q)
  );
}
