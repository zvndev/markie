// Whether a live rich room can say everything a markdown text says.
//
// A rich room is seeded by parsing the markdown into TipTap, which has no node
// for front matter, raw HTML blocks, HTML comments or footnote definitions.
// The solo editor holds those aside and puts them back verbatim (rich-view.tsx
// serializeMarkdown); the room cannot, so its serialization turns front matter
// into a heading, drops raw HTML and comments, and escapes footnotes. Writing
// the room's text over a text that has any of them destroys them.
//
// One rule for every writer of a live document's text: the desktop's own file
// (src/app/page.tsx, while a rich session is live) and the stored cloud copy
// written by the web app and the phone (rule 3 of src/lib/live-snapshot.ts on
// the web-app branch, which should call this once both are on main). Plain
// text rooms (Y.Text) are byte-faithful and never refused.
import { splitFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides } from "@/lib/rich-hold-aside";

/** True when a rich room would lose part of `text` on its way back out. */
export function richRoomCannotCarry(text: string): boolean {
  const { frontMatter, body } = splitFrontMatter(text);
  if (frontMatter) return true;
  return extractHoldAsides(body).holds.length > 0;
}

/** Said on the desktop while a live rich session leaves the file alone. */
export const LIVE_FILE_REFUSAL_NOTE =
  "Live edits stay in the live session. Your file isn't updated from the live session, because it has front matter or raw HTML that live editing can't keep.";
