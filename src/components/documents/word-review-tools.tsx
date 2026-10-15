import { useState } from "react";
import type { DocxDocument, DocxOperation, DocxParagraph } from "@/lib/office/docx";

export interface WordReviewState {
  tracking: boolean; author: string; originalView: boolean;
  onTracking: (tracking: boolean) => void; onAuthor: (author: string) => void; onOriginalView: (original: boolean) => void;
}
export function WordReviewTools({ document, paragraph, readOnly, onApply, review }: {
  document: DocxDocument; paragraph?: DocxParagraph; readOnly: boolean;
  onApply: (operations: readonly DocxOperation[]) => void; review: WordReviewState;
}) {
  const [commentText, setCommentText] = useState(""), [commentAuthor, setCommentAuthor] = useState("You");
  const words = document.text.trim() ? document.text.trim().split(/\s+/).length : 0;
  const commentsLocked = readOnly || document.revisions.length > 0;
  return <div className="docs-review-tools"><div><strong>{words} words</strong><span>{document.text.length} characters · {document.paragraphs.length} paragraphs</span></div>
    <fieldset className="docs-tool-group docs-tracking-controls" disabled={readOnly}><legend className="sr-only">Paragraph text review</legend><button type="button" aria-pressed={review.tracking} onClick={() => review.onTracking(!review.tracking)}>Track paragraph text only</button><label>Revision author<input aria-label="Revision author" value={review.author} onChange={(event) => review.onAuthor(event.target.value)} /></label><button type="button" disabled={!document.revisions.length} onClick={() => onApply([{ type: "accept-all-revisions" }])}>Accept all text changes</button><button type="button" disabled={!document.revisions.length} onClick={() => onApply([{ type: "reject-all-revisions" }])}>Reject all text changes</button></fieldset>
    <p className="docs-tool-explanation">Tracks text edits inside existing paragraphs. Font, layout, new paragraph, table and picture changes are not tracked. Same-author edits are coalesced; resolve pending edits by another author before rewriting a paragraph.</p>
    <div className="docs-tool-group"><button type="button" aria-pressed={!review.originalView} onClick={() => review.onOriginalView(false)}>Final text</button><button type="button" aria-pressed={review.originalView} disabled={document.originalText === undefined} onClick={() => review.onOriginalView(true)}>Original text</button></div>
    <div className="docs-revisions" aria-label="Tracked text changes">{document.revisions.length ? document.revisions.map((revision) => <article key={revision.id}><strong>{revision.type === "insertion" ? "Inserted" : "Deleted"} · {revision.author}</strong>{revision.type === "deletion" ? <del>{revision.text || "Empty text"}</del> : <ins>{revision.text || "Empty text"}</ins>}<div><button type="button" disabled={readOnly} onClick={() => onApply([{ type: "accept-revision", revisionId: revision.id }])}>Accept change</button><button type="button" disabled={readOnly} onClick={() => onApply([{ type: "reject-revision", revisionId: revision.id }])}>Reject change</button></div></article>) : <p>No pending tracked text changes.</p>}</div>
    <details><summary>Document compatibility</summary><ul>{document.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul></details>
    <form className="docs-comment-form" onSubmit={(event) => { event.preventDefault(); if (paragraph && commentText.trim() && commentAuthor.trim()) { onApply([{ type: "add-comment", paragraphId: paragraph.id, text: commentText.trim(), author: commentAuthor.trim() }]); setCommentText(""); } }}><label>Comment author<input aria-label="Comment author" value={commentAuthor} onChange={(event) => setCommentAuthor(event.target.value)} disabled={commentsLocked} /></label><label>Comment on selected paragraph<input aria-label="Comment text" value={commentText} onChange={(event) => setCommentText(event.target.value)} disabled={commentsLocked} placeholder="Add a portable Word comment" /></label><button type="submit" disabled={commentsLocked || !paragraph || !commentText.trim() || !commentAuthor.trim()}>Add comment</button></form>
    {document.revisions.length ? <p className="docs-tool-explanation">Resolve tracked text changes before changing comments.</p> : null}
    <div className="docs-comments" aria-label="Word comments">{document.comments.length ? document.comments.map((comment) => <article key={comment.id}><strong>{comment.author}</strong><p>{comment.text}</p><button type="button" disabled={commentsLocked} onClick={() => onApply([{ type: "delete-comment", commentId: comment.id }])}>Delete comment</button></article>) : <p>No comments. Comments attach to whole paragraphs and travel with this DOCX.</p>}</div>
  </div>;
}
