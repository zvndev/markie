import { decodeImportText, DocumentImportError, textAccumulator, type DocumentImportLimits, type ImportedDocumentText } from "./types";

// WHATWG HTML §13.1 and §4.12.3: template contents have an inert owner Document
// without a browsing context. Never attach, adopt, clone into the UI, or navigate it.
// https://html.spec.whatwg.org/multipage/scripting.html#the-template-element
const OMIT = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "base", "link", "iframe", "frame", "frameset", "noembed", "noframes", "object", "embed", "form", "input", "button", "select", "textarea", "option", "datalist", "output", "canvas", "svg", "math", "audio", "video", "source", "track", "picture", "img"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "details", "summary", "div", "dl", "dt", "dd", "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul"]);

/** Budget lexical nodes before the platform parser allocates a DOM. Not an HTML parser. */
function preflight(source: string, limits: DocumentImportLimits) {
  let nodes = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "<") continue;
    if (source.startsWith("<!--", i)) { if (++nodes > limits.maxNodes) throw new DocumentImportError("limit-exceeded", "HTML comments exceed the node budget."); const end = source.indexOf("-->", i + 4); if (end < 0) throw new DocumentImportError("malformed", "HTML comment is not terminated."); i = end + 2; continue; }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(i, i + 256));
    if (!tag && !/^<!doctype\s/i.test(source.slice(i, i + 16))) continue;
    if (tag && !tag[1] && ++nodes > limits.maxNodes) throw new DocumentImportError("limit-exceeded", "HTML markup exceeds the node budget.");
    const name = tag?.[2].toLowerCase();
    let quote = "";
    for (i++; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (tag && !tag[1] && name === "plaintext") break;
    if (tag && !tag[1] && ["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes"].includes(name!)) {
      const close = new RegExp(`</${name}(?=[\\t\\r\\n\\f />])`, "ig"); close.lastIndex = i + 1;
      const match = close.exec(source); if (!match) break; i = match.index - 1;
    }
  }
}
function hidden(element: Element) {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" || (element.localName === "dialog" && !element.hasAttribute("open"))) return true;
  const style = (element as HTMLElement).style;
  return style?.getPropertyValue("display").trim().toLowerCase() === "none" || ["hidden", "collapse"].includes(style?.getPropertyValue("visibility").trim().toLowerCase() ?? "") || style?.getPropertyValue("content-visibility").trim().toLowerCase() === "hidden";
}

export function extractHtmlText(bytes: Uint8Array, limits: DocumentImportLimits): ImportedDocumentText {
  if (bytes.byteLength > limits.maxInputBytes) throw new DocumentImportError("limit-exceeded", "HTML source exceeds the import byte budget.");
  const source = decodeImportText(bytes); preflight(source, limits);
  if (typeof document === "undefined" || !document.implementation?.createHTMLDocument) throw new DocumentImportError("platform-unavailable", "This platform does not provide inert HTML template parsing.");
  const inert = document.implementation.createHTMLDocument(""), template = inert.createElement("template");
  template.innerHTML = source;
  const budget = Array.from(template.content.childNodes).map((node) => ({ node, depth: 1 }));
  let structuralNodes = 0;
  while (budget.length) {
    const task = budget.pop()!;
    if (++structuralNodes > limits.maxNodes || task.depth > limits.maxDepth) throw new DocumentImportError("limit-exceeded", "HTML structure exceeds the import budget.");
    // Include omitted subtrees in budgets, not merely visible output nodes.
    const children = (task.node.nodeType === 1 && (task.node as Element).localName === "template") ? (task.node as HTMLTemplateElement).content.childNodes : task.node.childNodes;
    for (let i = 0; i < children.length; i++) budget.push({ node: children[i], depth: task.depth + 1 });
  }
  const output = textAccumulator(limits);
  let nodes = 0, last = "", omitted = false;
  const append = (text: string) => { output.append(text); if (text) last = text.at(-1)!; };
  const newline = () => { if (last && last !== "\n") append("\n"); };
  type Task = { node: Node; depth: number; pre: boolean; after?: boolean };
  const stack: Task[] = Array.from(template.content.childNodes).reverse().map((node) => ({ node, depth: 1, pre: false }));
  while (stack.length) {
    const task = stack.pop()!;
    if (task.after) {
      const tag = (task.node as Element).localName;
      if (tag === "td" || tag === "th") append("\t"); else if (BLOCK.has(tag)) newline();
      continue;
    }
    if (++nodes > limits.maxNodes || task.depth > limits.maxDepth) throw new DocumentImportError("limit-exceeded", "HTML structure exceeds the import budget.");
    if (task.node.nodeType === 3) {
      let text = task.node.nodeValue ?? "";
      if (!task.pre) { text = text.replace(/[\t\n\r\f ]+/g, " "); if (!last || /[\t\n ]/.test(last)) text = text.replace(/^ /, ""); }
      append(text); continue;
    }
    if (task.node.nodeType !== 1) continue;
    const element = task.node as Element, tag = element.localName;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || OMIT.has(tag) || hidden(element)) { omitted = true; continue; }
    if (tag === "br") { append("\n"); continue; }
    if (BLOCK.has(tag)) newline();
    let children = Array.from(element.childNodes);
    if (tag === "details" && !element.hasAttribute("open")) { children = children.filter((node) => node.nodeType === 1 && (node as Element).localName === "summary").slice(0, 1); omitted = true; }
    stack.push({ ...task, after: true });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: task.depth + 1, pre: task.pre || tag === "pre" });
  }
  return { text: output.result().replace(/[ \t]+\n/g, "\n").replace(/\t$/, "").replace(/\n$/, ""), warnings: [
    "HTML was converted to a new plain-text copy. Formatting, CSS layout, links, media, forms, scripts and embedded content are not preserved; no URLs are fetched.",
    "Visibility from external stylesheets or stylesheet class rules is not evaluated. Explicit hidden/aria-hidden/inline-hidden content is excluded.",
    ...(omitted ? ["Hidden, non-HTML, active, embedded or metadata content was omitted."] : []),
  ] };
}
