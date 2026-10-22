// Live plain-text collaboration: the same Yjs rooms Markdown uses, with a
// Y.Text instead of the rich XmlFragment. Plain text (.txt/.text/.log in the
// main shell) has no schema to convert, so the file's literal characters are
// the shared document, and saving still writes those exact characters back.
//
// This module must not value-import yjs: it sits on the launch path, and the
// live-session stack loads lazily through src/lib/collab-loader.ts. Types
// only; the component hands in real instances from the loaded runtime.
import type { Doc as YDoc, Text as YText, YTextEvent } from "yjs";
import type { Transaction } from "yjs";

/** Shared-type name for the text body. The server's seed lock knows it too. */
export const TEXT_COLLAB_KEY = "content";

export interface TextDiff {
  index: number;
  deleteCount: number;
  insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The single-span edit that turns `prev` into `next`: common prefix, common
 * suffix, replace what is between. Any edit a text editor emits as a whole
 * new string reduces to this, and Y.Text merges concurrent spans from
 * different clients. Boundaries never split a surrogate pair, so an emoji
 * changed into a cousin sharing its high surrogate still travels whole.
 */
export function diffText(prev: string, next: string): TextDiff | null {
  if (prev === next) return null;
  let prefix = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (prefix < maxPrefix && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && prefix < prev.length && isHighSurrogate(prev.charCodeAt(prefix - 1)) && isLowSurrogate(prev.charCodeAt(prefix))) {
    prefix -= 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(prev.length - prefix, next.length - prefix);
  while (
    suffix < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) suffix += 1;
  if (suffix > 0) {
    const at = prev.length - suffix;
    if (at > prefix && isLowSurrogate(prev.charCodeAt(at)) && isHighSurrogate(prev.charCodeAt(at - 1))) suffix -= 1;
  }
  return {
    index: prefix,
    deleteCount: prev.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/**
 * Two-way binding between a controlled text editor (whole-string onChange)
 * and a Y.Text. Local edits go in as one diff span per change; remote edits
 * come out as the full new string. `last` is the string both sides last
 * agreed on, which is what makes the echo (local edit, then the same text
 * arriving back as a prop) a no-op instead of a second edit.
 */
export class TextCollabBinding {
  #ydoc: YDoc;
  #ytext: YText;
  #onRemote: (text: string) => void;
  #last: string;
  #observer: (event: YTextEvent, transaction: Transaction) => void;
  #disposed = false;

  constructor(ydoc: YDoc, ytext: YText, onRemote: (text: string) => void) {
    this.#ydoc = ydoc;
    this.#ytext = ytext;
    this.#onRemote = onRemote;
    this.#last = ytext.toString();
    this.#observer = (_event, transaction) => {
      if (this.#disposed || transaction.local) return;
      const text = this.#ytext.toString();
      if (text === this.#last) return;
      this.#last = text;
      this.#onRemote(text);
    };
    ytext.observe(this.#observer);
  }

  get text(): string {
    return this.#last;
  }

  /** Push one local whole-string edit. Returns the merged room text. */
  applyLocal(next: string): string {
    const op = diffText(this.#last, next);
    if (op) {
      this.#ydoc.transact(() => {
        if (op.deleteCount > 0) this.#ytext.delete(op.index, op.deleteCount);
        if (op.insert) this.#ytext.insert(op.index, op.insert);
      });
    }
    this.#last = this.#ytext.toString();
    return this.#last;
  }

  /** Seed an empty room from the local file, in the caller's transaction. */
  seedIfEmpty(text: string): boolean {
    if (this.#ytext.length > 0 || !text) return false;
    this.#ytext.insert(0, text);
    this.#last = this.#ytext.toString();
    return true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#ytext.unobserve(this.#observer);
  }
}
