import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordDocumentEditor } from "./word-document-editor";
import { applyDocxOperations, createDocx, exportDocx, openDocx, type DocxDocument } from "@/lib/office/docx";
import type { DocumentCommandTarget } from "@/lib/document-commands";
afterEach(cleanup);
function editor(initial: DocxDocument, onHistory?: () => void, localControls = false) {
  const state = { document: initial, target: null as DocumentCommandTarget | null };
  const commands = (target: DocumentCommandTarget | null) => { state.target = target; };
  function Host({ readOnly = false, inert = false }: { readOnly?: boolean; inert?: boolean }) {
    const [document, setDocument] = useState(initial);
    return <div inert={inert}><WordDocumentEditor document={document} readOnly={readOnly} onCommandsReady={localControls ? undefined : commands} onHistory={onHistory} onChange={(next) => { state.document = next; setDocument(next); }} /></div>;
  }
  const view = render(<Host />);
  return { ...view, state, execute: (id: string) => act(() => state.target!.execute(id)), mode: (props: { readOnly?: boolean; inert?: boolean }) => view.rerender(<Host {...props} />) };
}
function select(start: number, end: number) {
  const paragraph = screen.getByRole("textbox", { name: "Paragraph 1" }), text = paragraph.querySelector("span")!.firstChild!;
  const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(paragraph);
  return paragraph;
}
describe("Word renderer inside Markie", () => {
  it("uses the shared formatting toolbar with no Office tabs or permanent advanced panel", async () => {
    editor(await createDocx("Markie document"));
    expect(screen.getByRole("toolbar", { name: "Document formatting" })).toHaveAttribute("data-markie-doc-toolbar");
    expect(screen.queryByRole("tablist")).toBeNull(); expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByLabelText("Find Word text")).toBeNull();
    expect(screen.queryByRole("button", { name: "Document commands" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inline code" })).toBeNull();
  });
  it("keeps advanced commands reachable through the existing palette in cloud and standalone renderers", async () => {
    const view = editor(await createDocx("Standalone or shared Word"), undefined, true);
    fireEvent.click(screen.getByRole("button", { name: "Document commands" }));
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "Page Setup" } });
    fireEvent.click(screen.getByRole("option", { name: /Page Setup/ }));
    await screen.findByRole("dialog", { name: "Page Setup" }); expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Landscape" })); fireEvent.click(screen.getByRole("button", { name: "Close Page Setup" }));
    const reopened = await openDocx(await exportDocx(view.state.document)); expect(reopened.pageLayout.orientation).toBe("landscape"); expect(reopened.text).toBe("Standalone or shared Word");
  });
  it("preserves a selected range across the local command palette and omits readonly mutations", async () => {
    const view = editor(await createDocx("Hello Word"), undefined, true); const paragraph = select(6, 10);
    fireEvent.keyDown(paragraph, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "Bold" } }); fireEvent.click(screen.getByRole("option", { name: /Bold/ }));
    await waitFor(() => expect(view.state.document.paragraphs[0].runs[1]?.style.bold).toBe(true));
    expect(view.state.document.paragraphs[0].runs[0]).toMatchObject({ text: "Hello " }); expect(view.state.document.paragraphs[0].runs[0].style.bold).not.toBe(true);
    view.mode({ readOnly: true }); fireEvent.click(screen.getByRole("button", { name: "Document commands" }));
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "Page Setup" } }); expect(screen.queryByRole("option", { name: /Page Setup/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "Find and Replace" } }); fireEvent.click(screen.getByRole("option", { name: /Find and Replace/ }));
    await screen.findByRole("dialog", { name: "Find and Replace" });
    fireEvent.change(screen.getByLabelText("Find Word text"), { target: { value: "Word" } }); expect(screen.getByRole("button", { name: "Replace all" })).toBeDisabled();
  });
  it("preserves selected-range formatting after native commands and font controls take focus", async () => {
    const view = editor(await createDocx("Hello Word")); select(6, 10);
    view.execute("format-bold");
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "Georgia" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: 24 } });
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0].runs[0].text).toBe("Hello "); expect(reopened.paragraphs[0].runs[0].style.bold).not.toBe(true);
    expect(reopened.paragraphs[0].runs[1]).toMatchObject({ text: "Word", style: { bold: true, fontFamily: "Georgia", fontSizePoints: 24 } });
    view.execute("undo"); expect(view.state.document.paragraphs[0].runs[1].style.fontSizePoints).not.toBe(24);
    view.execute("redo"); expect(view.state.document.paragraphs[0].runs[1].style.fontSizePoints).toBe(24);
  });
  it("opens focused native-menu dialogs and traps Tab, closes Escape and restores focus", async () => {
    const view = editor(await createDocx("Find this text")); const paragraph = screen.getByRole("textbox", { name: "Paragraph 1" }); paragraph.focus();
    view.execute("find"); const dialog = screen.getByRole("dialog", { name: "Find and Replace" });
    expect(view.state.target).toMatchObject({ modalOpen: true, enabledCommands: [] });
    view.execute("insert-paragraph"); expect(view.state.document.paragraphs).toHaveLength(1);
    expect(screen.getByLabelText("Find Word text")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Find Word text"), { target: { value: "Find" } });
    const close = within(dialog).getByRole("button", { name: "Close Find and Replace" }); close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(within(dialog).getByRole("button", { name: "Replace all" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(paragraph).toHaveFocus();
  });
  it("executes layout, list, heading, paragraph spacing and table operations without tab navigation", async () => {
    const view = editor(await createDocx("Paragraph"));
    view.execute("format-heading-3"); view.execute("format-numbering"); view.execute("format-align-justify"); view.execute("layout-a4"); view.execute("layout-landscape");
    view.execute("layout-paragraph-spacing"); fireEvent.blur(screen.getByLabelText("Space after (pt)"), { target: { value: 18 } });
    fireEvent.click(screen.getByRole("button", { name: "2× spacing" })); fireEvent.click(screen.getByRole("button", { name: "Close Paragraph Spacing" }));
    view.execute("insert-table"); fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0]).toMatchObject({ styleId: "Heading3", listKind: "numbered", alignment: "both", spacingAfterPoints: 18, lineSpacingMultiple: 2 });
    expect(reopened.pageLayout).toMatchObject({ orientation: "landscape" }); expect(reopened.tables).toHaveLength(1);
  });
  it("preserves link editing/removal and cursor page breaks through menu dialogs", async () => {
    const view = editor(await createDocx("Link this text")); select(0, 4); view.execute("insert-link");
    fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Link selected text" }));
    expect(view.state.document.hyperlinks).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Remove link" })); expect(view.state.document.hyperlinks).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close Link and Page Breaks" }));
    const paragraph = screen.getByRole("textbox", { name: "Paragraph 1" }); paragraph.focus();
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(paragraph);
    view.execute("insert-page-break"); expect(view.state.document.pageBreaks).toHaveLength(1);
  });
  it("keeps read-only, original-view, missing-selection, unsupported and inert commands from changing bytes", async () => {
    const initial = applyDocxOperations(await createDocx("Original"), [{ type: "track-paragraph-text", paragraphId: "p0", text: "Updated", author: "You" }]);
    const view = editor(initial), original = await exportDocx(initial);
    view.execute("review-original"); expect(view.state.target?.enabledCommands).not.toContain("format-bold"); view.execute("layout-landscape");
    expect(await exportDocx(view.state.document)).toEqual(original);
    view.execute("review-final"); view.mode({ readOnly: true }); view.execute("format-bold"); view.execute("insert-paragraph");
    expect(screen.getByLabelText("Font")).toBeDisabled(); expect(screen.getByRole("spinbutton", { name: "Font size" })).toBeDisabled();
    view.mode({ inert: true }); view.execute("layout-a4"); view.execute("find"); expect(screen.queryByRole("dialog")).toBeNull();
    view.mode({}); expect(view.state.target?.enabledCommands).not.toContain("insert-link"); view.execute("insert-link"); view.execute("format-strike"); view.execute("unknown-command");
    expect(await exportDocx(view.state.document)).toEqual(original);
  });
  it("changes zoom and history without changing document font bytes", async () => {
    const history = vi.fn(), view = editor(await createDocx("Same content"), history), before = await exportDocx(view.state.document);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" })); expect(screen.getByText("110%")).toBeInTheDocument();
    view.execute("view-continuous"); view.execute("view-outline"); view.execute("document-history");
    expect(view.container.querySelector(".docs-word-continuous")).not.toBeNull(); expect(screen.getByRole("navigation", { name: "Document outline" })).toBeInTheDocument();
    expect(history).toHaveBeenCalledOnce(); expect(await exportDocx(view.state.document)).toEqual(before);
  });
  it("reports an imported font and custom paragraph style without substituting toolbar defaults", async () => {
    const initial = applyDocxOperations(await createDocx("Imported title"), [{ type: "format-run", runId: "p0:r0", style: { fontFamily: "Cambria" } }, { type: "format-paragraph", paragraphId: "p0", format: { styleId: "Title" } }]);
    editor(initial);
    expect(screen.getByLabelText("Font")).toHaveDisplayValue("Cambria"); expect(screen.getByLabelText("Paragraph style")).toHaveDisplayValue("Title");
  });
  it("keeps cloud/local find focus and dialog IDs in their own document", async () => {
    const local = await createDocx("LOCAL secret"), cloud = await createDocx("CLOUD target");
    const localChange = vi.fn(), cloudChange = vi.fn(), commands = { current: null as DocumentCommandTarget | null };
    const view = render(<><WordDocumentEditor document={local} onChange={localChange} /><WordDocumentEditor document={cloud} onChange={cloudChange} onCommandsReady={(target) => { commands.current = target; }} /></>);
    const editors = view.container.querySelectorAll(".docs-word-host"); fireEvent.keyDown(editors[1], { key: "f", ctrlKey: true });
    const query = screen.getByRole("textbox", { name: "Find Word text" }); fireEvent.change(query, { target: { value: "target" } });
    fireEvent.click(screen.getByRole("button", { name: "Find next" })); expect(query).toHaveFocus();
    expect(editors[1].contains(document.activeElement)).toBe(true); expect(editors[0].contains(document.activeElement)).toBe(false);
    const dialog = screen.getByRole("dialog"); expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)).toHaveTextContent("Find and Replace");
    await waitFor(() => expect(within(editors[0] as HTMLElement).queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close Find and Replace" })); act(() => commands.current!.execute("format-bold"));
    expect(localChange).not.toHaveBeenCalled();
    const edited = cloudChange.mock.calls.at(-1)![0] as DocxDocument;
    expect(edited.paragraphs[0].runs.map((run) => ({ text: run.text, bold: !!run.style.bold }))).toEqual([{ text: "CLOUD ", bold: false }, { text: "target", bold: true }]);
  });
});
