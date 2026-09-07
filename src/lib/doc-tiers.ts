// The renderer's side of the document size tiers. Main decides from a stat
// (electron/doc-tiers.js) and sends the decision with the payload; this module
// only formats what the decision means for the person reading it. The two
// constants are duplicated on purpose, because the renderer cannot import from
// electron/, and a test holds both files to the same numbers.

export const LARGE_DOC_BYTES = 1_000_000;
export const MAX_DOC_BYTES = 100_000_000;

/** "4.4 MB", "143 MB", "1.0 MB": one decimal under 10 MB, none above. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()} MB`;
}

/** The refusal, shown instead of the document. */
export function tooLargeMessage(size: number): string {
  return `Markie opens markdown files up to ${formatMegabytes(MAX_DOC_BYTES)}. This one is ${formatMegabytes(size)}.`;
}

/** The quiet strip above a document that opened in Source view. */
export function largeDocumentNote(size: number): string {
  return `Large document (${formatMegabytes(size)}). Opened in source view; rich editing is off for files over ${formatMegabytes(LARGE_DOC_BYTES)}.`;
}

/** The mode buttons' explanation while a large document is open. */
export const RICH_UNAVAILABLE_TITLE = "Too large for rich view";
