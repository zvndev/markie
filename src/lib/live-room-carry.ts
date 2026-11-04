// Whether a live rich room can say everything a markdown text says: the fast
// path of the one guard every writer of a live document's text applies.
//
// A rich room is seeded by parsing the markdown into TipTap, which has no node
// for raw HTML blocks, HTML comments or footnote definitions. The solo editor
// holds those aside and puts them back verbatim (rich-view.tsx
// serializeMarkdown); the room cannot, so its serialization drops raw HTML and
// comments and escapes footnotes. Writing the room's text over a text that has
// any of them destroys them. Front matter is not one of them: it never enters
// a room, and every writer puts the front matter of the copy it writes back in
// front (RichView's serializeMarkdown, live and solo alike). A picture
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
  const { body } = splitFrontMatter(text);
  if (extractHoldAsides(body).holds.length > 0) return true;
  return hasRefusedImage(body);
}

/** Said on the desktop while a live rich session leaves the file alone. */
export const LIVE_FILE_REFUSAL_NOTE =
  "Live edits stay in the live session. Your file isn't updated from the live session, because it has raw HTML, an HTML comment, a footnote, a picture address or other markdown that live editing can't keep exactly.";

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
