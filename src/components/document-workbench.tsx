import { useCallback, useEffect, useRef, useState } from "react";
import { createDocx, exportDocx, openDocx, replaceDocxText, type DocxDocument } from "@/lib/office/docx";
import { extractLegacyDocText } from "@/lib/office/legacy-doc";
import { encodeTextDocument, type DecodedTextDocument } from "@/lib/document-formats";
import { downloadWebDocument, pickWebDocument } from "@/lib/web-files";
import { applyColorMode, getColorMode } from "@/lib/color-mode";

type WorkingDocument =
  | { kind: "docx"; name: string; document: DocxDocument }
  | { kind: "text"; name: string; source: DecodedTextDocument; text: string }
  | { kind: "doc"; name: string; text: string };

const actionClass = "px-3 py-2 rounded border border-border text-sm hover:bg-accent disabled:opacity-40";

/** Development harness only: explicit copies, no app registry, sync or original-file writes. */
export function DocumentWorkbench() {
  const [document, setDocument] = useState<WorkingDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Choose a test file or create a generated DOCX.");
  const operation = useRef(0);
  const invalidate = useCallback(() => ++operation.current, []);
  const edited = document?.kind === "docx" ? document.document.modified
    : document?.kind === "text" ? document.text !== document.source.text : false;

  useEffect(() => {
    const oldTitle = window.document.title;
    window.document.title = "Document engine workbench · Markie";
    applyColorMode(getColorMode());
    return () => {
      invalidate();
      window.document.title = oldTitle;
    };
  }, [invalidate]);

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (edited) event.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [edited]);

  function mayReplace() {
    return !edited || window.confirm("Discard the current in-memory edits? Download a copy first if you want to keep them.");
  }

  async function run(action: () => Promise<WorkingDocument | null>) {
    const ticket = invalidate();
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (ticket !== operation.current || !next) return;
      setDocument(next);
      setNotice(next.kind === "doc"
        ? "Legacy DOC main-text extraction only. Formatting and DOC writing are not implemented."
        : "Editing an in-memory copy. The original file is not overwritten.");
    } catch (failure) {
      if (ticket === operation.current) setError(failure instanceof Error ? failure.message : "The operation failed.");
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }

  function open() {
    if (!mayReplace()) return;
    // Call the picker synchronously inside the user gesture, before any await.
    const picking = pickWebDocument();
    void run(async () => {
      const file = await picking;
      if (!file) return null;
      if (file.text) return { kind: "text", name: file.name, source: file.text, text: file.text.text };
      if (file.format.kind === "docx") return { kind: "docx", name: file.name, document: await openDocx(file.bytes) };
      if (file.format.kind === "doc") {
        const result = extractLegacyDocText(file.bytes);
        if (!result.ok) throw new Error(result.error.message);
        return { kind: "doc", name: file.name, text: result.text };
      }
      throw new Error("This file format is not supported by the original engine yet.");
    });
  }

  async function download() {
    if (!document) return;
    const snapshot = document;
    const ticket = invalidate();
    setBusy(true);
    setError(null);
    try {
      let bytes: Uint8Array;
      let name = snapshot.name;
      if (snapshot.kind === "docx") {
        bytes = await exportDocx(snapshot.document);
        name = name.replace(/\.docx$/i, "-copy.docx");
      } else if (snapshot.kind === "text") {
        bytes = encodeTextDocument(snapshot.text, snapshot.source);
      } else {
        bytes = new TextEncoder().encode(snapshot.text);
        name = name.replace(/\.doc$/i, "-extracted.txt");
      }
      if (ticket !== operation.current) return;
      downloadWebDocument({ name, bytes });
      setNotice("Download started for this snapshot. The original file was not overwritten; keep the downloaded copy before leaving.");
    } catch (failure) {
      if (ticket === operation.current) setError(failure instanceof Error ? failure.message : "The export failed.");
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  }

  function editRun(runId: string, text: string) {
    if (document?.kind !== "docx") return;
    try {
      const next = replaceDocxText(document.document, [{ runId, text }]);
      setDocument({ ...document, document: next });
      setError(null);
      setNotice("Unsaved in-memory edit. Download a copy to keep it.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "This edit is not supported.");
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground p-6 sm:p-10">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="space-y-2">
          <p className="text-sm text-muted">Markie · Development only</p>
          <h1 className="text-2xl font-semibold">Original document engine workbench</h1>
          <p className="text-sm text-muted">Test the original DOCX editor and legacy DOC text reader. This is not the finished Word editor.</p>
          <p className="text-sm text-muted">Files stay in memory. No upload, automatic save, vault storage or original-file overwrite.</p>
        </header>
        <div className="flex flex-wrap gap-3" aria-label="Document actions">
          <button type="button" className={actionClass} onClick={open} disabled={busy}>Open document copy</button>
          <button type="button" className={actionClass} onClick={() => {
            if (mayReplace()) void run(async () => ({
              kind: "docx", name: "test.docx", document: await createDocx("Write a test sentence here."),
            }));
          }} disabled={busy}>New test DOCX</button>
          <button type="button" className={actionClass} onClick={() => void download()} disabled={busy || !document}>Download a copy</button>
          <a className={actionClass} href="/">Back to Markie</a>
        </div>
        <p role="status" className="text-sm text-muted" aria-live="polite">{busy ? "Working locally…" : notice}</p>
        {error && <p role="alert" className="border border-border p-3 rounded text-sm">{error}</p>}
        {document && <section className="space-y-4" aria-label="Open document">
          <h2 className="text-lg font-medium break-all">{document.name}</h2>
          {document.kind === "docx" ? <>
            <p className="text-sm text-muted">{document.document.canEdit ? "Supported text runs are editable." : "Read-only: this document includes features the engine cannot safely edit yet."} Layout is not reproduced here.</p>
            {document.document.diagnostics.length > 0 && <ul className="list-disc pl-5 text-sm text-muted">
              {document.document.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}
            </ul>}
            {document.document.paragraphs.map((paragraph, paragraphIndex) => <div key={paragraph.id} className="space-y-2">
              {paragraph.runs.map((run, runIndex) => <label key={run.id} className="block text-sm">
                <span className="block text-muted mb-1">Paragraph {paragraphIndex + 1}, run {runIndex + 1}</span>
                <input
                  value={run.text}
                  readOnly={!document.document.canEdit || !run.canEdit || busy}
                  onChange={(event) => editRun(run.id, event.target.value)}
                  className="w-full bg-surface border border-border rounded p-3 text-foreground"
                />
              </label>)}
            </div>)}
          </> : document.kind === "text" ? <label className="block text-sm">
            <span className="block text-muted mb-2">Document text</span>
            <textarea
              value={document.text}
              disabled={busy}
              onChange={(event) => {
                const normalized = event.target.value;
                // Textareas normalize separators. Keep the original convention
                // for ordinary LF/CRLF/CR files; do not silently rewrite mixed ones.
                if (document.source.newline === "mixed") {
                  setError("Editing mixed line endings is not supported here. The original copy remains unchanged.");
                  return;
                }
                const text = document.source.newline === "crlf" ? normalized.replace(/\r\n|\r|\n/g, "\r\n")
                  : document.source.newline === "cr" ? normalized.replace(/\r\n|\r|\n/g, "\r") : normalized;
                setDocument({ ...document, text });
                setNotice("Unsaved in-memory edit. Download a copy to keep it.");
              }}
              className="w-full min-h-80 bg-surface border border-border rounded p-4 font-mono text-sm"
            />
          </label> : <pre className="whitespace-pre-wrap break-words border border-border rounded p-4 text-sm">{document.text}</pre>}
        </section>}
      </div>
    </main>
  );
}
