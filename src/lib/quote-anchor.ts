// Quote anchors: where a comment sits, said in the document's own words.
//
// A comment made in a live room is anchored by Yjs relative positions
// (src/lib/comment-anchors.ts). A reader who is not in the room, on the
// phone's reading screen for one, has no Yjs document to point into, so the
// anchor carries the quoted words and a little of what stands before and
// after them. Every client then finds those words again in its own rendering
// of the document. The server stores an anchor as opaque JSON, so this file
// is the whole contract. It is pure: no DOM, no editor, no Yjs.
//
// On the wire an anchor is one flat object:
//
//   { from, to,                      Yjs relative positions, always present
//     kind?: "quote",                the words are the anchor; from/to are a placeholder
//     exact, prefix, suffix,         the quoted words and their surroundings
//     approxIndex }                  where they were, for telling repeats apart
//
// Clients released before quote anchors read only `from` and `to`. So an
// anchor made outside a room still carries both, pointing at the top of the
// document: an old client shows the thread there instead of losing it.
// Anchors made in a room keep their real positions and gain the words, so a
// reader outside the room can place them too.
//
// Matching ignores whitespace altogether. A paragraph break is a newline in
// one renderer, a space in another and nothing at all between two table
// cells, and none of that should move a comment.

/** The longest quote an anchor carries. A longer selection keeps its start. */
export const QUOTE_EXACT_MAX = 1000;
/** How much of the text on each side is kept, at most. */
export const QUOTE_CONTEXT_MAX = 48;
/** Context this long, agreeing on either side, is enough to trust a match. */
const CONTEXT_TRUST = 4;
/** A quote this long (whitespace aside) that appears once is trusted on its own. */
const UNIQUE_TRUST = 8;
/** Repeats beyond this many are not weighed: the first ones are. */
const MAX_CANDIDATES = 5000;

export interface Quote {
  /** The quoted words, whitespace collapsed to single spaces. */
  exact: string;
  /** The text just before them, at most QUOTE_CONTEXT_MAX long. */
  prefix: string;
  /** The text just after them. */
  suffix: string;
  /** How many non-whitespace UTF-16 units stood before them in the document. */
  approxIndex: number;
}

export interface QuoteAnchor extends Quote {
  kind: "quote";
  from: unknown;
  to: unknown;
}

/**
 * A Yjs relative position for the start of the shared document (the
 * "default" fragment TipTap's Collaboration extension uses). It needs no Yjs
 * to write down, and a client that reads only `from` and `to` resolves it to
 * the top of the document.
 */
export const DOCUMENT_START_POSITION = Object.freeze({ tname: "default", assoc: -1 });

// JavaScript's \s, plus the zero-width characters a renderer may leave behind.
const IGNORED = /[\s​-‍⁠]/;
const IGNORED_RUN = /[\s​-‍⁠]+/g;

function isIgnored(text: string, index: number): boolean {
  return IGNORED.test(text[index]);
}

/** Whitespace runs become one space, and the ends are trimmed. */
export function collapseWhitespace(text: string): string {
  return text.replace(IGNORED_RUN, " ").trim();
}

function squeeze(text: string): string {
  return text.replace(IGNORED_RUN, "");
}

/** `text` without whitespace, and where each kept unit came from. */
function squeezeWithMap(text: string): { squeezed: string; origin: Uint32Array } {
  const origin = new Uint32Array(text.length);
  const kept: string[] = [];
  let length = 0;
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (isIgnored(text, i)) {
      if (i > runStart) kept.push(text.slice(runStart, i));
      runStart = i + 1;
    } else {
      origin[length++] = i;
    }
  }
  if (text.length > runStart) kept.push(text.slice(runStart));
  return { squeezed: kept.join(""), origin: origin.subarray(0, length) };
}

/**
 * The quote for `text.slice(start, end)`, or null when that is only
 * whitespace. `text` is the document as its reader sees it, one block after
 * another; what separates the blocks does not matter.
 */
export function describeQuote(text: string, start: number, end: number): Quote | null {
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(text.length, Math.max(start, end));
  while (from < to && isIgnored(text, from)) from++;
  while (to > from && isIgnored(text, to - 1)) to--;
  if (from >= to) return null;
  if (to - from > QUOTE_EXACT_MAX) {
    to = from + QUOTE_EXACT_MAX;
    // Never half of a surrogate pair.
    const last = text.charCodeAt(to - 1);
    if (last >= 0xd800 && last <= 0xdbff) to--;
    while (to > from && isIgnored(text, to - 1)) to--;
  }
  // Twice the context in raw text, since collapsing only ever shortens it.
  const before = collapseWhitespace(text.slice(Math.max(0, from - QUOTE_CONTEXT_MAX * 2), from));
  const after = collapseWhitespace(text.slice(to, to + QUOTE_CONTEXT_MAX * 2));
  return {
    exact: collapseWhitespace(text.slice(from, to)),
    prefix: before.slice(-QUOTE_CONTEXT_MAX),
    suffix: after.slice(0, QUOTE_CONTEXT_MAX),
    approxIndex: squeeze(text.slice(0, from)).length,
  };
}

function commonSuffix(text: string, end: number, context: string): number {
  let n = 0;
  while (n < context.length && n < end && text[end - 1 - n] === context[context.length - 1 - n]) n++;
  return n;
}

function commonPrefix(text: string, start: number, context: string): number {
  let n = 0;
  while (n < context.length && start + n < text.length && text[start + n] === context[n]) n++;
  return n;
}

/**
 * Where the quote is in `text` now, as offsets into `text`, or null when it
 * cannot be placed with confidence.
 *
 * Every place the words appear is a candidate. The one whose surroundings
 * agree most with the remembered ones wins; a tie goes to the one nearest to
 * where the words used to be. A candidate is trusted when its surroundings
 * agree for at least a few characters, or when the words are long enough to
 * be telling and appear exactly once. Anything less is a guess, and a comment
 * on the wrong words is worse than a comment that says it lost its place.
 */
export function locateQuote(text: string, quote: Quote): { start: number; end: number } | null {
  const exact = squeeze(quote.exact);
  if (!exact) return null;
  const { squeezed, origin } = squeezeWithMap(text);
  const prefix = squeeze(quote.prefix);
  const suffix = squeeze(quote.suffix);
  const near = Number.isFinite(quote.approxIndex) ? quote.approxIndex : 0;

  let best = -1;
  let bestScore = -1;
  let bestDistance = Infinity;
  let count = 0;
  for (let at = squeezed.indexOf(exact); at !== -1 && count < MAX_CANDIDATES; at = squeezed.indexOf(exact, at + 1)) {
    count++;
    const score = commonSuffix(squeezed, at, prefix) + commonPrefix(squeezed, at + exact.length, suffix);
    const distance = Math.abs(at - near);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = at;
      bestScore = score;
      bestDistance = distance;
    }
  }
  if (best === -1) return null;
  const agrees = bestScore >= Math.min(CONTEXT_TRUST, prefix.length + suffix.length);
  const telling = count === 1 && exact.length >= UNIQUE_TRUST;
  if (!agrees && !telling) return null;
  return { start: origin[best], end: origin[best + exact.length - 1] + 1 };
}

/** The quote an anchor carries, whichever kind it is, or null when it has none. */
export function quoteOf(anchor: unknown): Quote | null {
  if (!anchor || typeof anchor !== "object") return null;
  const raw = anchor as Record<string, unknown>;
  if (typeof raw.exact !== "string" || !squeeze(raw.exact)) return null;
  return {
    exact: raw.exact,
    prefix: typeof raw.prefix === "string" ? raw.prefix : "",
    suffix: typeof raw.suffix === "string" ? raw.suffix : "",
    approxIndex: typeof raw.approxIndex === "number" && Number.isFinite(raw.approxIndex) ? raw.approxIndex : 0,
  };
}

/** True when the words are the anchor, and `from`/`to` only a placeholder. */
export function isQuoteAnchor(anchor: unknown): boolean {
  return !!anchor && typeof anchor === "object" && (anchor as { kind?: unknown }).kind === "quote" && quoteOf(anchor) !== null;
}

/** The anchor for a comment made outside a live room. */
export function quoteAnchor(quote: Quote): QuoteAnchor {
  return {
    kind: "quote",
    exact: quote.exact,
    prefix: quote.prefix,
    suffix: quote.suffix,
    approxIndex: quote.approxIndex,
    from: { ...DOCUMENT_START_POSITION },
    to: { ...DOCUMENT_START_POSITION },
  };
}
