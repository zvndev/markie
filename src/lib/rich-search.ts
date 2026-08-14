// Mapping between the text a person searches and the positions the rich editor
// stores.
//
// The rich pane does not hold a string. It holds a tree, and a single sentence
// is split across a text node per formatting run: "hello **world**" is two
// nodes. Searching each node on its own would never find "hello world", so the
// nodes are stitched into one string first and matches are mapped back
// afterwards.
//
// The stitching and the mapping are kept here, away from ProseMirror, because
// they are where the off-by-one lives.

export interface TextSegment {
  // Where this run of text starts in the editor's own coordinates.
  pos: number;
  text: string;
  // Anything stable that identifies the block this run belongs to. Runs in
  // different blocks must not be searched as one continuous string, or a query
  // would match across a paragraph break.
  block: unknown;
}

export interface TextIndex {
  text: string;
  entries: Array<{ offset: number; pos: number; length: number }>;
}

// Join the runs into one searchable string, with a newline wherever a block
// ends. The newline keeps the end of one paragraph from running into the start
// of the next and inventing words that are not there.
export function indexSegments(segments: TextSegment[]): TextIndex {
  let text = "";
  const entries: TextIndex["entries"] = [];
  let lastBlock: unknown = undefined;
  let seen = false;

  for (const segment of segments) {
    if (!segment.text) continue;
    if (seen && segment.block !== lastBlock) text += "\n";
    entries.push({ offset: text.length, pos: segment.pos, length: segment.text.length });
    text += segment.text;
    lastBlock = segment.block;
    seen = true;
  }

  return { text, entries };
}

// Turn an offset in the stitched string back into an editor position.
//
// The end of one run and the start of the next are the same place, so an offset
// landing on a boundary has two valid answers. It resolves to the end of the
// earlier run, which keeps a match that finishes exactly at a formatting change
// from claiming the first character of what follows.
export function offsetToPos(index: TextIndex, offset: number): number | null {
  if (offset < 0) return null;
  for (const entry of index.entries) {
    if (offset >= entry.offset && offset <= entry.offset + entry.length) {
      return entry.pos + (offset - entry.offset);
    }
  }
  return null;
}

export interface PosRange {
  from: number;
  to: number;
}

// Map matches found in the stitched string back to editor ranges, dropping any
// that cannot be represented. A match is dropped rather than guessed at: a
// wrong range would highlight, and worse replace, the wrong text.
export function rangesForMatches(
  index: TextIndex,
  matches: Array<{ from: number; to: number }>
): PosRange[] {
  const ranges: PosRange[] = [];
  for (const match of matches) {
    const from = offsetToPos(index, match.from);
    const to = offsetToPos(index, match.to);
    if (from === null || to === null || to <= from) continue;
    ranges.push({ from, to });
  }
  return ranges;
}
