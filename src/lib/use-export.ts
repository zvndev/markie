"use client";
// Everything that renders the open document to paper, PDF, or a standalone
// HTML file. All three go through main's one hidden window, so they share a
// single in-flight guard: two concurrent printToPDF runs each spawn a renderer
// main never reclaims, and both open a save sheet on the same window.
//
// Extracted from page.tsx unchanged. The callbacks are stable for the
// component's life: every input is read through a ref refreshed on render, so
// the menu handlers and the command palette never rebuild because a keystroke
// changed the buffer.
import { useCallback, useEffect, useRef, useState } from "react";
import { buildPDFHTML, type PDFTheme } from "@/lib/pdf-styles";
import { getColorMode, resolveColorMode } from "@/lib/color-mode";
import { getSafeAPI } from "@/lib/electron";

// One wording for "an export is already running", wherever the second one is
// refused: the renderer's own guard and the main process's say the same thing.
export const EXPORT_BUSY =
  "Markie is already exporting. Wait for that one to finish.";

export interface ExportInputs {
  /** The document rendered to HTML; the markdown argument wins over state. */
  previewHTML: (md?: string) => string;
  /** Settles the rich pane's debounce and returns the document as it stands. */
  currentMarkdown: () => string;
  /** The open file's path, so main can inline that folder's images. */
  docPath: () => string | null;
  fileName: string | null;
  /** Where a failure is said out loud. Null clears a previous message. */
  onError: (message: string | null) => void;
}

export function useDocumentExport(inputs: ExportInputs) {
  const ref = useRef(inputs);
  useEffect(() => {
    ref.current = inputs;
  });

  // The ref is the guard (synchronous, so a double click cannot slip through);
  // the state is the same fact for the UI, which greys the Export menu out.
  const inFlight = useRef(false);
  const [exporting, setExporting] = useState(false);

  // Runs one export-shaped job under the shared guard, and reports whatever
  // came back: main may reject the invoke, and it may resolve with
  // { success: false, error }. Ignoring either is how a failed export used to
  // look exactly like a successful one. Backing out of a save or print sheet
  // is not a failure.
  const guarded = useCallback(
    async (
      failure: string,
      job: () => Promise<{ canceled?: boolean; error?: string; success?: boolean } | undefined>
    ) => {
      if (inFlight.current) {
        ref.current.onError(EXPORT_BUSY);
        return;
      }
      inFlight.current = true;
      setExporting(true);
      try {
        const res = await job();
        if (res?.canceled) return;
        if (res?.error || res?.success === false) {
          ref.current.onError(res?.error ?? failure);
        } else {
          ref.current.onError(null);
        }
      } catch (err) {
        ref.current.onError(`${failure.replace(/\.$/, "")}: ${String(err)}`);
      } finally {
        inFlight.current = false;
        setExporting(false);
      }
    },
    []
  );

  const exportPDF = useCallback(
    async (theme: PDFTheme) => {
      const { previewHTML, currentMarkdown, docPath } = ref.current;
      const md = currentMarkdown();
      const api = getSafeAPI();
      if (api) {
        await guarded("Couldn't export this document as a PDF.", async () =>
          api.exportPDF({
            html: await buildPDFHTML(previewHTML(md), theme),
            theme,
            docPath: docPath(),
          })
        );
        return;
      }
      // Web fallback: open in a new window and print.
      const fullHTML = await buildPDFHTML(previewHTML(md), theme);
      const printWindow = window.open("", "_blank");
      if (!printWindow) return;
      printWindow.document.write(fullHTML);
      printWindow.document.close();
      printWindow.onload = () => printWindow.print();
    },
    [guarded]
  );

  const exportHTML = useCallback(async () => {
    const { previewHTML, currentMarkdown, docPath, fileName } = ref.current;
    const api = getSafeAPI();
    if (!api) return;
    const base = (fileName ?? "document").replace(/\.[^.]+$/, "");
    await guarded("Couldn't export this document as HTML.", async () =>
      api.exportHTML({
        defaultName: `${base}.html`,
        html: await buildPDFHTML(previewHTML(currentMarkdown()), "light"),
        docPath: docPath(),
      })
    );
  }, [guarded]);

  // Printing the app window prints the app: the editor chrome, the sidebar, a
  // pane scrolled to wherever it happened to be. In Electron the print sheet
  // gets the same rendered document the PDF export builds, off the same hidden
  // window, so what comes out of the printer is the document.
  const printDocument = useCallback(async () => {
    const { previewHTML, currentMarkdown, docPath } = ref.current;
    const api = getSafeAPI();
    if (!api) {
      // Browser: print.css already reshapes the page for paper.
      window.print();
      return;
    }
    const theme: PDFTheme = resolveColorMode(getColorMode());
    await guarded("Couldn't print this document.", async () =>
      api.exportPDF({
        html: await buildPDFHTML(previewHTML(currentMarkdown()), theme),
        theme,
        docPath: docPath(),
        mode: "print",
      })
    );
  }, [guarded]);

  return { exporting, exportPDF, exportHTML, printDocument };
}
