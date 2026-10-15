import type { DocxDocument, DocxOperation, DocxParagraph } from "@/lib/office/docx";

export function WordLinksAndBreaks({ document, paragraph, runId, disabled, onApply, onAddLink, onInsertBreak }: {
  document: DocxDocument; paragraph?: DocxParagraph; runId?: string; disabled: boolean;
  onApply: (operations: readonly DocxOperation[]) => void; onAddLink: (target: string) => void; onInsertBreak: () => void;
}) {
  const selectedLink = document.hyperlinks.find((link) => link.paragraphId === paragraph?.id && !!runId && link.runIds.includes(runId));
  return <div className="docs-link-tools"><form aria-label="Word hyperlink" onSubmit={(event) => {
    event.preventDefault();
    const target = String(new FormData(event.currentTarget).get("target") ?? "");
    if (selectedLink) onApply([{ type: "update-hyperlink", hyperlinkId: selectedLink.id, target }]);
    else onAddLink(target);
  }}><label>Link address<input key={`${selectedLink?.id ?? "new"}:${selectedLink?.target ?? ""}`} aria-label="Link address" name="target" type="url" defaultValue={selectedLink?.target ?? "https://"} placeholder="https://example.com" disabled={disabled} required /></label><button type="submit" disabled={disabled || !paragraph}>{selectedLink ? "Update link" : "Link selected text"}</button>{selectedLink ? <><button type="button" disabled={disabled} onClick={() => onApply([{ type: "remove-hyperlink", hyperlinkId: selectedLink.id }])}>Remove link</button><a className="docs-open-link" href={selectedLink.target} target="_blank" rel="noopener noreferrer">Open link</a></> : null}</form><button type="button" disabled={disabled || !paragraph} onClick={onInsertBreak}>Page break at cursor</button>{document.pageBreaks.filter((pageBreak) => pageBreak.paragraphId === paragraph?.id).map((pageBreak, index) => <button type="button" key={pageBreak.id} disabled={disabled} onClick={() => onApply([{ type: "remove-page-break", pageBreakId: pageBreak.id }])}>Remove page break {index + 1}</button>)}<span className="docs-tool-explanation">Select text to link it. Only HTTP, HTTPS and simple email links are supported. Links open only when you choose Open link.</span></div>;
}
