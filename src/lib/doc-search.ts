// Finding text in a document, independent of which pane is showing it.
//
// Both panes search the same way because they are showing the same document:
// the rich view and the source view disagreeing about how many matches exist
// would be worse than either behaviour on its own.

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface Match {
  from: number;
  to: number;
}

// Word characters for the whole-word option. Deliberately includes digits and
// underscore, matching what every other editor treats as one word.
const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD.test(ch);
}

// Matches are non-overlapping and found left to right: searching "aa" in "aaaa"
// gives two matches, not three. Overlapping matches cannot be stepped through
// or replaced coherently.
export function findMatches(
  text: string,
  query: string,
  options: SearchOptions = {}
): Match[] {
  if (!query) return [];
  const { caseSensitive = false, wholeWord = false } = options;
  // The query is always literal. Someone searching for "a.b" means those three
  // characters, and a document full of markdown is full of regex punctuation.
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const matches: Match[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const end = at + needle.length;
    const boundaried =
      !wholeWord ||
      (!isWordChar(text[at - 1]) && !isWordChar(text[end]));
    if (boundaried) {
      matches.push({ from: at, to: end });
      from = end;
    } else {
      // Step by one, not by the match length: "cat" inside "concatenate" must
      // not hide a real "cat" that starts one character later.
      from = at + 1;
    }
  }
  return matches;
}

// Which match to land on when the caret is somewhere in the document: the first
// one at or after it, wrapping to the top. Keeps "find" from always restarting
// at the beginning of the file.
export function matchAtOrAfter(matches: Match[], position: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((m) => m.from >= position);
  return index === -1 ? 0 : index;
}

// Step through matches with wrap-around in both directions. Returns -1 when
// there is nothing to step through, so callers do not have to special-case it.
export function stepMatch(
  count: number,
  current: number,
  delta: number
): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

// "3 of 12", or "No results" — the label under the search box. Written out here
// so both panes and the tests agree on what an empty search says.
export function matchLabel(count: number, current: number): string {
  if (count === 0) return "No results";
  return `${current + 1} of ${count}`;
}

// Apply replacements right to left so earlier positions stay valid while later
// ones are still being edited.
export function applyReplacements(
  text: string,
  matches: Match[],
  replacement: string
): string {
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, matches[i].from) + replacement + out.slice(matches[i].to);
  }
  return out;
}
