import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { rehypeMedia } from "@/lib/rehype-media";
import rehypeStringify from "rehype-stringify";

// The same hardened schema the public share renderer uses (server/src/render.ts).
// A document's own HTML is parsed (rehype-raw) and then sanitized against this
// schema, in that order, so a <script>, an iframe, or an onerror= in somebody's
// markdown never reaches an export, a print window, or a PDF, while the
// inline HTML every markdown renderer accepts (a highlight, a colour, a
// centred heading, a picture with a chosen width) survives. A link is enough
// of a threat on its own: defaultSchema.protocols is what drops
// [x](javascript:…) and data: URLs. The additions below are exactly what
// rehype-highlight (hljs class names), rehype-katex (MathML + SVG + inline
// styles) and the rich editor's own marks emit; without them, sanitizing would
// silently strip every highlight and every equation.
const MATHML = ["math","semantics","annotation","mrow","mi","mo","mn","ms","mtext","mspace","msup","msub","msubsup","mfrac","msqrt","mroot","munder","mover","munderover","mtable","mtr","mtd","mpadded","mphantom","menclose","mstyle","mglyph"];
const SVG = ["svg","path","line","g","defs","use","rect","polyline"];
// A clip beside the document plays in an exported HTML file that is still
// beside it. Deliberately never inlined the way images are: base64 of a video
// produces a file nobody can email, so an export that travels loses the
// player and keeps everything else.
const MEDIA = ["video", "audio", "source"];
const sanitizeSchema = {
  ...defaultSchema,
  // defaultSchema.protocols.src is ["http", "https"], which drops the src off
  // an inlined image and leaves an <img alt> pointing at nothing. Every export
  // route runs through here, so a self-contained document came out of Export
  // HTML and out of the PDF with its pictures gone. data: is safe in an image
  // position: a script inside an SVG does not run when the SVG is loaded
  // through <img>, and img-src already allows data: in the app CSP and in the
  // share renderer's own policy.
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
  // `mark` and `u` are what the editor writes for a highlight and an
  // underline; neither is in the GitHub-derived default list.
  tagNames: [...(defaultSchema.tagNames ?? []), "span", "div", "mark", "u", ...MATHML, ...SVG, ...MEDIA],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "ariaHidden", "ariaLabel"],
    span: ["className", "style", "ariaHidden"],
    div: ["className", "style"],
    // A highlight colour, and text alignment on the blocks the editor can
    // align. `style` was already allowed on span and div, so this widens
    // where an inline style may sit, not what one may do.
    mark: ["style"],
    p: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    h5: ["style"],
    h6: ["style"],
    code: ["className"],
    pre: ["className"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    svg: ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "style", "ariaHidden"],
    path: ["d"],
    line: ["x1", "y1", "x2", "y2"],
    video: ["src", "controls", "preload", "width", "height", "poster"],
    audio: ["src", "controls", "preload"],
    source: ["src", "type"],
  },
};

// Same plugin chain the in-app preview historically used (react-markdown),
// as a pure function so exports don't depend on any mounted DOM.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  // allowDangerousHtml only means "keep the HTML nodes for the next plugin".
  // rehype-raw parses them, and rehype-sanitize below is what decides what
  // stays; nothing between the two writes output.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeMedia)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeStringify);

function escapeHTML(value: string): string {
  // String(): the fallback runs on input the pipeline already choked on, and a
  // non-string from a plain-JS call site is one of the ways it does.
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Last-resort output when the pipeline throws. rehype-highlight rethrows on
// anything other than an unknown language, and rehype-katex can throw on
// pathological input, so a single bad document must not take the export (or the
// React tree that calls this) down with it — show the source instead.
export function renderMarkdownFallback(markdown: string): string {
  return `<pre class="markie-render-error">${escapeHTML(markdown)}</pre>`;
}

export function renderMarkdownHTML(markdown: string): string {
  try {
    return String(processor.processSync(markdown));
  } catch (err) {
    console.error("renderMarkdownHTML failed; falling back to plain text", err);
    return renderMarkdownFallback(markdown);
  }
}
