import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "./document-workspace";
import { useDocumentWorkspace, type DocumentWorkspaceCommand } from "./use-document-workspace";
import { createMemoryDocumentLibrary, type DocumentLibrary, type LibraryRecord } from "@/lib/document-library";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument } from "@/lib/document-formats";
import { createDocx, exportDocx, openDocx } from "@/lib/office/docx";
import { readZip, writeZip } from "@/lib/office/zip";
import type { WebDocumentPayload, WebFileHandle, WebSaveReceipt } from "@/lib/web-files";
import * as legacyDoc from "@/lib/office/legacy-doc-worker-client";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const textBytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function payload(name: string, bytes: Uint8Array): WebDocumentPayload {
  const format = classifyDocumentFormat(name);
  return { name, bytes, format, text: format.representation === "text" ? decodeTextDocument(bytes) : null };
}
async function seed(library: DocumentLibrary, name: string, text: string): Promise<LibraryRecord> {
  const result = await library.put({ name, format: "text", bytes: textBytes(text), extractedText: text }, null);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function newText() {
  fireEvent.click(screen.getByRole("button", { name: "＋ New" }));
  fireEvent.click(screen.getByRole("button", { name: /Plain text/ }));
  const field = await screen.findByRole("textbox", { name: "Document text" });
  await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
  return field;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("actual shared document workspace", () => {
  it("creates, edits, recovers, reopens and searches a literal text document", async () => {
    const library = createMemoryDocumentLibrary();
    const view = render(<DocumentWorkspace library={library} />);
    const editor = await newText();
    fireEvent.change(editor, { target: { value: "# literal writing\nSearchable needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Recover now" }));
    await waitFor(() => expect(screen.getByText("Recovered in the local library. No external file was changed.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "literal writing" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Document details" }));
    fireEvent.blur(screen.getByLabelText("Tags, comma separated"), { target: { value: "project, draft" } });
    fireEvent.blur(screen.getByLabelText("Collection"), { target: { value: "Writing" } });
    fireEvent.click(screen.getByRole("button", { name: "Recover now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "#project" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "needle" } });
    expect(await screen.findByRole("button", { name: /Untitled.txt.*Searchable needle/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Word" }));
    expect(await screen.findByText(/No documents match/)).toBeInTheDocument();
    view.unmount();
    render(<DocumentWorkspace library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: /Untitled.txt.*Searchable needle/ }));
    expect(await screen.findByRole("textbox", { name: "Document text" })).toHaveValue("# literal writing\nSearchable needle");
  });

  it("imports and exports UTF-16 text without losing BOM or newline style", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = encodeTextDocument("first\r\nsecond", { encoding: "utf-16le", bom: true });
    const save = vi.fn().mockResolvedValue({ method: "download", name: "letter.txt" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("letter.txt", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const editor = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    fireEvent.change(editor, { target: { value: "first\nsecond edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(decodeTextDocument(save.mock.calls[0][0].bytes)).toMatchObject({ text: "first\r\nsecond edited", encoding: "utf-16le", bom: true });
    expect(await screen.findByText(/Download started.*original file was not marked saved/)).toBeInTheDocument();
    expect(screen.queryByText("Saved to file")).not.toBeInTheDocument();
  });

  it("discloses legacy control conversion and exports only a new safe text copy", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
    const original = bytes.slice();
    vi.spyOn(legacyDoc, "extractLegacyDocTextOffThread").mockResolvedValueOnce({ ok: true, kind: "text-extraction", canWrite: false, text: "A\x07B\x13FIELD\x14result\x15\vC", rawText: "original raw controls", warnings: ["Text extraction only."] });
    const save = vi.fn().mockResolvedValue({ method: "download", name: "legacy (converted).txt" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("legacy.doc", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const field = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
    expect(field).toHaveValue("A\tBFIELDresult\nC");
    expect(screen.getByText(/Legacy cell and line separators/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].name).toBe("legacy (converted).txt");
    expect(decoded(save.mock.calls[0][0].bytes)).toBe("A\tBFIELDresult\nC");
    expect(bytes).toEqual(original);
  });

  it("retains unsaved edits and permits export when local recovery fails", async () => {
    const backing = createMemoryDocumentLibrary();
    const library: DocumentLibrary = { ...backing, put: async () => ({ ok: false, error: { code: "storage-quota", message: "Storage quota exceeded." } }) };
    const save = vi.fn().mockResolvedValue({ method: "download", name: "Untitled.txt" });
    render(<DocumentWorkspace library={library} saveDocument={save} />);
    const editor = await newText();
    fireEvent.change(editor, { target: { value: "keep this unsaved writing" } });
    fireEvent.click(screen.getByRole("button", { name: "Recover now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage quota exceeded");
    expect(editor).toHaveValue("keep this unsaved writing");
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(decoded(save.mock.calls[0][0].bytes)).toBe("keep this unsaved writing");
  });

  it("blocks overwriting externally changed files and keeps current edits", async () => {
    const library = createMemoryDocumentLibrary();
    let disk = textBytes("original");
    const handle: WebFileHandle = { name: "letter.txt", getFile: async () => ({ name: "letter.txt", size: disk.length, arrayBuffer: async () => disk.slice().buffer }) };
    const save = vi.fn();
    const selected = { ...payload("letter.txt", disk), handle };
    render(<DocumentWorkspace library={library} pickDocument={async () => selected} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const editor = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    fireEvent.change(editor, { target: { value: "my edit" } });
    disk = textBytes("external edit");
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed outside Markie");
    expect(save).not.toHaveBeenCalled(); expect(editor).toHaveValue("my edit");
  });

  it("connects genuine Word formatting, table, layout and comments to exported OOXML", async () => {
    const library = createMemoryDocumentLibrary();
    const original = await exportDocx(await createDocx("Hello Word"));
    const save = vi.fn().mockResolvedValue({ method: "download", name: "letter.docx" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("letter.docx", original)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const paragraph = await screen.findByRole("textbox", { name: "Paragraph 1" });
    await waitFor(() => expect(paragraph).toHaveAttribute("contenteditable", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Numbering" }));
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    expect(screen.getByRole("table", { name: "Document table" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment text" }), { target: { value: "Please check this." } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByText("Please check this.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const reopened = await openDocx(save.mock.calls[0][0].bytes);
    expect(reopened.paragraphs[0].runs.find((run) => run.canEdit)?.style.bold).toBe(true);
    expect(reopened.paragraphs[0].listKind).toBe("numbered");
    expect(reopened.tables).toHaveLength(1);
    expect(reopened.pageLayout.orientation).toBe("landscape");
    expect(reopened.comments[0].text).toBe("Please check this.");
  });

  it("keeps unsupported Word markup read-only and exports its original bytes", async () => {
    const library = createMemoryDocumentLibrary();
    const entries = await readZip(await exportDocx(await createDocx("Do not flatten")));
    const main = entries.find((entry) => entry.name === "word/document.xml")!;
    main.data = textBytes(decoded(main.data).replace("<w:p>", '<w:p><w:bookmarkStart w:id="1" w:name="unsupported"/>'));
    const bytes = writeZip(entries);
    const save = vi.fn().mockResolvedValue({ method: "download", name: "readonly.docx" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("readonly.docx", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const paragraph = await screen.findByRole("textbox", { name: "Paragraph 1" });
    expect(paragraph).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(Array.from(save.mock.calls[0][0].bytes)).toEqual(Array.from(bytes));
  });

  it("finds and replaces actual Word text from Home tools", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = await exportDocx(await createDocx("Hello Hello"));
    const save = vi.fn().mockResolvedValue({ method: "download", name: "find.docx" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("find.docx", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const paragraph = await screen.findByRole("textbox", { name: "Paragraph 1" });
    await waitFor(() => expect(paragraph).toHaveAttribute("contenteditable", "true"));
    fireEvent.change(screen.getByRole("textbox", { name: "Find Word text" }), { target: { value: "Hello" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement text" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(screen.getByText("Replaced 2 matches.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Paragraph 1" })).toHaveTextContent("Draft Draft");
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect((await openDocx(save.mock.calls[0][0].bytes)).text).toBe("Draft Draft");
  });

  it("formats only the selected substring of a Word run", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = await exportDocx(await createDocx("Hello Word"));
    const save = vi.fn().mockResolvedValue({ method: "download", name: "selection.docx" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("selection.docx", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const paragraph = await screen.findByRole("textbox", { name: "Paragraph 1" });
    await waitFor(() => expect(paragraph).toHaveAttribute("contenteditable", "true"));
    const text = paragraph.querySelector("span")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 6); range.setEnd(text, 10);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    fireEvent.pointerUp(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(paragraph.querySelectorAll("span")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const saved = await openDocx(save.mock.calls[0][0].bytes);
    expect(saved.paragraphs[0].runs[0].text).toBe("Hello ");
    expect(saved.paragraphs[0].runs[0].style.bold).not.toBe(true);
    expect(saved.paragraphs[0].runs[1].text).toBe("Word");
    expect(saved.paragraphs[0].runs[1].style.bold).toBe(true);
  });

  it("tracks actual paragraph text revisions, exports them and accepts or rejects changes", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = await exportDocx(await createDocx("Original text"));
    const save = vi.fn().mockResolvedValue({ method: "download", name: "review.docx" });
    render(<DocumentWorkspace library={library} pickDocument={async () => payload("review.docx", bytes)} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    const paragraph = await screen.findByRole("textbox", { name: "Paragraph 1" });
    await waitFor(() => expect(paragraph).toHaveAttribute("contenteditable", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Track paragraph text only" }));
    paragraph.querySelector("span")!.textContent = "Updated text";
    fireEvent.input(paragraph);
    expect(paragraph).toHaveTextContent("Updated text");
    paragraph.querySelector("span")!.textContent = "Updated text!";
    fireEvent.input(paragraph);
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Original text" }));
    expect(paragraph).toHaveTextContent("Original text");
    expect(paragraph).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Final text" }));
    expect(paragraph).toHaveTextContent("Updated text!");
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const pending = await openDocx(save.mock.calls[0][0].bytes);
    expect(pending.text).toBe("Updated text!"); expect(pending.originalText).toBe("Original text"); expect(pending.revisions).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject all text changes" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Reject all text changes" }));
    expect(paragraph).toHaveTextContent("Original text");
    paragraph.querySelector("span")!.textContent = "Accepted text";
    fireEvent.input(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Accept all text changes" }));
    expect(screen.getByText("No pending tracked text changes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const accepted = await openDocx(save.mock.calls[1][0].bytes);
    expect(accepted.text).toBe("Accepted text"); expect(accepted.revisions).toHaveLength(0);
  });

  it("requires consent before converting HTML into a new safe text document", async () => {
    const library = createMemoryDocumentLibrary();
    const bytes = textBytes('<h1>Hello</h1><p>Safe text</p><script>window.__unsafeImport = 1</script>');
    const original = bytes.slice();
    const pickDocument = async () => payload("source.html", bytes);
    const save = vi.fn().mockResolvedValue({ method: "download", name: "source converted.txt" });
    render(<DocumentWorkspace library={library} pickDocument={pickDocument} saveDocument={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("This is not native HTML editing");
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(screen.queryByRole("textbox", { name: "Document text" })).not.toBeInTheDocument();
    const empty = await library.list(); expect(empty.ok && empty.value).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create text copy" }));
    const field = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
    expect((field as HTMLTextAreaElement).value).toContain("Hello");
    expect((field as HTMLTextAreaElement).value).toContain("Safe text");
    expect((field as HTMLTextAreaElement).value).not.toContain("__unsafeImport");
    fireEvent.click(screen.getByRole("button", { name: "Export copy" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].name).toBe("source converted.txt"); expect(bytes).toEqual(original);
    expect((window as Window & { __unsafeImport?: number }).__unsafeImport).toBeUndefined();
  });

  it("uses truthful custom share receipts and remains quiet on cancellation", async () => {
    const library = createMemoryDocumentLibrary();
    const share = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("Cloud read-only link created.");
    render(<DocumentWorkspace library={library} shareDocument={share} />);
    await newText();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(screen.queryByText("Sent to the system share destination.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Cloud read-only link created.")).toBeInTheDocument();
  });

  it("restores a recovery revision and deletes only after explicit confirmation", async () => {
    const library = createMemoryDocumentLibrary();
    const first = await seed(library, "history.txt", "first draft");
    const second = await library.put({ id: first.id, name: first.name, format: first.format, bytes: textBytes("second draft"), extractedText: "second draft" }, first.revision);
    if (!second.ok) throw new Error(second.error.message);
    render(<DocumentWorkspace library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: /history.txt.*second draft/ }));
    const field = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
    fireEvent.click(screen.getByRole("button", { name: "Document details" }));
    fireEvent.click(screen.getByRole("button", { name: "Recovery history" }));
    fireEvent.click(await screen.findByRole("button", { name: /Restore revision 1 / }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Document text" })).toHaveValue("first draft"));
    fireEvent.click(screen.getByRole("button", { name: "Remove from library" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep document" }));
    expect((await library.get(first.id)).ok).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove from library" }));
    const buttons = screen.getAllByRole("button", { name: "Remove from library" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(screen.getByText(/Removed from this library/)).toBeInTheDocument());
    const removed = await library.get(first.id); expect(removed.ok && removed.value).toBeNull();
  });

  it("exposes theme choices and blocks global document shortcuts under an external modal", async () => {
    const library = createMemoryDocumentLibrary();
    const saveDocument = vi.fn();
    const view = render(<DocumentWorkspace library={library} saveDocument={saveDocument} />);
    await newText();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: /^Dark/ }));
    expect(document.documentElement).toHaveClass("dark");
    view.rerender(<DocumentWorkspace library={library} saveDocument={saveDocument} externalModalOpen />);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await act(async () => {});
    expect(saveDocument).not.toHaveBeenCalled();
    expect(document.querySelector(".docs-workspace")).toHaveAttribute("inert");
  });

  it("consumes native open requests once and queues new requests behind a modal", async () => {
    const library = createMemoryDocumentLibrary();
    const handled = vi.fn();
    const first = { requestId: "native-first", payload: payload("native.txt", textBytes("native initial")) };
    const view = render(<DocumentWorkspace library={library} incomingDocument={first} onIncomingDocumentHandled={handled} />);
    const field = await screen.findByRole("textbox", { name: "Document text" });
    await waitFor(() => expect(handled).toHaveBeenCalledWith("native-first"));
    expect(field).toHaveValue("native initial");
    fireEvent.change(field, { target: { value: "native local edits" } });
    view.rerender(<DocumentWorkspace library={library} incomingDocument={{ ...first, payload: payload("native.txt", textBytes("do not reload")) }} onIncomingDocumentHandled={handled} />);
    expect(field).toHaveValue("native local edits");
    expect(handled).toHaveBeenCalledOnce();
    const second = { requestId: "native-second", payload: payload("second.txt", textBytes("second request")) };
    view.rerender(<DocumentWorkspace library={library} incomingDocument={second} onIncomingDocumentHandled={handled} externalModalOpen />);
    expect(await screen.findByText(/second.txt is waiting to open/)).toBeInTheDocument();
    expect(field).toHaveValue("native local edits");
    view.rerender(<DocumentWorkspace library={library} incomingDocument={second} onIncomingDocumentHandled={handled} />);
    fireEvent.click(screen.getByRole("button", { name: "Open requested file" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Document text" })).toHaveValue("second request"));
    await waitFor(() => expect(handled).toHaveBeenCalledWith("native-second"));
    const records = await library.list();
    expect(records.ok && records.value.find((record) => record.name === "native.txt")?.extractedText).toBe("native local edits");
  });
});

describe("workspace asynchronous safety", () => {
  it("does not let an old file export overwrite a newer recovered document", async () => {
    const library = createMemoryDocumentLibrary();
    const saved = deferred<WebSaveReceipt | null>();
    const saveDocument = vi.fn().mockReturnValue(saved.promise);
    const { result } = renderHook(() => useDocumentWorkspace({ library, saveDocument }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.create("text"));
    act(() => result.current.changeText("old revision"));
    await act(() => result.current.recoverNow());
    let pending!: Promise<void>;
    act(() => { pending = result.current.saveFile(); });
    await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());
    act(() => result.current.changeText("newer revision"));
    await act(() => result.current.recoverNow());
    const handle: WebFileHandle = { name: "Untitled.txt", getFile: async () => ({ name: "Untitled.txt", size: 12, arrayBuffer: async () => textBytes("old revision").buffer }) };
    await act(async () => { saved.resolve({ method: "file-system", name: "Untitled.txt", handle }); await pending; });
    expect(result.current.session?.text).toBe("newer revision");
    const record = await library.get(result.current.session!.id);
    expect(record.ok && record.value && decoded(record.value.bytes)).toBe("newer revision");
    expect(record.ok && record.value?.exportedRevision).toBeNull();
    expect(result.current.notice).toContain("Newer edits");
  });

  it("ignores a late open response after a newer document was selected", async () => {
    const backing = createMemoryDocumentLibrary();
    const first = await seed(backing, "first.txt", "first"), second = await seed(backing, "second.txt", "second");
    const waiting = deferred<Awaited<ReturnType<DocumentLibrary["get"]>>>();
    const library: DocumentLibrary = { ...backing, get: (id) => id === first.id ? waiting.promise : backing.get(id) };
    const { result } = renderHook(() => useDocumentWorkspace({ library }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let initial!: Promise<void>;
    act(() => { initial = result.current.open(first); });
    await act(() => result.current.open(second));
    expect(result.current.session?.name).toBe("second.txt");
    await act(async () => { waiting.resolve({ ok: true, value: first }); await initial; });
    expect(result.current.session?.name).toBe("second.txt");
  });

  it("does not adopt an old export receipt after the same document was reopened", async () => {
    const library = createMemoryDocumentLibrary();
    const saving = deferred<WebSaveReceipt | null>();
    const saveDocument = vi.fn().mockReturnValue(saving.promise);
    const { result } = renderHook(() => useDocumentWorkspace({ library, saveDocument }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.create("text"));
    act(() => result.current.changeText("OLD"));
    await act(() => result.current.recoverNow());
    const oldEpoch = result.current.session!.epoch;
    let pending!: Promise<void>;
    act(() => { pending = result.current.saveFile(); });
    await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());
    await act(() => result.current.open(result.current.session!.record!));
    expect(result.current.session!.epoch).not.toBe(oldEpoch);
    act(() => result.current.changeText("NEW"));
    await act(() => result.current.recoverNow());
    const handle: WebFileHandle = { name: "Untitled.txt", getFile: async () => ({ name: "Untitled.txt", size: 3, arrayBuffer: async () => textBytes("OLD").buffer }) };
    await act(async () => { saving.resolve({ method: "file-system", name: "Untitled.txt", handle }); await pending; });
    expect(result.current.session?.text).toBe("NEW");
    expect(result.current.session?.externalGeneration).toBeUndefined();
    const record = await library.get(result.current.session!.id);
    expect(record.ok && record.value && decoded(record.value.bytes)).toBe("NEW");
    expect(record.ok && record.value?.exportedRevision).toBeNull();
    expect(result.current.notice).toContain("earlier document session");
  });

  it("subscribes to native menu commands with the same private/modal scope gate and cleanup", async () => {
    const library = createMemoryDocumentLibrary();
    let listener: ((command: DocumentWorkspaceCommand) => void) | undefined;
    const stop = vi.fn(), subscribeCommands = vi.fn((next: (command: DocumentWorkspaceCommand) => void) => { listener = next; return stop; });
    const saveDocument = vi.fn().mockResolvedValue({ method: "download", name: "Untitled.txt" });
    const pickDocument = vi.fn().mockResolvedValue(null);
    const services = { library, saveDocument, pickDocument, subscribeCommands };
    const hook = renderHook(({ enabled }) => useDocumentWorkspace(services, enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(() => hook.result.current.create("text"));
    act(() => listener!("save"));
    await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());
    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    hook.rerender({ enabled: false });
    act(() => { listener!("save"); listener!("open"); listener!("new"); listener!("save-as"); });
    await act(async () => {});
    expect(saveDocument).toHaveBeenCalledOnce(); expect(pickDocument).not.toHaveBeenCalled(); expect(hook.result.current.session?.format).toBe("text");
    hook.unmount(); expect(stop).toHaveBeenCalledOnce();
  });

  it("allows native close only after confirmed durable recovery of the latest generation", async () => {
    const backing = createMemoryDocumentLibrary();
    const library: DocumentLibrary = { ...backing, persistence: "indexeddb" };
    const { result } = renderHook(() => useDocumentWorkspace({ library }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.create("text"));
    act(() => result.current.changeText("latest close content"));
    let allowed: boolean | undefined;
    await act(async () => { allowed = await result.current.prepareClose(); });
    expect(allowed).toBe(true);
    const stored = await library.get(result.current.session!.id);
    expect(stored.ok && stored.value && decoded(stored.value.bytes)).toBe("latest close content");
    expect(result.current.session?.persistedGeneration).toBe(result.current.session?.generation);
  });

  it("cancels native close if newer text arrives while its recovery transaction is pending", async () => {
    const backing = createMemoryDocumentLibrary();
    const gate = deferred<void>(); let delayWrites = false;
    const library: DocumentLibrary = { ...backing, persistence: "indexeddb", put: async (input, revision) => { if (delayWrites) await gate.promise; return backing.put(input, revision); } };
    const { result } = renderHook(() => useDocumentWorkspace({ library }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.create("text"));
    act(() => result.current.changeText("close snapshot"));
    delayWrites = true;
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.prepareClose(); });
    await waitFor(() => expect(result.current.busy).toBe("Preparing to close"));
    act(() => result.current.changeText("newer asynchronous edit"));
    let allowed: boolean | undefined;
    await act(async () => { gate.resolve(); allowed = await pending; });
    expect(allowed).toBe(false);
    expect(result.current.session?.text).toBe("newer asynchronous edit");
    expect(result.current.error).toContain("Newer edits arrived");
  });

  it("cancels native close on recovery quota errors without losing open text", async () => {
    const backing = createMemoryDocumentLibrary(); let failWrites = false;
    const library: DocumentLibrary = { ...backing, persistence: "indexeddb", put: async (input, revision) => failWrites ? { ok: false, error: { code: "storage-quota", message: "Quota exceeded" } } : backing.put(input, revision) };
    const { result } = renderHook(() => useDocumentWorkspace({ library }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.create("text"));
    act(() => result.current.changeText("keep me open")); failWrites = true;
    let allowed: boolean | undefined;
    await act(async () => { allowed = await result.current.prepareClose(); });
    expect(allowed).toBe(false); expect(result.current.session?.text).toBe("keep me open"); expect(result.current.error).toContain("Quota exceeded");
  });

  it("releases inactive native handles and unused failed-import leases", async () => {
    const library = createMemoryDocumentLibrary(), releaseDocument = vi.fn().mockResolvedValue(undefined);
    const handle: WebFileHandle = { name: "opened.txt", getFile: async () => ({ name: "opened.txt", size: 4, arrayBuffer: async () => textBytes("text").buffer }) };
    const broken: WebFileHandle = { ...handle, name: "broken.docx" };
    const { result } = renderHook(() => useDocumentWorkspace({ library, releaseDocument }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.importPayload({ ...payload("opened.txt", textBytes("text")), handle }));
    expect(releaseDocument).not.toHaveBeenCalled();
    await act(() => result.current.create("text"));
    await waitFor(() => expect(releaseDocument).toHaveBeenCalledWith(handle));
    await act(() => result.current.importPayload({ ...payload("broken.docx", new Uint8Array([1, 2, 3])), handle: broken }));
    expect(result.current.session?.name).toBe("Untitled.txt");
    await waitFor(() => expect(releaseDocument).toHaveBeenCalledWith(broken));
  });

  it("does not release a previous native handle until its in-flight save completes", async () => {
    const library = createMemoryDocumentLibrary(), releaseDocument = vi.fn().mockResolvedValue(undefined);
    const handle: WebFileHandle = { name: "opened.txt", getFile: async () => ({ name: "opened.txt", size: 4, arrayBuffer: async () => textBytes("text").buffer }) };
    const saving = deferred<WebSaveReceipt | null>();
    const saveDocument = vi.fn().mockReturnValue(saving.promise);
    const { result } = renderHook(() => useDocumentWorkspace({ library, releaseDocument, saveDocument }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.importPayload({ ...payload("opened.txt", textBytes("text")), handle }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.saveFile(); });
    await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());
    await act(() => result.current.create("text"));
    expect(releaseDocument).not.toHaveBeenCalled();
    await act(async () => { saving.resolve({ method: "file-system", name: "opened.txt", handle }); await pending; });
    await waitFor(() => expect(releaseDocument).toHaveBeenCalledOnce());
    expect(releaseDocument).toHaveBeenCalledWith(handle);
    expect(result.current.session?.name).toBe("Untitled.txt");
  });
});
