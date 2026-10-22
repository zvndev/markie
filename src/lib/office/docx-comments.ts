/** ECMA-376 §17.13.4 portable comments. Only whole-paragraph anchors are
 * editable; arbitrary ranges, modern threaded extensions and revisions stay
 * read-only. Anchors are package data, never tied to an online account.
 */
import { DocxError, type DocxComment, type DocxReviewOperation } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState, type DocxPatch } from "./docx-edit";
import { appendDocxXml, docxPartSource, ensureDocxPart, relatedDocxPart, xmlAttributeText, type DocxPartsState } from "./docx-parts";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

const encoder = new TextEncoder();
const idOf = (node: XmlElement) => xmlAttribute(node, "id", node.namespace);
export interface DocxCommentInspection { comments: readonly DocxComment[]; problem?: string }

export function inspectDocxComments(state: DocxEditState & DocxPartsState): DocxCommentInspection {
  const root = parseXml(state.source);
  const all = xmlDescendants(root);
  const anchors = all.filter((n) => isWord(n) && ["commentRangeStart", "commentRangeEnd", "commentReference"].includes(n.localName));
  const name = relatedDocxPart(state, "comments");
  const source = name && docxPartSource(state, name);
  if (!source) return anchors.length ? { comments: [], problem: "Comment anchors have no comments part." } : { comments: [] };
  const commentsRoot = parseXml(source);
  if (!isWord(commentsRoot, "comments") || commentsRoot.namespace !== root.namespace || !/^[\x20\t\r\n]*$/.test(commentsRoot.text)
    || commentsRoot.children.length > 1000) return { comments: [], problem: "Unsupported or oversized comments part." };
  const ids = new Set<string>();
  const comments: DocxComment[] = [];
  for (const node of commentsRoot.children) {
    const id = idOf(node);
    if (!isWord(node, "comment") || !id || !/^(?:0|[1-9]\d{0,9})$/.test(id) || Number(id) > 2147483647 || ids.has(id) || !node.children.length
      || node.children.some((p) => !isWord(p, "p")) || !/^[\x20\t\r\n]*$/.test(node.text)
      || xmlDescendants(node).some((n) => !isWord(n) || n.namespace !== root.namespace || !["comment", "p", "r", "t"].includes(n.localName)
        || n.children.some((c) => !({ comment: ["p"], p: ["r"], r: ["t"], t: [] } as Record<string, string[]>)[n.localName]?.includes(c.localName))
        || (n.localName !== "t" && !/^[\x20\t\r\n]*$/.test(n.text))
        || n.attributes.some((a) => a.namespace !== "http://www.w3.org/2000/xmlns/" && !(a.namespace === node.namespace && ["id", "author", "initials", "date"].includes(a.localName) && n === node)
          && !(isWord(n, "t") && a.namespace === "http://www.w3.org/XML/1998/namespace" && a.localName === "space")))) {
      return { comments: [], problem: "Read-only: comments contain unsupported formatting, identity or thread state." };
    }
    ids.add(id);
    const matches = anchors.filter((a) => idOf(a) === id);
    if (matches.length !== 3 || matches.filter((n) => isWord(n, "commentRangeStart")).length !== 1
      || matches.filter((n) => isWord(n, "commentRangeEnd")).length !== 1 || matches.filter((n) => isWord(n, "commentReference")).length !== 1) {
      return { comments: [], problem: "Read-only: comments need one complete paragraph anchor." };
    }
    const start = matches.find((n) => isWord(n, "commentRangeStart"))!;
    const end = matches.find((n) => isWord(n, "commentRangeEnd"))!;
    const reference = matches.find((n) => isWord(n, "commentReference"))!;
    const paragraph = all.find((n) => isWord(n, "p") && n.children.includes(start) && n.children.includes(end));
    const referenceRun = paragraph?.children.find((n) => isWord(n, "r") && n.children.includes(reference));
    const textRuns = paragraph && xmlDescendants(paragraph).filter((n) => isWord(n, "r") && wordChild(n, "t"));
    if (!paragraph || !referenceRun || !textRuns?.length || start.end > textRuns[0].start
      || end.start < textRuns[textRuns.length - 1].end || referenceRun.start < end.end
      || referenceRun.children.length !== 1 || !state.identities.has(paragraph.start)) {
      return { comments: [], problem: "Read-only: comment range is not a supported whole-paragraph range." };
    }
    comments.push(Object.freeze({ id, paragraphId: state.identities.get(paragraph.start)!, author: xmlAttribute(node, "author", node.namespace) || "",
      date: xmlAttribute(node, "date", node.namespace), text: node.children.map((p) => xmlDescendants(p).filter((n) => isWord(n, "t")).map((n) => n.text).join("")).join("\n") }));
  }
  if (anchors.some((a) => !ids.has(idOf(a) || ""))) return { comments: [], problem: "Read-only: comment anchor points to a missing comment." };
  return { comments: Object.freeze(comments) };
}

export function applyDocxCommentOperation<T extends DocxEditState & DocxPartsState>(state: T, operation: DocxReviewOperation): T {
  const inspected = inspectDocxComments(state);
  if (inspected.problem) throw new DocxError("unsupported-comments", inspected.problem);
  const root = parseXml(state.source);
  const namespace = root.namespace;
  if (operation.type === "add-comment") {
    if (typeof operation.text !== "string" || !operation.text.trim() || operation.text.length > 10000 || /\r/.test(operation.text)
      || typeof operation.author !== "string" || !operation.author.trim() || operation.author.length > 128 || /[\r\n\t]/.test(operation.author)) {
      throw new DocxError("invalid-comment", "Comments require an author and 1–10000 characters of text.");
    }
    escapeXmlText(operation.text); escapeXmlText(operation.author);
    const paragraph = xmlDescendants(root).find((n) => isWord(n, "p") && state.identities.get(n.start) === operation.paragraphId);
    if (!paragraph || !xmlDescendants(paragraph).some((n) => isWord(n, "r") && wordChild(n, "t"))) throw new DocxError("invalid-comment", "Comment requires a paragraph containing a text run.");
    const id = String(inspected.comments.reduce((max, c) => Math.max(max, Number(c.id)), -1) + 1);
    if (Number(id) > 2147483647 || inspected.comments.length >= 1000) throw new DocxError("comment-limit", "Too many comments.");
    const ensured = ensureDocxPart(state, "comments", "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml", `<w:comments xmlns:w="${namespace}"/>`, namespace);
    const comment = `<w:comment xmlns:w="${namespace}" w:id="${id}" w:author="${xmlAttributeText(operation.author)}" w:date="${new Date().toISOString()}">${operation.text.split("\n").map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`).join("")}</w:comment>`;
    const partOverrides = new Map(ensured.state.partOverrides);
    partOverrides.set(ensured.name, encoder.encode(appendDocxXml(docxPartSource(ensured.state, ensured.name)!, comment)));
    const runs = xmlDescendants(paragraph).filter((n) => isWord(n, "r") && wordChild(n, "t"));
    const start = paragraph.children.find((n) => n.start <= runs[0].start && n.end >= runs[0].end)!.start;
    const lastRun = runs[runs.length - 1];
    const end = paragraph.children.find((n) => n.start <= lastRun.start && n.end >= lastRun.end)!.end;
    const next = patchDocxSource(state, [
      { start, end: start, text: `<w:commentRangeStart xmlns:w="${namespace}" w:id="${id}"/>` },
      { start: end, end, text: `<w:commentRangeEnd xmlns:w="${namespace}" w:id="${id}"/><w:r xmlns:w="${namespace}"><w:commentReference w:id="${id}"/></w:r>` },
    ]);
    return { ...state, ...next, partOverrides };
  }
  const comment = inspected.comments.find((c) => c.id === operation.commentId);
  if (!comment) throw new DocxError("invalid-comment", "Unknown comment identity.");
  const name = relatedDocxPart(state, "comments")!;
  const source = docxPartSource(state, name)!;
  const node = parseXml(source).children.find((n) => idOf(n) === comment.id)!;
  const partOverrides = new Map(state.partOverrides);
  partOverrides.set(name, encoder.encode(source.slice(0, node.start) + source.slice(node.end)));
  const patches: DocxPatch[] = [];
  for (const marker of xmlDescendants(root).filter((n) => isWord(n) && ["commentRangeStart", "commentRangeEnd", "commentReference"].includes(n.localName) && idOf(n) === comment.id)) {
    const run = isWord(marker, "commentReference") && xmlDescendants(root).find((n) => isWord(n, "r") && n.children.includes(marker));
    const remove = run || marker;
    patches.push({ start: remove.start, end: remove.end, text: "" });
  }
  return { ...state, ...patchDocxSource(state, patches), partOverrides };
}
