// Serialization as a block-level diff. The serializer's whole-document output
// is compared block by block against the original source; a block whose
// normalized original equals the serializer's block is UNCHANGED and its
// original bytes are emitted verbatim. Only genuinely changed blocks (and
// insertions) take the serializer's rewrite. When alignment is not confident
// the serializer's output is used; the code never guesses.

export interface SourceBlock {
  text: string; // the block's source bytes (includes internal newlines)
  trailing: string; // the blank-line bytes that followed it ("" for last)
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

// A serializer merge or split spans a handful of blocks, never a chapter.
// Without a cap, resolving a gap of N unmatched blocks parses O(N^2) growing
// prefixes of the document, which on real files means minutes of work and
// gigabytes of cached strings.
const MAX_RUN_BLOCKS = 8;
const MAX_RUN_CHARS = 20_000;
// The whole-gap test is one parse of the gap, so across a document it costs at
// most one extra parse in total. The cap is only a sanity bound.
const MAX_GAP_CHARS = 500_000;
// Widening re-tests a gap together with the anchors either side. It is capped
// hard and deliberately: a region emitted as one unit is also a region an edit
// inside it rewrites as one unit, and an unbounded widen would swallow the
// document, which would both flatten that blast radius across everything and
// make the reconstruction gate say "clean" for every file.
const MAX_WIDEN_BLOCKS = 24;
const MAX_WIDEN_CHARS = 40_000;

export function splitTopLevelBlocks(md: string): SourceBlock[] {
  const out: SourceBlock[] = [];
  const lines = md.split(/(?<=\n)/);
  let text = "";
  let trailing = "";
  let fenceClose: RegExp | null = null;
  const push = () => {
    if (text !== "" || trailing !== "") out.push({ text, trailing });
    text = "";
    trailing = "";
  };
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (fenceClose) {
      text += line;
      if (fenceClose.test(bare)) fenceClose = null;
      continue;
    }
    if (bare.trim() === "") {
      trailing += line;
      continue;
    }
    if (trailing !== "") push(); // content after blank(s): new block
    const fence = FENCE_OPEN.exec(bare);
    if (fence) {
      const ch = fence[1][0] === "`" ? "`" : "~";
      fenceClose = new RegExp(`^\\s{0,3}\\${ch}{${fence[1].length},}\\s*$`);
    }
    text += line;
  }
  push();
  return out;
}

export function joinBlocks(blocks: SourceBlock[]): string {
  return blocks.map((b) => b.text + b.trailing).join("");
}

/** Comparison key: trailing line terminators are never meaningful here. */
const key = (s: string) => s.replace(/(?:\r?\n)+$/, "");

interface Alignment {
  /** out index -> first original index it was produced from, or -1. */
  owner: number[];
  /** out index -> last original index of that run (>= owner). */
  ownerEnd: number[];
  /** out index -> last out index of a run one original block produced. */
  spanEnd: number[];
  /** out index -> already emitted as part of an earlier block's span. */
  covered: boolean[];
}

export function preserveBlocks(
  originalMd: string,
  serializedMd: string,
  normalize: (block: string) => string
): string {
  const allOrig = splitTopLevelBlocks(originalMd);
  const orig = allOrig.filter((b) => b.text !== "");
  const out = splitTopLevelBlocks(serializedMd).filter((b) => b.text !== "");
  const leading = allOrig.find((b) => b.text === "");

  const normed = orig.map((b) => key(normalize(key(b.text))));
  const outKeys = out.map((b) => key(b.text));
  // eq(i, j): is out[j] exactly what serializing orig[i] unchanged yields?
  const eq = (i: number, j: number) =>
    key(orig[i].text) === outKeys[j] || normed[i] === outKeys[j];

  const align = lcsAlign(orig.length, out.length, eq);
  coalesceRuns(orig, out, outKeys, normed, normalize, align);
  widenGaps(orig, out, normed, normalize, align);

  let result = leading ? leading.trailing : "";
  for (let j = 0; j < out.length; j++) {
    if (align.covered[j]) continue;
    const from = align.owner[j];
    if (from === -1) {
      result += out[j].text + out[j].trailing;
      continue;
    }
    const to = align.ownerEnd[j];
    for (let m = from; m <= to; m++) {
      result += orig[m].text + (m < to ? orig[m].trailing : "");
    }
    const lastOut = align.spanEnd[j];
    result += separatorFor(orig, out, to, lastOut);
  }
  return withSourceEnding(originalMd, result);
}

// Separator bytes after a preserved block. The original's own trailing bytes
// win, so blank runs like "a\n\n\n\nb" survive. At the end of the emitted
// document they are only right when this really was the source's last block:
// when later blocks were deleted, a middle block's blank separator would
// become a stray trailing blank line, so the serializer's ending is used.
function separatorFor(
  orig: SourceBlock[],
  out: SourceBlock[],
  origEnd: number,
  outEnd: number
): string {
  const isDocumentTail = origEnd === orig.length - 1;
  const isLastEmitted = outEnd === out.length - 1;
  if (isLastEmitted && !isDocumentTail) return out[outEnd].trailing;
  return orig[origEnd].trailing !== ""
    ? orig[origEnd].trailing
    : out[outEnd].trailing;
}

// The serializer never ends a document with a newline. Restoring the source's
// own convention is not a guess: it is an observable property of the bytes
// that came in.
function withSourceEnding(originalMd: string, result: string): string {
  if (result === "" || /(?:\r?\n)$/.test(result)) return result;
  if (originalMd.endsWith("\r\n")) return result + "\r\n";
  if (originalMd.endsWith("\n")) return result + "\n";
  return result;
}

// Exact run matches the 1:1 alignment cannot see, applied only inside the gaps
// between anchors so a run can never cross a confident match:
//
//   gap  -> gap   the whole unmatched region at once. This is the one that
//                 matters on real documents: a list whose items are separated
//                 by blank lines parses as ONE loose list, so the serializer
//                 loosens every nested sub-list in it. Normalizing a single
//                 item in isolation returns it TIGHT, because looseness is a
//                 property of the list, not of the item. Only normalizing the
//                 whole region reproduces what the document serializer did.
//   many -> one   a loose list tightened by tightLists, an adjacent reference
//                 definition inlined
//   one -> many   a TIGHT task list, which tiptap-markdown serializes LOOSE
//                 (measured 2026-08-26); one source block lands as several
//
// All three compare exact strings. Anything that does not match stays
// unmatched and takes the serializer's output.
function coalesceRuns(
  orig: SourceBlock[],
  out: SourceBlock[],
  outKeys: string[],
  normed: string[],
  normalize: (block: string) => string,
  align: Alignment
): void {
  const anchors: Array<[number, number]> = [];
  for (let j = 0; j < out.length; j++) {
    if (align.owner[j] !== -1) anchors.push([align.owner[j], j]);
  }

  let iStart = 0;
  let jStart = 0;
  for (const [ai, aj] of [...anchors, [orig.length, out.length] as [number, number]]) {
    resolveGap(orig, out, outKeys, normed, normalize, align, iStart, ai, jStart, aj);
    iStart = ai + 1;
    jStart = aj + 1;
  }
}

function resolveGap(
  orig: SourceBlock[],
  out: SourceBlock[],
  outKeys: string[],
  normed: string[],
  normalize: (block: string) => string,
  align: Alignment,
  i0: number,
  i1: number,
  j0: number,
  j1: number
): void {
  if (i0 >= i1 || j0 >= j1) return;
  if (matchWholeGap(orig, out, normed, normalize, align, i0, i1, j0, j1)) return;
  let i = i0;
  let j = j0;
  while (i < i1 && j < j1) {
    // many source blocks -> this one output block
    let run = "";
    let matchedTo = -1;
    for (let k = i; k < i1 && k - i < MAX_RUN_BLOCKS; k++) {
      run += orig[k].text + orig[k].trailing;
      if (run.length > MAX_RUN_CHARS) break;
      if (k > i && key(normalize(key(run))) === outKeys[j]) {
        matchedTo = k;
        break;
      }
    }
    if (matchedTo !== -1) {
      align.owner[j] = i;
      align.ownerEnd[j] = matchedTo;
      align.spanEnd[j] = j;
      i = matchedTo + 1;
      j++;
      continue;
    }
    // this one source block -> many output blocks
    let outRun = "";
    let spanTo = -1;
    for (let k = j; k < j1 && k - j < MAX_RUN_BLOCKS; k++) {
      outRun += out[k].text + out[k].trailing;
      if (outRun.length > MAX_RUN_CHARS) break;
      if (k > j && normed[i] === key(outRun)) {
        spanTo = k;
        break;
      }
    }
    if (spanTo !== -1) {
      align.owner[j] = i;
      align.ownerEnd[j] = i;
      align.spanEnd[j] = spanTo;
      for (let k = j + 1; k <= spanTo; k++) align.covered[k] = true;
      i++;
      j = spanTo + 1;
      continue;
    }
    // Nothing exact: treat it as an edited block and move on.
    i++;
    j++;
  }
}

// An anchor can strand its neighbour: a numbered step that round-trips byte for
// byte anchors on its own, leaving its indented continuation paragraph alone in
// a gap, where in isolation it reads as an indented code block and can never
// match. Re-testing the gap TOGETHER with the anchors either side puts the
// construct back together. The anchors are released only if the wider region
// matches exactly.
function widenGaps(
  orig: SourceBlock[],
  out: SourceBlock[],
  normed: string[],
  normalize: (block: string) => string,
  align: Alignment
): void {
  const owned = (j: number) => align.owner[j] !== -1;
  let j = 0;
  while (j < out.length) {
    if (owned(j) || align.covered[j]) {
      j++;
      continue;
    }
    let gapEnd = j;
    while (gapEnd < out.length && !owned(gapEnd) && !align.covered[gapEnd]) {
      gapEnd++;
    }
    let prev = -1;
    for (let k = j - 1; k >= 0; k--) {
      if (owned(k)) {
        prev = k;
        break;
      }
    }
    const next = gapEnd < out.length ? gapEnd : -1;
    const outFrom = prev !== -1 ? prev : j;
    const outTo = next !== -1 ? align.spanEnd[next] + 1 : gapEnd;
    const origFrom = prev !== -1 ? align.owner[prev] : 0;
    const origTo = next !== -1 ? align.ownerEnd[next] + 1 : orig.length;
    if (
      (outTo > outFrom || origTo > origFrom) &&
      origTo - origFrom <= MAX_WIDEN_BLOCKS &&
      outTo - outFrom <= MAX_WIDEN_BLOCKS &&
      spanText(orig, origFrom, origTo).length <= MAX_WIDEN_CHARS &&
      matchWholeGap(
        orig,
        out,
        normed,
        normalize,
        align,
        origFrom,
        origTo,
        outFrom,
        outTo,
        { allowSingle: true, release: true }
      )
    ) {
      j = outTo;
      continue;
    }
    j = gapEnd;
  }
}

/** Concatenated source bytes of blocks [from, to), separators included. */
function spanText(blocks: SourceBlock[], from: number, to: number): string {
  let s = "";
  for (let k = from; k < to; k++) s += blocks[k].text + blocks[k].trailing;
  return s;
}

// Does normalizing the entire unmatched source region reproduce the entire
// unmatched output region, exactly? When it does, the user changed nothing in
// here and every byte of it comes back from the source.
function matchWholeGap(
  orig: SourceBlock[],
  out: SourceBlock[],
  normed: string[],
  normalize: (block: string) => string,
  align: Alignment,
  i0: number,
  i1: number,
  j0: number,
  j1: number,
  opts: { allowSingle?: boolean; release?: boolean } = {}
): boolean {
  if (i1 <= i0 || j1 <= j0) return false;
  // A single block against a single block is what the 1:1 alignment already
  // tested and rejected; re-running it here would only cost a parse.
  if (!opts.allowSingle && i1 - i0 === 1 && j1 - j0 === 1) return false;
  const source = spanText(orig, i0, i1);
  if (source.length > MAX_GAP_CHARS) return false;
  const target = key(spanText(out, j0, j1));
  const produced = i1 - i0 === 1 ? normed[i0] : key(normalize(key(source)));
  if (produced !== target) return false;
  if (opts.release) {
    for (let k = j0; k < j1; k++) {
      align.owner[k] = -1;
      align.ownerEnd[k] = -1;
      align.spanEnd[k] = -1;
      align.covered[k] = false;
    }
  }
  align.owner[j0] = i0;
  align.ownerEnd[j0] = i1 - 1;
  align.spanEnd[j0] = j1 - 1;
  for (let k = j0 + 1; k < j1; k++) align.covered[k] = true;
  return true;
}

function lcsAlign(
  n: number,
  m: number,
  eq: (i: number, j: number) => boolean
): Alignment {
  const align: Alignment = {
    owner: new Array(m).fill(-1),
    ownerEnd: new Array(m).fill(-1),
    spanEnd: new Array(m).fill(-1),
    covered: new Array(m).fill(false),
  };
  const take = (i: number, j: number) => {
    align.owner[j] = i;
    align.ownerEnd[j] = i;
    align.spanEnd[j] = j;
  };
  if (n === 0 || m === 0) return align;
  if (n * m > 4_000_000) {
    // Greedy fallback for pathological sizes.
    let i = 0;
    for (let j = 0; j < m; j++) {
      let probe = i;
      while (probe < n && !eq(probe, j)) probe++;
      if (probe < n) {
        take(probe, j);
        i = probe + 1;
      }
    }
    return align;
  }
  // Standard LCS DP over lengths, then backtrack.
  const dp: Int32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(i, j)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) {
      take(i, j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return align;
}
