import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const onRuns = vi.fn(), onPasteParagraphs = vi.fn(), onRemovePageBreaks = vi.fn(), onRejectStructure = vi.fn();
  render(<WordParagraph paragraph={source} index={0} selected readOnly={false} onSelect={vi.fn()} onReplace={vi.fn()} onRuns={onRuns} onSplit={vi.fn()} onPasteParagraphs={onPasteParagraphs} onRemovePageBreaks={onRemovePageBreaks} onRejectStructure={onRejectStructure} />);
  return { field: screen.getByRole("textbox"), onRuns, onPasteParagraphs, onRemovePageBreaks, onRejectStructure };
}
describe("Word paragraph user editing", () => {
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
