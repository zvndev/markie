import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordParagraph } from "./word-paragraph";
import type { DocxParagraph } from "@/lib/office/docx";
afterEach(cleanup);
const paragraph: DocxParagraph = { id: "p1", text: "alpha beta", revisionIds: [], runs: [
  { id: "r1", text: "alpha ", style: { bold: true }, canEdit: true, pageBreaks: [] },
  { id: "r2", text: "beta", style: { italic: true }, canEdit: true, pageBreaks: [] },
] };
function selectText(node: Node, start: number, end: number) { const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); }
function mount(source = paragraph) {
  const onRuns = vi.fn(), onPasteParagraphs = vi.fn(), onRemovePageBreaks = vi.fn(), onRejectStructure = vi.fn(), onReplace = vi.fn(), onSplit = vi.fn();
  render(<WordParagraph paragraph={source} index={0} selected readOnly={false} onSelect={vi.fn()} onReplace={onReplace} onRuns={onRuns} onSplit={onSplit} onPasteParagraphs={onPasteParagraphs} onRemovePageBreaks={onRemovePageBreaks} onRejectStructure={onRejectStructure} />);
  return { field: screen.getByRole("textbox"), onRuns, onPasteParagraphs, onRemovePageBreaks, onRejectStructure, onReplace, onSplit };
}
describe("Word paragraph user editing", () => {
  it("recolors authored runs in place when the page theme changes mid-composition", () => {
    const source: DocxParagraph = { ...paragraph, runs: [{ ...paragraph.runs[0], style: { color: "000000" } }, paragraph.runs[1]] };
    const onRuns = vi.fn(), onRejectStructure = vi.fn();
    const field = (background: string) => <WordParagraph paragraph={source} index={0} selected readOnly={false} pageBackground={background} onSelect={vi.fn()} onReplace={vi.fn()} onRuns={onRuns} onSplit={vi.fn()} onPasteParagraphs={vi.fn()} onRemovePageBreaks={vi.fn()} onRejectStructure={onRejectStructure} />;
    const view = render(field("#f8fafc")), node = screen.getByRole("textbox"), black = node.querySelector<HTMLElement>("[data-run-id=r1]")!;
    expect(black).toHaveStyle({ color: "#000000" });
    fireEvent.compositionStart(node);
    view.rerender(field("#09090b"));
    expect(node.querySelector("[data-run-id=r1]")).toBe(black);
    expect(black.style.color).toBe("var(--foreground)");
    expect(black.dataset.expectedStyle).toBe(black.getAttribute("style"));
    black.textContent = "alphaあ ";
    fireEvent.compositionEnd(node);
    expect(onRejectStructure).not.toHaveBeenCalled();
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r1", text: "alphaあ " }]);
  });
  it("restores the pre-input caret after rejected noncancelable browser mutation", async () => {
    const source = { ...paragraph, text: "abc", runs: [{ ...paragraph.runs[0], text: "abc" }] };
    function Host() {
      const [token, setToken] = useState(0);
      return <WordParagraph paragraph={source} index={0} selected readOnly={false} onSelect={vi.fn()} onReplace={vi.fn()} onRuns={vi.fn()} onSplit={vi.fn()} onPasteParagraphs={vi.fn()} onRemovePageBreaks={vi.fn()} onRejectStructure={() => setToken((value) => value + 1)} reconcileToken={token} />;
    }
    render(<Host />); const field = screen.getByRole("textbox"); field.focus();
    selectText(field.querySelector("span")!.firstChild!, 1, 1);
    fireEvent(field, new InputEvent("beforeinput", { inputType: "insertText", data: "X", bubbles: true, cancelable: false }));
    field.querySelector("span")!.firstChild!.textContent = "aXbc"; selectText(field.querySelector("span")!.firstChild!, 2, 2); fireEvent.input(field);
    await waitFor(() => expect(field.textContent).toBe("abc"));
    expect(window.getSelection()!.anchorOffset).toBe(1);
  });
  it.each([false, true])("restores a backward selection after rejected %s composition/native DOM input, then types at the original range", async (composition) => {
    const source = { ...paragraph, text: "abcde", runs: [{ ...paragraph.runs[0], text: "abcde" }] }, onRuns = vi.fn();
    function Host() {
      const [token, setToken] = useState(0);
      return <WordParagraph paragraph={source} index={0} selected readOnly={false} onSelect={vi.fn()} onReplace={vi.fn()} onRuns={onRuns} onSplit={vi.fn()} onPasteParagraphs={vi.fn()} onRemovePageBreaks={vi.fn()} onRejectStructure={() => setToken((value) => value + 1)} reconcileToken={token} />;
    }
    render(<Host />); const field = screen.getByRole("textbox"); field.focus();
    const text = field.querySelector("span")!.firstChild!, selection = window.getSelection()!;
    selectText(text, 1, 4); selection.collapse(text, 4); selection.extend(text, 1);
    if (composition) fireEvent.compositionStart(field);
    else fireEvent(field, new InputEvent("beforeinput", { inputType: "insertText", data: "X", bubbles: true, cancelable: false }));
    field.textContent = "aXe"; selectText(field.firstChild!, 2, 2);
    if (composition) fireEvent.compositionEnd(field); else fireEvent.input(field);
    await waitFor(() => expect(field.textContent).toBe("abcde"));
    expect(selection.toString()).toBe("bcd"); expect(selection.anchorOffset).toBe(4); expect(selection.focusOffset).toBe(1);
    fireEvent(field, new InputEvent("beforeinput", { inputType: "insertText", data: "Y", bubbles: true, cancelable: true }));
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r1", text: "aYe" }]);
  });
  it("handles native beforeinput replacement spanning styled runs without browser DOM mutation", () => {
    const { field, onRuns, onReplace } = mount();
    const spans = field.querySelectorAll("[data-run-id]"), range = document.createRange();
    range.setStart(spans[0].firstChild!, 3); range.setEnd(spans[1].firstChild!, 2);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const event = new InputEvent("beforeinput", { inputType: "insertText", data: "X", bubbles: true, cancelable: true });
    fireEvent(field, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r1", text: "alpX" }, { runId: "r2", text: "ta" }]);
    expect(field.textContent).toBe("alpha beta"); expect(onReplace).not.toHaveBeenCalled();
  });
  it("does not split while IME confirms a candidate and does not flatten unknown DOM structure", () => {
    const { field, onSplit, onReplace, onRejectStructure } = mount();
    fireEvent.compositionStart(field); fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(onSplit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    field.textContent = "flattened"; fireEvent.input(field);
    expect(onRejectStructure).toHaveBeenCalled(); expect(onReplace).not.toHaveBeenCalled();
  });
  it("keeps HTML-only paste and cancelled/unsupported input byte-neutral", () => {
    const { field, onRuns, onReplace, onRejectStructure } = mount();
    selectText(field.querySelector("span")!.firstChild!, 0, 3);
    fireEvent.paste(field, { clipboardData: { getData: () => "" } });
    fireEvent(field, new InputEvent("beforeinput", { inputType: "formatBold", bubbles: true, cancelable: true }));
    expect(onRuns).not.toHaveBeenCalled(); expect(onReplace).not.toHaveBeenCalled(); expect(onRejectStructure).toHaveBeenCalled();
  });
  it("cuts a mixed-run selection through the source adapter and plain clipboard", () => {
    const { field, onRuns } = mount(), setData = vi.fn();
    const spans = field.querySelectorAll("span"), range = document.createRange();
    range.setStart(spans[0].firstChild!, 3); range.setEnd(spans[1].firstChild!, 2);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.cut(field, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "ha be");
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r1", text: "alp" }, { runId: "r2", text: "ta" }]);
  });
  it("uses ordinary links only in a read-only paragraph and retains editing selection spans", () => {
    const linked = { ...paragraph, runs: [{ ...paragraph.runs[0], hyperlinkId: "link1", target: "https://example.com/post" }] };
    const props = { paragraph: linked, index: 0, selected: true, readOnly: true, onSelect: vi.fn(), onReplace: vi.fn(), onRuns: vi.fn(), onSplit: vi.fn(), onPasteParagraphs: vi.fn(), onRemovePageBreaks: vi.fn(), onRejectStructure: vi.fn() };
    const view = render(<WordParagraph {...props} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com/post");
    view.rerender(<WordParagraph {...props} readOnly={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("textbox").querySelector("span[data-run-id]")).not.toBeNull();
  });
  it("replaces a selected run on plain paste without flattening other styles", () => {
    const { field, onRuns } = mount();
    selectText(field.querySelectorAll("span")[1].firstChild!, 0, 4);
    fireEvent.paste(field, { clipboardData: { getData: () => "replacement" } });
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r2", text: "replacement" }]);
    expect(field.querySelectorAll("span")[0].style.fontWeight).toBe("700");
  });
  it("passes exact selection offsets for multi-paragraph paste", () => {
    const { field, onPasteParagraphs } = mount();
    selectText(field.querySelectorAll("span")[1].firstChild!, 0, 4);
    fireEvent.paste(field, { clipboardData: { getData: () => "one\r\ntwo" } });
    expect(onPasteParagraphs).toHaveBeenCalledWith("p1", 6, 10, "one\ntwo");
  });
  it("does not commit partial IME composition", () => {
    const { field, onRuns } = mount();
    fireEvent.compositionStart(field);
    field.querySelectorAll("span")[1].textContent = "日本語";
    fireEvent.input(field);
    expect(onRuns).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r2", text: "日本語" }]);
  });
  it("maps a marker-only native deletion to a real page-break operation", () => {
    const { field, onRemovePageBreaks, onRejectStructure, onRuns } = mount({ ...paragraph, runs: [{ ...paragraph.runs[0], text: paragraph.text, pageBreaks: [{ id: "break1", offset: paragraph.text.length }] }] });
    screen.getByRole("separator", { name: "Page break" }).remove(); fireEvent.input(field);
    expect(onRemovePageBreaks).toHaveBeenCalledWith(["break1"]);
    expect(onRejectStructure).not.toHaveBeenCalled(); expect(onRuns).not.toHaveBeenCalled();
  });
  it("keeps a trailing mixed-run break visible while its text grows before it", () => {
    const { field, onRuns, onRejectStructure } = mount({ ...paragraph, runs: [{ ...paragraph.runs[0], text: paragraph.text, pageBreaks: [{ id: "break1", offset: paragraph.text.length }] }] });
    const span = field.querySelector<HTMLElement>("[data-run-id]")!;
    span.firstChild!.textContent = `X${paragraph.text}`; fireEvent.input(field);
    expect(onRuns).toHaveBeenCalledWith([{ runId: "r1", text: `X${paragraph.text}` }]);
    expect(screen.getByRole("separator", { name: "Page break" })).toBeInTheDocument();
    expect(onRejectStructure).not.toHaveBeenCalled();
  });
});
