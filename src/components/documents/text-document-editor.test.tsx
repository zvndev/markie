import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, editDocumentText, restoreDocumentText, type DocumentSession } from "@/lib/document-session";
import { TextDocumentEditor } from "./text-document-editor";

afterEach(cleanup);
describe("source document controls", () => {
  it("finds, replaces and restores exact source snapshots through undo and redo", async () => {
    let latest: DocumentSession = { ...await createDocumentSession("text"), text: "one\r\ntwo\nthree\r" };
    function Host() {
      const [session, setSession] = useState(latest);
      const update = (next: DocumentSession) => { latest = next; setSession(next); };
      return <TextDocumentEditor session={session} onChange={(text) => update(editDocumentText(latest, text))} onRestoreText={(text) => update(restoreDocumentText(latest, text))} onFlushReady={vi.fn()} />;
    }
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Document text" }) as HTMLTextAreaElement;
    fireEvent.keyDown(field, { key: "f", metaKey: true });
    const query = screen.getByRole("textbox", { name: "Find document text" });
    fireEvent.change(query, { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "Find next" }));
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("two");
    fireEvent.change(screen.getByRole("textbox", { name: "Replace document text with" }), { target: { value: "TWO" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(latest.text).toBe("one\r\nTWO\nthree\r");
    fireEvent.keyDown(field, { key: "z", metaKey: true });
    expect(latest.text).toBe("one\r\ntwo\nthree\r");
    fireEvent.keyDown(field, { key: "z", metaKey: true, shiftKey: true });
    expect(latest.text).toBe("one\r\nTWO\nthree\r");
    fireEvent.keyDown(query, { key: "z", metaKey: true });
    expect(latest.text).toBe("one\r\nTWO\nthree\r");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest.text).toBe("one\r\ntwo\nthree\r");
  });
});
