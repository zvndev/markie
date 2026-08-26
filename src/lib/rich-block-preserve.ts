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

// Two exact run matches the 1:1 alignment cannot see, applied only inside the
// gaps between anchors so a run can never cross a confident match:
//
//   many -> one   a loose list tightened by tightLists, an adjacent reference
//                 definition inlined
//   one -> many   a TIGHT task list, which tiptap-markdown serializes LOOSE
//                 (measured 2026-08-26); one source block lands as several
//
// Both compare exact strings. Anything that does not match stays unmatched
// and takes the serializer's output.
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
  let i = i0;
  let j = j0;
  while (i < i1 && j < j1) {
    // many source blocks -> this one output block
    let run = "";
    let matchedTo = -1;
    for (let k = i; k < i1; k++) {
      run += orig[k].text + orig[k].trailing;
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
    for (let k = j; k < j1; k++) {
      outRun += out[k].text + out[k].trailing;
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
