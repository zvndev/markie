import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordDocumentEditor } from "./word-document-editor";
import { applyDocxOperations, createDocx, exportDocx, openDocx, type DocxDocument } from "@/lib/office/docx";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import { customStyleFixture } from "@/lib/office/docx-styles.fixture";
import { readZip, writeZip } from "@/lib/office/zip";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  it("retains selected Word ranges when compact overflow opens advanced tools and keeps Escape local", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: { width: 760 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
    });
    const view = editor(await createDocx("Hello Word")); select(6, 10);
    const before = await exportDocx(view.state.document), more = screen.getByRole("button", { name: "More formatting" });
    fireEvent.click(more); expect(screen.getByRole("dialog", { name: "More formatting" })).toBeInTheDocument();
    expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(more).toHaveFocus();
    fireEvent.click(more); fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    expect(screen.queryByRole("dialog", { name: "More formatting" })).toBeNull();
    const link = screen.getByRole("dialog", { name: "Link and Page Breaks" });
    fireEvent.change(within(link).getByLabelText("Link address"), { target: { value: "https://example.com/selected" } });
    fireEvent.click(within(link).getByRole("button", { name: "Link selected text" }));
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.hyperlinks).toMatchObject([{ text: "Word", target: "https://example.com/selected" }]);
    expect(reopened.paragraphs[0].runs[0].text).toBe("Hello ");
  });
  it("matches native and dropdown Normal without confusing a custom document default on export/reopen", async () => {
    const imported = await customStyleFixture("EditorialLead"), parts = await readZip(imported.bytes), encoder = new TextEncoder(), decoder = new TextDecoder();
    const stylesPart = parts.find((part) => part.name === "word/styles.xml")!;
    stylesPart.data = encoder.encode(decoder.decode(stylesPart.data).replace('w:default="1" ', "").replace('w:styleId="EditorialBody"', 'w:default="1" w:styleId="EditorialBody"'));
    const initial = await openDocx(writeZip(parts)), view = editor(initial), style = screen.getByRole("combobox", { name: "Paragraph style" });
    expect(within(style).getByRole("option", { name: "Default paragraph" })).toHaveValue("");
    expect(within(style).getByRole("option", { name: /^Normal$/ })).toHaveValue("Normal");
    view.execute("format-normal");
    const nativeBytes = await exportDocx(view.state.document), native = await openDocx(nativeBytes);
    expect(native.paragraphs[0].styleId).toBe("Normal");
    expect(style).toHaveDisplayValue("Normal");
    view.execute("undo");
    fireEvent.change(style, { target: { value: "Normal" } });
    const dropdownBytes = await exportDocx(view.state.document), dropdown = await openDocx(dropdownBytes);
    expect(dropdownBytes).toEqual(nativeBytes);
    expect(dropdown.paragraphs[0].runs.map((run) => run.style)).toEqual(initial.paragraphs[0].runs.map((run) => run.style));
    fireEvent.change(style, { target: { value: "" } });
    const defaultParagraph = await openDocx(await exportDocx(view.state.document));
    expect(defaultParagraph.paragraphs[0].styleId).toBeUndefined();
    expect(defaultParagraph.paragraphs[0].runs[1].resolvedStyle).toMatchObject({ bold: true, fontFamily: "Aptos", fontSizePoints: 16 });
    expect(native.paragraphs[0].runs[1].resolvedStyle).toMatchObject({ fontFamily: "Cambria", fontSizePoints: 11 });
    expect(native.paragraphs[0].runs[1].resolvedStyle?.bold).not.toBe(true);
  });
  it("offers imported style names and assigns the real ID without baking guessed run formatting", async () => {
    const imported = await customStyleFixture(), view = editor(imported.document);
    const style = screen.getByRole("combobox", { name: "Paragraph style" });
    expect(style).toHaveDisplayValue("Editorial body");
    expect(within(style).getByRole("option", { name: "Editorial lead" })).toHaveValue("EditorialLead");
    expect(within(style).queryByRole("option", { name: "Character accent" })).toBeNull();
    fireEvent.change(style, { target: { value: "EditorialLead" } });
    expect(view.state.document.paragraphs[0].styleId).toBe("EditorialLead");
    expect(view.state.document.paragraphs[0].runs.map((run) => run.style)).toEqual(imported.document.paragraphs[0].runs.map((run) => run.style));
    expect(screen.getByRole("textbox", { name: "Paragraph 1" })).toHaveStyle({ textAlign: "center", marginBottom: "12pt" });
    const rendered = screen.getByRole("textbox", { name: "Paragraph 1" }).querySelectorAll("[data-run-id]");
    expect(rendered[0]).toHaveStyle({ fontWeight: "400", color: "#cc0000", fontSize: "9pt", fontFamily: "Aptos", fontStyle: "italic" });
    expect(rendered[1]).toHaveStyle({ fontWeight: "700", fontSize: "16pt" });
    const bytes = await exportDocx(view.state.document), reopened = await openDocx(bytes);
    expect(reopened.paragraphs[0].styleId).toBe("EditorialLead");
    const parts = await readZip(bytes); expect(new TextDecoder().decode(parts.find((part) => part.name === "word/styles.xml")!.data)).toBe(imported.styles);
    view.execute("undo"); expect(view.state.document.paragraphs[0].styleId).toBe("EditorialBody");
    view.execute("redo"); expect(view.state.document.paragraphs[0].styleId).toBe("EditorialLead");
  });
  it("shows mixed fonts, sizes and bold for a real multi-run range and toggles the entire selection coherently", async () => {
    const { document: imported } = await customStyleFixture();
    const initial = applyDocxOperations(imported, [{ type: "format-run", runId: imported.paragraphs[0].runs[0].id, style: { fontFamily: "Georgia" } }]);
    const view = editor(initial), paragraph = screen.getByRole("textbox", { name: "Paragraph 1" });
    const spans = paragraph.querySelectorAll("[data-run-id]"), range = document.createRange();
    range.setStart(spans[0].firstChild!, 2); range.setEnd(spans[1].firstChild!, 3); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(paragraph);
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByLabelText("Font")).toHaveDisplayValue("Mixed fonts");
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toHaveAttribute("placeholder", "Mixed");
    fireEvent.keyDown(paragraph, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0].runs.map((run) => [run.text, run.style.bold])).toEqual([["Al", false], ["pha ", false], ["Bet", false], ["a", undefined]]);
    expect(reopened.paragraphs[0].runs[3].resolvedStyle?.bold).toBe(true);
  });
  it("shows unspecified font size honestly, rejects cross-paragraph ranges and ignores background modal mutations", async () => {
    const view = editor(await createDocx("First\nSecond")), before = await exportDocx(view.state.document);
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toHaveValue(null);
    expect(screen.getByLabelText("Font")).toHaveDisplayValue("Inherited font");
    const first = screen.getByRole("textbox", { name: "Paragraph 1" }), second = screen.getByRole("textbox", { name: "Paragraph 2" });
    const range = document.createRange(); range.setStart(first.querySelector("span")!.firstChild!, 1); range.setEnd(second.querySelector("span")!.firstChild!, 2); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(first);
    expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
    view.execute("format-bold"); view.execute("format-align-center"); view.execute("format-heading-1"); fireEvent.keyDown(first, { key: "b", ctrlKey: true });
    expect(await exportDocx(view.state.document)).toEqual(before);
    select(0, 2); view.execute("format-font");
    const dialog = screen.getByRole("dialog", { name: "Font" });
    fireEvent.change(within(screen.getByRole("toolbar")).getByLabelText("Font"), { target: { value: "Arial" } });
    fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "Heading1" } });
    expect(first).toHaveAttribute("contenteditable", "false"); fireEvent.input(first);
    expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.blur(within(dialog).getByLabelText("Font family")); expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps mixed font dialogs byte-neutral until an actual value is applied, then clears back to inheritance", async () => {
    const { document: initial } = await customStyleFixture("EditorialLead"), view = editor(initial), paragraph = screen.getByRole("textbox", { name: "Paragraph 1" });
    const range = document.createRange(); range.selectNodeContents(paragraph); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(paragraph);
    const before = await exportDocx(view.state.document); view.execute("format-font");
    const dialog = screen.getByRole("dialog", { name: "Font" }), size = within(dialog).getByRole("spinbutton", { name: "Font size" });
    expect(size).toHaveValue(null); expect(size).toHaveAttribute("placeholder", "Mixed");
    expect(within(dialog).getByLabelText("Font family")).toHaveValue("Aptos");
    fireEvent.blur(size); fireEvent.blur(within(dialog).getByLabelText("Font family")); expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.blur(size, { target: { value: "21.5" } });
    expect(view.state.document.paragraphs[0].runs.every((run) => run.style.fontSizePoints === 21.5)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear formatting" }));
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0].runs.every((run) => run.style.fontSizePoints === undefined && run.resolvedStyle?.fontSizePoints === 16)).toBe(true);
    expect(reopened.paragraphs[0].styleId).toBe("EditorialLead");
  });
  it("uses effective inherited underline for keyboard toggles and restores it with undo", async () => {
    const imported = await customStyleFixture("EditorialBody", "CharacterAccent");
    const view = editor(imported.document), paragraph = screen.getByRole("textbox", { name: "Paragraph 1" }), text = paragraph.querySelectorAll("[data-run-id]")[1].firstChild!;
    const range = globalThis.document.createRange(); range.setStart(text, 1); range.setEnd(text, 3); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(text.parentElement!);
    expect(screen.getByRole("button", { name: "Underline" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(paragraph, { key: "u", metaKey: true });
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0].runs.map((run) => [run.text, run.resolvedStyle?.underline])).toEqual([["Alpha ", undefined], ["B", "single"], ["et", "none"], ["a", "single"]]);
    view.execute("undo"); expect(view.state.document.paragraphs[0].runs[1].resolvedStyle?.underline).toBe("single");
  });
  it("shows inherited and mixed colors honestly without mutating on Font dialog open", async () => {
    const imported = await customStyleFixture(), view = editor(imported.document), paragraph = screen.getByRole("textbox", { name: "Paragraph 1" }), before = await exportDocx(view.state.document);
    const text = paragraph.querySelectorAll("[data-run-id]")[1].firstChild!, range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 4); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent.pointerUp(text.parentElement!);
    view.execute("format-font");
    const inherited = screen.getByRole("dialog", { name: "Font" });
    expect(within(inherited).getByLabelText("Text color")).toHaveValue("#333333");
    fireEvent.blur(within(inherited).getByLabelText("Font family"));
    expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.click(within(inherited).getByRole("button", { name: "Close Font" }));
    const all = document.createRange(); all.selectNodeContents(paragraph); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(all); fireEvent.pointerUp(paragraph);
    view.execute("format-font");
    const mixed = screen.getByRole("dialog", { name: "Font" });
    expect(within(mixed).getByText("Mixed colors")).toBeInTheDocument();
    expect(within(mixed).queryByLabelText("Text color")).toBeNull();
    const applyColor = within(mixed).getByLabelText("Apply text color");
    expect(applyColor).toHaveAttribute("title", "Choose a color to apply to the selection");
    fireEvent.blur(applyColor); expect(await exportDocx(view.state.document)).toEqual(before);
    fireEvent.change(applyColor, { target: { value: "#446688" } });
    const reopened = await openDocx(await exportDocx(view.state.document));
    expect(reopened.paragraphs[0].runs.every((run) => run.style.color === "446688")).toBe(true);
    expect(reopened.paragraphs[1].runs[0].style.color).toBeUndefined();
  });
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
