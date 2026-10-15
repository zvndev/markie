import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, editDocumentText, restoreDocumentText, serializeDocumentSession, type DocumentSession } from "@/lib/document-session";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import { TextDocumentEditor } from "./text-document-editor";

afterEach(cleanup);
describe("source document controls", () => {
  it("uses the same compact Markie row for literal text and keeps view changes out of its encoded bytes", async () => {
    const session: DocumentSession = { ...await createDocumentSession("text"), text: "one\r\ntwo\r\n", textMetadata: { text: "one\r\ntwo\r\n", encoding: "utf-16le", bom: true, newline: "crlf" } };
    const before = await serializeDocumentSession(session);
    const onChange = vi.fn();
    render(<TextDocumentEditor session={session} onChange={onChange} onFlushReady={vi.fn()} />);
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    expect(document.querySelectorAll(".markie-doc-toolbar")).toHaveLength(1);
    expect(document.querySelector(".docs-text-toolbar")).not.toBeInTheDocument();
    expect(within(toolbar).getByText("UTF-16LE BOM · CRLF")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Find" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Italic" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Paragraph style" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Text colour" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "georgia" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const field = screen.getByRole("textbox", { name: "Document text" });
    expect(field).toHaveStyle({ fontFamily: "Georgia, Charter, serif", fontSize: "22px" });
    expect(onChange).not.toHaveBeenCalled();
    expect(await serializeDocumentSession(session)).toEqual(before);
  });

  it("keeps real Markdown source formatting and Table within the shared row", async () => {
    let latest: DocumentSession = { ...await createDocumentSession("markdown"), text: "original" };
    function Host() {
      const [session, setSession] = useState(latest);
      return <TextDocumentEditor session={session} onChange={(text) => { latest = editDocumentText(latest, text); setSession(latest); }} onFlushReady={vi.fn()} />;
    }
    render(<Host />);
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    const field = screen.getByRole("textbox", { name: "Document text" }) as HTMLTextAreaElement;
    expect(within(toolbar).getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
    field.setSelectionRange(0, 8);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Bold" }));
    expect(latest.text).toBe("**original**");
    field.setSelectionRange(0, latest.text.length);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Italic" }));
    expect(latest.text).toBe("_**original**_");
    fireEvent.change(within(toolbar).getByRole("combobox", { name: "Paragraph style" }), { target: { value: "h1" } });
    expect(latest.text).toBe("# _**original**_");
    field.setSelectionRange(0, 0);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Bullet list" }));
    expect(latest.text).toMatch(/^- /);
    field.setSelectionRange(latest.text.length, latest.text.length);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Table" }));
    expect(latest.text).toContain("| Column 1 | Column 2 |");
    expect(document.querySelectorAll(".markie-doc-toolbar")).toHaveLength(1);
  });

  it("uses the actual Markdown DocToolbar in rich mode while retaining inline controls and no fake Print", async () => {
    const session = { ...await createDocumentSession("markdown"), text: "A paragraph" };
    render(<TextDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rich view" }));
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    expect(within(toolbar).getByRole("button", { name: "Source" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Table" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("combobox", { name: "Text colour" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Print" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".markie-doc-toolbar")).toHaveLength(1);
  });

  it("preserves stable native command targets across viewing changes and rejects commands in inert/read-only editors", async () => {
    const session = { ...await createDocumentSession("text"), text: "A paragraph" };
    const onCommandsReady = vi.fn<(target: DocumentCommandTarget | null) => void>();
    const onChange = vi.fn();
    const { rerender } = render(<TextDocumentEditor session={session} onChange={onChange} onFlushReady={vi.fn()} onCommandsReady={onCommandsReady} />);
    expect(onCommandsReady).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onCommandsReady).toHaveBeenCalledTimes(1);
    const commands = onCommandsReady.mock.calls[0][0]!;
    expect(commands.enabledCommands).toContain("find");
    rerender(<div inert><TextDocumentEditor session={session} onChange={onChange} onFlushReady={vi.fn()} onCommandsReady={onCommandsReady} /></div>);
    const inertCommands = onCommandsReady.mock.calls.at(-1)![0]!;
    inertCommands.execute("find");
    inertCommands.execute("undo");
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    rerender(<TextDocumentEditor session={session} readOnly onChange={onChange} onFlushReady={vi.fn()} onCommandsReady={onCommandsReady} />);
    const readonlyCommands = onCommandsReady.mock.calls.at(-1)![0]!;
    expect(readonlyCommands.enabledCommands).toEqual(["find"]);
    readonlyCommands.execute("undo");
    expect(onChange).not.toHaveBeenCalled();
  });

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
