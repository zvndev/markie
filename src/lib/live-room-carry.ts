// Whether a live rich room can say everything a markdown text says: the fast
// path of the one guard every writer of a live document's text applies.
//
// A rich room is seeded by parsing the markdown into TipTap, which has no node
// for front matter, raw HTML blocks, HTML comments or footnote definitions.
// The solo editor holds those aside and puts them back verbatim (rich-view.tsx
// serializeMarkdown); the room cannot, so its serialization turns front matter
// into a heading, drops raw HTML and comments, and escapes footnotes. Writing
// the room's text over a text that has any of them destroys them. A picture
// whose address the editor refuses (a `javascript:` or `file:` one, or a
// `data:` one that is not a picture type; see rich-data-images.ts) is the same
// loss: the room holds it as literal text and writes it back escaped.
//
// Those are the losses known in advance. The guard itself is generic
// (roomCarries in src/lib/live-snapshot-rich.ts): a room may write a text
// only when a room seeded from it, unedited, writes it back byte for byte.
// This module answers the known cases without loading the editor.
//
// One rule for every writer of a live document's text: the desktop's own file
// (src/app/page.tsx, while a rich session is live) and the stored cloud copy
// written by the web app and the phone (rule 3 of src/lib/live-snapshot.ts,
// whose liveSnapshotRefusal calls this). Plain text rooms (Y.Text) are
// byte-faithful and never refused.
import { splitFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides } from "@/lib/rich-hold-aside";
import { hasRefusedImage } from "@/lib/rich-data-images";

/** True when a rich room would lose part of `text` on its way back out. */
export function richRoomCannotCarry(text: string): boolean {
  const { frontMatter, body } = splitFrontMatter(text);
  if (frontMatter) return true;
  if (extractHoldAsides(body).holds.length > 0) return true;
  return hasRefusedImage(body);
}

/** Said on the desktop while a live rich session leaves the file alone. */
export const LIVE_FILE_REFUSAL_NOTE =
  "Live edits stay in the live session. Your file isn't updated from the live session, because it has front matter, raw HTML, a picture address or other markdown that live editing can't keep exactly.";

/** What the desktop did with the live text while the file is left alone. */
export type LiveOutputAction = "copied" | "exported" | "saved";

/**
 * Said when Copy all, an export or Save a Copy took the live session's text
 * while the file is not being written from it: the two differ, and the
 * reader has to know which one they got.
 */
export function liveOutputNote(action: LiveOutputAction): string {
  const what =
    action === "copied"
      ? "Copied the live session's text, with everyone's edits."
      : action === "exported"
        ? "Exported the live session's text, with everyone's edits."
        : "Saved the live session's text, with everyone's edits, as the copy.";
  return `${what} Your original file isn't updated from the live session, because live editing can't keep all of its markdown exactly.`;
}
