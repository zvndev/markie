// Which `data:` addresses the rich editor takes as a picture.
//
// tiptap-markdown parses with markdown-it, and markdown-it checks every link
// and picture address with one validateLink. Its default lets `data:` through
// only for `image/(gif|png|jpeg|webp);`. Anything else, an SVG chart above
// all, is refused, and a refused `![alt](src)` is not a picture at all: it
// stays the paragraph's literal text, the editor shows the words, and saving
// writes them back escaped (`!\[alt\](data:…)`). The picture is gone from the
// file. That is the form an agent is taught to inline a picture in
// (mcp/markdown-guide.mjs), and the form a chart arrives in when it has to
// travel as one file.
//
// So picture addresses get a wider rule than link addresses, and only picture
// addresses. A picture is drawn by <img>, which never runs script, an SVG's
// included, and every surface's CSP already allows `data:` in img-src. A link
// to a data: URL is a navigation, which is exactly what the default rule is
// there to stop, and links keep it unchanged.

/** Raster types a browser draws in <img>, plus SVG, which <img> draws inert. */
const IMAGE_DATA_URI =
  /^data:image\/(?:apng|avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)[;,]/i;

/** True for a `data:` address the editor draws as a picture. */
export function isImageDataUri(url: string): boolean {
  return IMAGE_DATA_URI.test(url.trim());
}

// markdown-it's own rule, restated: these schemes are refused unless the
// address is one of its four data: picture types.
const BAD_PROTOCOL = /^(?:vbscript|javascript|file|data):/i;

/** True when the editor will not take `url` as a picture's address, so the
 * picture would become its own literal text. Mirrors the parser below. */
export function editorRefusesImageSrc(url: string): boolean {
  const src = url.trim();
  return BAD_PROTOCOL.test(src) && !isImageDataUri(src);
}

// The slice of markdown-it this touches, typed structurally so no type
// package is imported for one hook.
interface InlineState {
  md: { validateLink(url: string): boolean };
}
type InlineRule = (state: InlineState, silent: boolean) => boolean;
interface MarkdownItLike {
  inline: {
    ruler: {
      __rules__?: Array<{ name: string; fn: InlineRule }>;
      at(name: string, fn: InlineRule): void;
    };
  };
}

const widened = new WeakSet<object>();

/**
 * Lets markdown-it's image rule, and only it, accept a picture `data:`
 * address. tiptap-markdown runs extension setup hooks before every parse on
 * the same instance, so this is idempotent per instance.
 *
 * The validator is swapped for the length of one image rule call and put
 * back, so the link, autolink, linkify and reference rules never see the wider
 * one. The alt text is parsed inside that call, so a link written inside alt
 * text does see it, but alt text is rendered as plain text (no href is ever
 * emitted from it).
 */
export function allowImageDataUris(md: MarkdownItLike): void {
  if (widened.has(md)) return;
  const image = md.inline.ruler.__rules__?.find((rule) => rule.name === "image")?.fn;
  // Fail closed: without the rule there is nothing to wrap, and the default
  // (narrower) behaviour stands. The round-trip suite catches it.
  if (!image) return;
  widened.add(md);
  md.inline.ruler.at("image", (state, silent) => {
    const validate = state.md.validateLink;
    state.md.validateLink = (url: string) => isImageDataUri(url) || validate.call(state.md, url);
    try {
      return image(state, silent);
    } finally {
      state.md.validateLink = validate;
    }
  });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// `![alt](src` or `![alt](<src>`; alt text without nested brackets, which is
// how pictures are written.
const IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|([^\s)]+))/g;

/** Every inline picture address in `markdown` outside code, as written. */
function imageSources(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      // A fence closes on a run of its own character at least as long.
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    // A picture written inside a code span is text, and stays text.
    const prose = line.replace(/(`+)[^`]*?\1/g, "");
    for (const match of prose.matchAll(IMAGE)) out.push(match[1] ?? match[2] ?? "");
  }
  return out;
}

/** True when `markdown` has a picture the editor would turn into text. */
export function hasRefusedImage(markdown: string): boolean {
  return imageSources(markdown).some(editorRefusesImageSrc);
}
