import { useEffect, useRef } from "react";

export function ConfirmDocumentRemoval({ name, onCancel, onRemove }: { name: string; onCancel: () => void; onRemove: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="docs-modal-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section ref={dialog} className="docs-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-document-title" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    if (event.key !== "Tab") return;
    const controls = [...dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><h2 id="delete-document-title">Remove {name}?</h2><p>This removes its local library copy and recovery history. It does not delete any external file.</p><button ref={cancel} type="button" onClick={onCancel}>Keep document</button><button type="button" onClick={onRemove}>Remove from library</button></section></div>;
}
