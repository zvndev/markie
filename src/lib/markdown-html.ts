import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { rehypeMedia } from "@/lib/rehype-media";
import rehypeStringify from "rehype-stringify";

// The same hardened schema the public share renderer uses (server/src/render.ts).
// Markdown itself is not the threat — the pipeline runs without rehype-raw, so a
// document's own <script> arrives as text — but the output of this function is
// written into an export, a print window, and a PDF, and a link is enough:
// defaultSchema.protocols is what drops [x](javascript:…) and data: URLs. The
// additions below are exactly what rehype-highlight (hljs class names) and
// rehype-katex (MathML + SVG + inline styles) emit; without them, sanitizing
// would silently strip every highlight and every equation.
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
  tagNames: [...(defaultSchema.tagNames ?? []), "span", "div", ...MATHML, ...SVG, ...MEDIA],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "ariaHidden", "ariaLabel"],
    span: ["className", "style", "ariaHidden"],
    div: ["className", "style"],
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
  .use(remarkRehype)
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
