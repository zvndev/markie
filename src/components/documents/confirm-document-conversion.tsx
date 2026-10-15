import { useEffect, useRef } from "react";

export function ConfirmDocumentConversion({ name, format, onCancel, onConvert }: { name: string; format: string; onCancel: () => void; onConvert: () => void }) {
  const dialog = useRef<HTMLElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="docs-modal-scrim"><section ref={dialog} className="docs-dialog" role="alertdialog" aria-modal="true" aria-labelledby="convert-document-title" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>("button")];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[1].focus(); }
    else if (!event.shiftKey && document.activeElement === buttons[1]) { event.preventDefault(); buttons[0].focus(); }
  }}><h2 id="convert-document-title">Import a text copy?</h2><p><strong>{name}</strong> is a {format.toUpperCase()} document. Markie can create a new, editable TXT copy of its supported text.</p><p>This is not native {format.toUpperCase()} editing. Formatting, pictures, comments and other document features may be omitted. Nothing in the original file will be changed.</p><button ref={cancel} type="button" onClick={onCancel}>Cancel import</button><button type="button" onClick={onConvert}>Create text copy</button></section></div>;
}
