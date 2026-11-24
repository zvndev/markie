import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/document-session";
import { getSafeAPI } from "@/lib/electron";
import { buildDocxPrintHTML, canPrintDocx } from "@/lib/office/docx-print";
import { COMMENT_OUTPUT_CONFIRMATION } from "@/lib/document-output-policy";
import { printFontsFor } from "./word-fonts";

interface DocumentOutputInputs {
  session: DocumentSession | null;
  captureSession: () => DocumentSession | null;
  isBlocked: () => boolean;
}
export function useDocumentOutput(inputs: DocumentOutputInputs) {
  const current = useRef(inputs); current.current = inputs;
  const mounted = useRef(true), inFlight = useRef(false);
  const ownedPopup = useRef<Window | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ epoch: string; error?: string; notice?: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ownedPopup.current?.close(); ownedPopup.current = null; }; }, []);
  const isBusy = useCallback(() => inFlight.current, []);
  const execute = useCallback(async (command: string) => {
    if (command !== "document-print" && command !== "document-export-pdf") return;
    if (!mounted.current || inFlight.current || current.current.isBlocked()) return;
    // Synchronous model capture, never scraped DOM or a save/flush.
    const snapshot = current.current.captureSession();
    if (!snapshot?.office || !canPrintDocx(snapshot.office)) return;
    const stillCurrent = () => {
      const next = current.current.captureSession();
      return mounted.current && next?.epoch === snapshot.epoch && next.generation === snapshot.generation;
    };
    inFlight.current = true; setBusy(true); setMessage(null);
    let popup: Window | null = null;
    try {
      if (snapshot.office.comments.length && !window.confirm(COMMENT_OUTPUT_CONFIRMATION)) return;
      if (current.current.isBlocked() || !stillCurrent()) return;
      const api = getSafeAPI();
      // In a browser the print window has to open during the click, which is
      // before the fonts are read.
      if (!api) {
        popup = window.open("", "_blank");
        if (!popup) throw new Error("Allow a print window for Markie, then try again.");
        ownedPopup.current = popup;
        popup.opener = null;
      }
      // The document's embedded fonts and bundled stand-ins, inside the page.
      // If they cannot be read the output still goes ahead, in fallback fonts.
      // A document that needs none skips the wait, so its output starts in
      // the same turn as the command.
      const pendingFonts = printFontsFor(snapshot.office);
      const fonts = pendingFonts ? await pendingFonts.catch(() => undefined) : undefined;
      if (current.current.isBlocked() || !stillCurrent()) return;
      const html = buildDocxPrintHTML(snapshot.office, snapshot.name, fonts);
      if (current.current.isBlocked() || !stillCurrent()) return;
      if (api) {
        const result = await api.exportPDF({ html, ...(command === "document-print" ? { mode: "print" as const } : {}) });
        if (!stillCurrent() || current.current.isBlocked() || result.canceled) return;
        if (!result.success || result.error) throw new Error(result.error || "The document output could not be completed.");
        const unchanged = snapshot.office.format === "docx" ? "The Word file was not changed." : "The source file was not changed.";
        setMessage({ epoch: snapshot.epoch, notice: command === "document-print" ? "Sent the supported document view to the printer." : result.path ? `Exported PDF to ${result.path}. ${unchanged}` : `PDF exported. ${unchanged}` });
      } else if (popup) {
        popup.document.write(html); popup.document.close();
        await Promise.all(Array.from(popup.document.images).map((image) => image.decode()));
        await popup.document.fonts?.ready;
        if (!stillCurrent() || current.current.isBlocked()) return;
        popup.focus(); popup.print();
        if (stillCurrent()) setMessage({ epoch: snapshot.epoch, notice: `Print dialog opened. Choose Save as PDF there to export. ${snapshot.office.format === "docx" ? "The Word" : "The source"} file was not changed.` });
      }
    } catch (failure) {
      if (stillCurrent() && !current.current.isBlocked()) setMessage({ epoch: snapshot.epoch, error: failure instanceof Error ? failure.message : "Could not print or export the supported document view." });
    } finally {
      if (popup && ownedPopup.current === popup) { popup.close(); ownedPopup.current = null; }
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const eligible = !!inputs.session?.office && canPrintDocx(inputs.session.office);
  return { busy, isBusy, eligible, execute, error: message?.epoch === inputs.session?.epoch ? message?.error : undefined, notice: message?.epoch === inputs.session?.epoch ? message?.notice : undefined };
}
