// How far apart two versions of a document are, in lines.
//
// Markie stores content_hash but never the last-synced content, so there is no
// common ancestor to three-way diff against. This compares local against remote
// directly and reports the two numbers the decision actually needs: how many of
// your lines a pull would replace, and how many it would bring in. It does not
// claim who wrote any line, because without a base it cannot know.

export interface LineDiff {
  // In remote but not local: what a pull brings in.
  added: number;
  // In local but not remote: what a pull replaces.
  removed: number;
  same: number;
}

// Past this the LCS table costs more than the answer is worth (5000 x 5000 is
// 25M cells), so we fall back to counting. Documents this large are rare and
// the fallback still answers the only question being asked: is this a small
// difference or a large one.
export const MAX_DIFF_LINES = 5000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  // A trailing newline is line-terminating, not an extra empty line; without
  // this every file that ends in a newline reports one phantom line.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

// Multiset intersection: how many lines the two sides have in common,
// ignoring order. Looser than LCS (a moved block reads as unchanged) but never
// wrong in a way that understates the risk of overwriting.
function countingDiff(a: string[], b: string[]): LineDiff {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let same = 0;
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      same++;
      counts.set(line, n - 1);
    }
  }
  return { added: b.length - same, removed: a.length - same, same };
}

export function lineDiff(local: string, remote: string): LineDiff {
  const a = splitLines(local);
  const b = splitLines(remote);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return countingDiff(a, b);
  }
  // Longest common subsequence over lines, two rows at a time so the table is
  // O(min(n, m)) memory rather than O(n * m).
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const same = prev[b.length];
  return { added: b.length - same, removed: a.length - same, same };
}

// One sentence, in the order the consequence lands: what you lose first, then
// what you gain. "8 lines replaced" is the part someone needs to read before
// clicking, so it goes first.
export function describeDiff(d: LineDiff): string {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  if (d.added === 0 && d.removed === 0) return "The two copies are identical.";
  if (d.removed === 0) return `Pulling brings in ${lines(d.added)} from the server.`;
  if (d.added === 0) return `Pulling replaces ${lines(d.removed)} of yours.`;
  return `Pulling replaces ${lines(d.removed)} of yours and brings in ${lines(
    d.added
  )} from the server.`;
}
