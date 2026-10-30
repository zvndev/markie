// Text-quote anchors for comments on local documents.
//
// A comment on a local file cannot hold a position: the file is plain markdown
// that agents and other editors rewrite freely, and a character offset stops
// meaning anything after the first edit above it. So a comment remembers the
// text it points at, the way the W3C TextQuoteSelector does: the quoted text
// itself (`exact`), a few characters on either side (`prefix`, `suffix`), and
// where it was last seen (`start`, only a hint). Resolving finds the quote
// again in whatever the document says now. When the quote is gone the comment
// is detached, and the caller lists it apart; it is never dropped.
//
// Pure and dependency-free ESM, so one copy serves the main process (through a
// dynamic import), the renderer (bundled by Vite) and the tests.

/** How many characters of context an anchor keeps on each side. */
export const CONTEXT_CHARS = 32;
/** The longest quote an anchor will hold. A comment is on a passage, not a chapter. */
export const MAX_QUOTE_CHARS = 2000;
// Past this many candidates a quote is too common to rank usefully, and
// scoring every one would cost real time on a large document.
const MAX_CANDIDATES = 2000;

/**
 * @typedef {{ exact: string, prefix: string, suffix: string, start: number }} TextAnchor
 * @typedef {{ start: number, end: number }} TextRange
 */

/**
 * The anchor for text.slice(start, end), or null when the range is empty or
 * out of bounds.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {TextAnchor | null}
 */
export function makeAnchor(text, start, end) {
  if (typeof text !== "string") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || end <= start) return null;
  if (end - start > MAX_QUOTE_CHARS) return null;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, end + CONTEXT_CHARS),
    start,
  };
}

/** Every index where needle starts in text, up to MAX_CANDIDATES. */
function exactHits(text, needle) {
  const hits = [];
  if (!needle) return hits;
  let at = text.indexOf(needle);
  while (at !== -1 && hits.length < MAX_CANDIDATES) {
    hits.push({ start: at, end: at + needle.length });
    at = text.indexOf(needle, at + 1);
  }
  return hits;
}

// Whitespace collapsed to single spaces, with a map from each character of the
// collapsed text back to where it came from. An agent that rewraps a paragraph
// changes every line break in it and none of its words; a comment on that
// paragraph should survive that.
function collapse(text) {
  let out = "";
  const map = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace) {
        out += " ";
        map.push(i);
        inSpace = true;
      }
    } else {
      out += ch;
      map.push(i);
      inSpace = false;
    }
  }
  return { text: out, map };
}

/**
 * Where needle appears in text: exactly if it does, otherwise ignoring
 * differences in whitespace. Ranges are in text's own offsets.
 * @param {string} text
 * @param {string} needle
 * @returns {TextRange[]}
 */
export function findAll(text, needle) {
  if (typeof text !== "string" || typeof needle !== "string" || !needle) return [];
  const exact = exactHits(text, needle);
  if (exact.length) return exact;
  const squeezed = collapse(needle.trim()).text;
  if (!squeezed.trim()) return [];
  const hay = collapse(text);
  return exactHits(hay.text, squeezed).map((hit) => ({
    start: hay.map[hit.start],
    end: hay.map[hit.end - 1] + 1,
  }));
}

// How many characters of `want` agree with the text running up to `at`
// (reading backwards), or starting at `at` (reading forwards).
function agreeBefore(text, at, want) {
  let n = 0;
  while (n < want.length && at - n - 1 >= 0 && text[at - n - 1] === want[want.length - n - 1]) n++;
  return n;
}
function agreeAfter(text, at, want) {
  let n = 0;
  while (n < want.length && at + n < text.length && text[at + n] === want[n]) n++;
  return n;
}

function validAnchor(anchor) {
  return (
    !!anchor &&
    typeof anchor === "object" &&
    typeof anchor.exact === "string" &&
    anchor.exact.length > 0
  );
}

/**
 * Find an anchor's text in the document as it is now. When the quote occurs
 * more than once, the occurrence whose surroundings best match the remembered
 * prefix and suffix wins, and among equals the one nearest where it was last
 * seen. Null means the quote is gone: the comment is detached.
 * @param {string} text
 * @param {TextAnchor} anchor
 * @returns {TextRange | null}
 */
export function resolveAnchor(text, anchor) {
  if (typeof text !== "string" || !validAnchor(anchor)) return null;
  const hits = findAll(text, anchor.exact);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const prefix = typeof anchor.prefix === "string" ? anchor.prefix : "";
  const suffix = typeof anchor.suffix === "string" ? anchor.suffix : "";
  const hint = Number.isFinite(anchor.start) ? anchor.start : 0;
  let best = hits[0];
  let bestScore = -1;
  let bestDistance = Infinity;
  for (const hit of hits) {
    const score = agreeBefore(text, hit.start, prefix) + agreeAfter(text, hit.end, suffix);
    const distance = Math.abs(hit.start - hint);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = hit;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Where an agent's quote points, for a new comment. Unlike resolveAnchor this
 * never guesses: a quote that appears several times needs `occurrence`
 * (1-based) or a prefix or suffix that narrows it to one.
 * @param {string} text
 * @param {string} quote
 * @param {{ occurrence?: number, prefix?: string, suffix?: string }} [opts]
 * @returns {{ ok: true, start: number, end: number } | { ok: false, error: string, count: number }}
 */
export function locateQuote(text, quote, { occurrence, prefix, suffix } = {}) {
  if (typeof quote !== "string" || !quote.trim()) {
    return { ok: false, error: "quote is required: the exact text the comment is about.", count: 0 };
  }
  if (quote.length > MAX_QUOTE_CHARS) {
    return { ok: false, error: `quote is too long. Quote at most ${MAX_QUOTE_CHARS} characters.`, count: 0 };
  }
  let hits = findAll(text, quote);
  if (hits.length === 0) {
    return { ok: false, error: "That quote is not in the document. Quote the text exactly as it appears in the file.", count: 0 };
  }
  // Context is compared loosely, whitespace collapsed and trimmed at the seam,
  // so "the" before "quick" matches whether the file has a space or a line
  // break between them.
  if (typeof prefix === "string" && prefix.trim()) {
    const want = collapse(prefix.trim()).text;
    hits = hits.filter((h) => {
      const before = text.slice(Math.max(0, h.start - want.length * 4 - 16), h.start);
      return collapse(before).text.trimEnd().endsWith(want);
    });
  }
  if (typeof suffix === "string" && suffix.trim()) {
    const want = collapse(suffix.trim()).text;
    hits = hits.filter((h) => {
      const after = text.slice(h.end, h.end + want.length * 4 + 16);
      return collapse(after).text.trimStart().startsWith(want);
    });
  }
  if (hits.length === 0) {
    return { ok: false, error: "The quote is in the document, but not with that prefix or suffix around it.", count: 0 };
  }
  if (occurrence !== undefined && occurrence !== null) {
    const n = Number(occurrence);
    if (!Number.isInteger(n) || n < 1 || n > hits.length) {
      return {
        ok: false,
        error: `occurrence must be between 1 and ${hits.length}: the quote appears ${hits.length} time${hits.length === 1 ? "" : "s"}${prefix || suffix ? " with that prefix or suffix" : ""}.`,
        count: hits.length,
      };
    }
    return { ok: true, ...hits[n - 1] };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: `The quote appears ${hits.length} times. Pass occurrence (1 to ${hits.length}, counted from the top), or a prefix or suffix, to say which one.`,
      count: hits.length,
    };
  }
  return { ok: true, ...hits[0] };
}

/** True when value is a well-formed anchor this module can resolve. */
export function isAnchor(value) {
  return (
    validAnchor(value) &&
    value.exact.length <= MAX_QUOTE_CHARS &&
    typeof value.prefix === "string" &&
    typeof value.suffix === "string" &&
    value.prefix.length <= CONTEXT_CHARS * 4 &&
    value.suffix.length <= CONTEXT_CHARS * 4 &&
    Number.isInteger(value.start) &&
    value.start >= 0
  );
}
