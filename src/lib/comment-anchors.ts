// Comment anchors are relative positions into the shared Yjs document, so
// they survive concurrent edits; they round-trip through the server as
// opaque JSON. This is the half of the comments module that needs yjs and
// the ProseMirror binding, kept apart from the client and the types
// (src/lib/comments.ts) so that only the live-session chunk
// (src/lib/collab-runtime.ts) carries them.
//
// A comment made outside a live room (the phone's reading screen) cannot
// point into the Yjs document, so its anchor is the quoted words instead
// (src/lib/quote-anchor.ts). Here those words are found in the editor's
// document. An anchor made here carries its words as well as its positions,
// so a reader outside the room can place it too.
import type { Editor } from "@tiptap/react";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { describeQuote, isQuoteAnchor, locateQuote, quoteOf, type Quote } from "@/lib/quote-anchor";

type YMapping = Parameters<typeof absolutePositionToRelativePosition>[2];

interface YSyncState {
  type: Y.XmlFragment;
  binding?: { mapping: YMapping } | null;
}

function syncState(editor: Editor): YSyncState | null {
  const state = ySyncPluginKey.getState(editor.state) as YSyncState | null;
  return state?.binding ? state : null;
}

type PMDoc = Editor["state"]["doc"];

// The document as one string, block after block, and where each run of text
// sits in ProseMirror's positions. Built once per document state.
interface FlatDoc {
  text: string;
  runs: Array<{ at: number; pos: number; length: number }>;
}

const flatDocs = new WeakMap<PMDoc, FlatDoc>();

function flatten(doc: PMDoc): FlatDoc {
  const cached = flatDocs.get(doc);
  if (cached) return cached;
  const parts: string[] = [];
  const runs: FlatDoc["runs"] = [];
  let length = 0;
  let broken = true;
  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? "";
      runs.push({ at: length, pos, length: text.length });
      parts.push(text);
      length += text.length;
      broken = false;
    } else if (!broken) {
      // A block boundary, a hard break, a picture: the words on either side
      // are not one word.
      parts.push("\n");
      length += 1;
      broken = true;
    }
    return true;
  });
  const flat = { text: parts.join(""), runs };
  flatDocs.set(doc, flat);
  return flat;
}

/** The position of the character at `offset`, which is always inside a run. */
function positionOf(flat: FlatDoc, offset: number): number | null {
  let low = 0;
  let high = flat.runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const run = flat.runs[middle];
    if (offset < run.at) high = middle - 1;
    else if (offset >= run.at + run.length) low = middle + 1;
    else return run.pos + (offset - run.at);
  }
  return null;
}

/** Where a selection's ends fall in the flat text. */
function offsetsOf(flat: FlatDoc, from: number, to: number): { start: number; end: number } {
  let start = flat.text.length;
  let end = 0;
  for (const run of flat.runs) {
    if (run.pos + run.length > from) {
      start = run.at + Math.max(0, from - run.pos);
      break;
    }
  }
  for (let i = flat.runs.length - 1; i >= 0; i--) {
    const run = flat.runs[i];
    if (run.pos < to) {
      end = run.at + Math.min(run.length, to - run.pos);
      break;
    }
  }
  return { start, end };
}

/** The words between two positions, as a quote anchor remembers them. */
export function quoteAt(editor: Editor, from: number, to: number): Quote | null {
  const flat = flatten(editor.state.doc);
  const { start, end } = offsetsOf(flat, from, to);
  return end > start ? describeQuote(flat.text, start, end) : null;
}

// A quote found once is held by relative positions for as long as this
// document is open, so it stays on its words while they are edited, the way
// a live-room anchor does. Losing that on reload costs nothing: the words
// are looked for again.
type Pin = { from: Y.RelativePosition; to: Y.RelativePosition };
const pinsByDoc = new WeakMap<Y.Doc, Map<string, Pin>>();

function placeQuote(
  editor: Editor,
  ydoc: Y.Doc,
  ystate: YSyncState | null,
  quote: Quote
): { from: number; to: number } | null {
  const key = JSON.stringify([quote.exact, quote.prefix, quote.suffix, quote.approxIndex]);
  let pins: Map<string, Pin> | null = null;
  if (ystate) {
    pins = pinsByDoc.get(ydoc) ?? new Map();
    pinsByDoc.set(ydoc, pins);
    const pin = pins.get(key);
    if (pin) {
      const from = relativePositionToAbsolutePosition(ydoc, ystate.type, pin.from, ystate.binding!.mapping);
      const to = relativePositionToAbsolutePosition(ydoc, ystate.type, pin.to, ystate.binding!.mapping);
      if (from != null && to != null && from < to) return { from, to };
      // The words it held were deleted. They may have been moved: look again.
      pins.delete(key);
    }
  }
  const flat = flatten(editor.state.doc);
  const range = locateQuote(flat.text, quote);
  if (!range) return null;
  const from = positionOf(flat, range.start);
  const last = positionOf(flat, range.end - 1);
  if (from == null || last == null) return null;
  const placed = { from, to: last + 1 };
  if (pins && ystate) {
    const relFrom = absolutePositionToRelativePosition(placed.from, ystate.type, ystate.binding!.mapping);
    const relTo = absolutePositionToRelativePosition(placed.to, ystate.type, ystate.binding!.mapping);
    if (relFrom && relTo) pins.set(key, { from: relFrom, to: relTo });
  }
  return placed;
}

// Editor selection → serializable anchor. The positions are the anchor; the
// words ride along for readers outside the room.
export function selectionToAnchor(
  editor: Editor,
  from: number,
  to: number
): ({ from: unknown; to: unknown } & Partial<Quote>) | null {
  const ystate = syncState(editor);
  if (!ystate) return null;
  const relFrom = absolutePositionToRelativePosition(
    from,
    ystate.type,
    ystate.binding!.mapping
  );
  const relTo = absolutePositionToRelativePosition(
    to,
    ystate.type,
    ystate.binding!.mapping
  );
  if (!relFrom || !relTo) return null;
  return {
    from: Y.relativePositionToJSON(relFrom),
    to: Y.relativePositionToJSON(relTo),
    ...(quoteAt(editor, from, to) ?? {}),
  };
}

// Anchor → current absolute positions; null when the text was deleted, or
// when a quote's words can no longer be found
export function anchorToAbsolute(
  editor: Editor,
  ydoc: Y.Doc,
  anchor: { from: unknown; to: unknown }
): { from: number; to: number } | null {
  const ystate = syncState(editor);
  if (isQuoteAnchor(anchor)) {
    try {
      return placeQuote(editor, ydoc, ystate, quoteOf(anchor)!);
    } catch {
      return null;
    }
  }
  if (!ystate) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.from),
      ystate.binding!.mapping
    );
    const to = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.to),
      ystate.binding!.mapping
    );
    if (from == null || to == null) return null;
    return { from, to };
  } catch {
    return null;
  }
}
