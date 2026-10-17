import { lazy, Suspense } from "react";
import type { DocxDocument } from "@/lib/office/docx";
import type { DecodedTextDocument } from "@/lib/document-formats";

const WordEditor = lazy(() => import("./documents/word-document-editor").then((module) => ({ default: module.WordDocumentEditor })));
export type CloudEditingState =
  | { kind: "docx"; document: DocxDocument }
  | { kind: "text"; text: string; metadata: DecodedTextDocument }
  | { kind: "binary" };

export function CloudDocumentEditor({ value, readOnly, onChange }: {
  value: CloudEditingState;
  readOnly: boolean;
  onChange: (value: CloudEditingState) => void;
}) {
  if (value.kind === "docx") return <div className="h-[55vh] min-h-72 border border-border rounded-md overflow-auto"><Suspense fallback={<p>Opening Word document…</p>}><WordEditor document={value.document} readOnly={readOnly} onChange={(document) => { if (!readOnly && document.format === "docx") onChange({ kind: "docx", document }); }} /></Suspense></div>;
  if (value.kind === "binary") return <p className="text-sm text-muted">This format can be downloaded, but not edited here.</p>;
  return <label className="block text-sm">Cloud document text<textarea
    value={value.text.replace(/\r\n?/g, "\n")}
    readOnly={readOnly || value.metadata.newline === "mixed"}
    className="block w-full min-h-60 p-3 mt-2 rounded-md border border-border bg-background font-mono text-sm"
    onChange={(event) => {
      const text = event.target.value;
      const newline = value.metadata.newline;
      if (readOnly || newline === "mixed") return;
      onChange({ ...value, text: newline === "crlf" ? text.replace(/\n/g, "\r\n") : newline === "cr" ? text.replace(/\n/g, "\r") : text });
    }}
  />{value.metadata.newline === "mixed" ? <span className="text-xs text-muted">Mixed line endings are view-only in this cloud editor; download a copy to edit safely.</span> : null}</label>;
}
