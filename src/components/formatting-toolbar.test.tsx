import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "@/lib/doc-appearance";
import type { FormattingAction, FormattingToolbarProps } from "@/lib/format-controls";
import { FormattingToolbar } from "./formatting-toolbar";
import { createDocumentSession } from "@/lib/document-session";
import { createDocx } from "@/lib/office/docx";
import { TextDocumentEditor } from "./documents/text-document-editor";
import { WordDocumentEditor } from "./documents/word-document-editor";
afterEach(() => vi.unstubAllGlobals());

function constrainToolbar(width: number, leadingWidth = 0) {
  const observed = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { observed.set(target, this.callback); this.callback([{ target, contentRect: { width: target.hasAttribute("data-markie-toolbar-start") ? leadingWidth : width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
  return (nextWidth: number, nextLeadingWidth: number) => act(() => {
    for (const [target, callback] of observed) callback([{ target, contentRect: { width: target.hasAttribute("data-markie-toolbar-start") ? nextLeadingWidth : nextWidth } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

function renderFormattingToolbar(overrides: Partial<FormattingToolbarProps> = {}) {
  const callbacks = {
    onAppearance: vi.fn(), onFont: vi.fn(), onSize: vi.fn(), onStyle: vi.fn(),
    onAction: vi.fn(), onColor: vi.fn(),
  };
  const view = render(<FormattingToolbar
    state={{ canUndo: true, canRedo: true, bold: true }} canEdit
    appearance={DEFAULT_APPEARANCE} currentStyle="paragraph" currentFont="system"
    selecting={false} currentSize={16} {...callbacks} {...overrides}
  />);
  return { ...callbacks, view };
}

describe("shared compact formatting controls", () => {
  it.each(["text", "csv", "markdown"] as const)("reserves measured %s caller chrome and refits when its badge or toolbar changes size", async (format) => {
    const resize = constrainToolbar(390, 220);
    const session = await createDocumentSession(format);
    render(<TextDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
    const leading = document.querySelector("[data-markie-toolbar-start]")!;
    expect(within(leading as HTMLElement).getByRole("button", { name: "Find" })).toBeInTheDocument();
    if (format === "csv") expect(within(leading as HTMLElement).getByRole("button", { name: "Table preview" })).toBeInTheDocument();
    if (format === "markdown") expect(within(leading as HTMLElement).getByRole("button", { name: "Source" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Font")).toBeNull();
    resize(700, 220);
    expect(screen.getByLabelText("Font")).toBeInTheDocument();
    resize(390, 330);
    expect(screen.queryByLabelText("Font size")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getAllByLabelText("Font size")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Find" })).toHaveLength(1);
  });
  it("reserves actual standalone Word Commands width rather than assuming a chrome-free row", async () => {
    const resize = constrainToolbar(390, 84);
    render(<WordDocumentEditor document={await createDocx("Hello")} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Document commands" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Font")).toBeNull();
    expect(screen.queryByRole("button", { name: "Align left" })).toBeNull();
    resize(900, 84);
    expect(screen.getByLabelText("Font")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Align left" })).toBeInTheDocument();
    resize(390, 240);
    expect(screen.queryByLabelText("Font size")).toBeNull();
  });
  const wordActions: FormattingAction[] = ["undo", "redo", "bold", "italic", "underline", "link", "image", "bullet", "ordered", "align-left", "align-center", "align-right", "clear"];
  it.each([900, 700, 650])("fits everyday Word controls into a %ipx row before overflowing secondary groups", async (width) => {
    constrainToolbar(width);
    const { onAction, onColor } = renderFormattingToolbar({ supportedActions: wordActions, showWidthControls: false, onPrint: vi.fn(), onHistory: vi.fn() });
    for (const label of ["Paragraph style", "Font", "Font size", "Text colour"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    for (const label of ["Bold", "Italic", "Underline", "Bullet list", "Numbered list", "Align left", "Align centre", "Align right"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(screen.queryByLabelText("Highlight colour")).toBeNull();
    expect(screen.queryByRole("button", { name: "Inline code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert image" }) !== null).toBe(width === 900);
    expect(screen.queryByRole("button", { name: "Clear formatting" }) !== null).toBe(width >= 700);
    await userEvent.click(screen.getByRole("button", { name: "Bullet list" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("bullet");
    fireEvent.change(screen.getByLabelText("Text colour"), { target: { value: "#dc2626" } });
    expect(onColor).toHaveBeenCalledExactlyOnceWith("#dc2626");
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    const popup = screen.getByRole("dialog", { name: "More formatting" });
    expect(within(popup).getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    if (width < 900) expect(within(popup).getByRole("button", { name: "Insert image" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Text colour")).toHaveLength(1);
  });
  it("keeps Word colour and lists at 390px while moving its real selectors and disabled secondary actions into More", async () => {
    constrainToolbar(390);
    const { onFont } = renderFormattingToolbar({ supportedActions: wordActions, showWidthControls: false, currentFont: "Arial", fonts: [{ id: "Arial", label: "Arial" }, { id: "Cambria", label: "Cambria" }] });
    expect(screen.queryByLabelText("Font")).toBeNull();
    expect(screen.getByLabelText("Text colour")).toBeInTheDocument();
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bullet list" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getAllByLabelText("Font")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "Cambria" } });
    expect(onFont).toHaveBeenCalledExactlyOnceWith("Cambria");
    expect(screen.queryByRole("dialog", { name: "More formatting" })).toBeNull();
    expect(screen.getByRole("button", { name: "More formatting" })).toHaveFocus();
  });
  it("retains Markdown highlight and supported actions without Word-only filtering at 900px", async () => {
    constrainToolbar(900);
    const onHighlight = vi.fn();
    renderFormattingToolbar({ onHighlight });
    expect(screen.getByLabelText("Highlight colour")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Strikethrough" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Highlight colour"), { target: { value: "#fef08a" } });
    expect(onHighlight).toHaveBeenCalledExactlyOnceWith("#fef08a");
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getAllByLabelText("Highlight colour")).toHaveLength(1);
  });
  it("dismisses only More formatting when Escape is pressed from its trigger inside a parent dialog", () => {
    constrainToolbar(760);
    const parentKeys = vi.fn();
    render(<div role="dialog" aria-label="Cloud document" onKeyDown={parentKeys}><FormattingToolbar
      state={{ canUndo: true }} canEdit appearance={DEFAULT_APPEARANCE} currentStyle="paragraph" currentFont="system"
      selecting={false} currentSize={16} onAppearance={vi.fn()} onFont={vi.fn()} onSize={vi.fn()} onStyle={vi.fn()} onAction={vi.fn()}
    /></div>);
    const more = screen.getByRole("button", { name: "More formatting" });
    fireEvent.click(more); more.focus();
    expect(screen.getByRole("dialog", { name: "More formatting" })).toBeInTheDocument();
    fireEvent.keyDown(more, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More formatting" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Cloud document" })).toBeInTheDocument();
    expect(parentKeys).not.toHaveBeenCalled(); expect(more).toHaveFocus();
  });
  it("keeps primary controls visible and moves real secondary actions into an accessible width-aware overflow", async () => {
    constrainToolbar(760);
    const { onAction, onAppearance } = renderFormattingToolbar();
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toHaveAttribute("data-compact", "true");
    expect(toolbar).not.toHaveClass("overflow-x-auto");
    for (const label of ["Bold", "Italic", "Underline", "Undo", "Redo"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(screen.getByLabelText("Paragraph style")).toHaveStyle({ width: "112px" });
    expect(screen.getByLabelText("Font")).toHaveStyle({ width: "104px" });
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert image" })).toBeNull();
    const more = screen.getByRole("button", { name: "More formatting" });
    fireEvent.keyDown(more, { key: "ArrowDown" });
    let popup = screen.getByRole("dialog", { name: "More formatting" });
    expect(within(popup).getByRole("button", { name: "Zoom out" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" }); expect([...popup.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')].at(-1)).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(more).toHaveFocus(); expect(onAction).not.toHaveBeenCalled();
    await userEvent.click(more); popup = screen.getByRole("dialog");
    await userEvent.click(within(popup).getByRole("button", { name: "Insert image" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("image"); expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(more); await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onAppearance).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_APPEARANCE, zoom: 1.1 });
  });
  it("retains narrow-width font/style access and readonly viewing controls without duplicate widgets", async () => {
    constrainToolbar(390);
    const { onStyle, onFont, view } = renderFormattingToolbar();
    expect(screen.queryByLabelText("Paragraph style")).toBeNull(); expect(screen.queryByLabelText("Font")).toBeNull();
    for (const label of ["Bold", "Italic", "Underline"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getAllByLabelText("Font")).toHaveLength(1); expect(screen.getAllByLabelText("Paragraph style")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "h2" } }); expect(onStyle).toHaveBeenCalledExactlyOnceWith("h2"); expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "serif" } }); expect(onFont).toHaveBeenCalledOnce();
    view.unmount();
    renderFormattingToolbar({ selecting: true, canEdit: false });
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getByRole("button", { name: "Insert image" })).toBeDisabled(); expect(screen.getByLabelText("Font")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Zoom in" })).not.toBeDisabled();
  });
  it("represents mixed text without claiming a selected font, size or toggle", () => {
    const { onSize } = renderFormattingToolbar({ state: { bold: "mixed", italic: false, underline: "mixed" }, selecting: true, currentFont: "", fontPlaceholder: "Mixed fonts", currentSize: null, sizePlaceholder: "Mixed" });
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Underline" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveDisplayValue("Mixed fonts");
    const size = screen.getByRole("spinbutton", { name: "Font size" });
    expect(size).toHaveValue(null); expect(size).toHaveAttribute("placeholder", "Mixed");
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
    fireEvent.change(size, { target: { value: "" } }); fireEvent.change(size, { target: { value: "0" } }); fireEvent.change(size, { target: { value: "12.25" } });
    expect(onSize).not.toHaveBeenCalled();
    fireEvent.change(size, { target: { value: "18.5" } }); expect(onSize).toHaveBeenCalledExactlyOnceWith(18.5);
  });
  it("retains Markie's existing compact row, styles and SVGs without a second toolbar or ribbon", () => {
    renderFormattingToolbar();
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    expect(toolbar).toHaveClass("markie-doc-toolbar", "gap-0.5", "px-2", "py-1", "min-w-0");
    expect(document.querySelectorAll("[data-markie-doc-toolbar]")).toHaveLength(1);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).getByRole("button", { name: "Undo" }).querySelector("path")).toHaveAttribute("d", "M9 14 4 9l5-5");
    expect(screen.getByRole("combobox", { name: "Paragraph style" })).toHaveValue("paragraph");
  });

  it.each<[string, FormattingAction]>([
    ["Undo", "undo"], ["Redo", "redo"], ["Bold", "bold"], ["Italic", "italic"],
    ["Underline", "underline"], ["Strikethrough", "strike"], ["Inline code", "code"],
    ["Insert link", "link"], ["Insert image", "image"], ["Bullet list", "bullet"],
    ["Numbered list", "ordered"], ["Task list", "task"], ["Align left", "align-left"],
    ["Align centre", "align-center"], ["Align right", "align-right"], ["Clear formatting", "clear"],
  ])("routes %s through its typed renderer action", async (label, action) => {
    const { onAction } = renderFormattingToolbar();
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("shows only renderer-supported actions and hides absent print, highlight and width capabilities", () => {
    renderFormattingToolbar({ supportedActions: ["bold", "italic", "link"], showWidthControls: false });
    for (const label of ["Bold", "Italic", "Insert link"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    for (const label of ["Undo", "Redo", "Underline", "Inline code", "Task list", "Print", "Narrower", "Wider", "Clear formatting"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("combobox", { name: "Highlight colour" })).not.toBeInTheDocument();
  });

  it("keeps literal text controls in the same row without unsupported style or colour widgets", async () => {
    const onFind = vi.fn();
    renderFormattingToolbar({
      supportedActions: ["undo", "redo"], showStyleControls: false, onColor: undefined,
      startControls: <><button type="button" onClick={onFind}>Find</button><span>UTF-8</span></>,
    });
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    expect(toolbar.firstElementChild).toContainElement(screen.getByRole("button", { name: "Find" }));
    expect(within(toolbar).getByText("UTF-8")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-markie-doc-toolbar]")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Paragraph style" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Text colour" })).not.toBeInTheDocument();
    expect(toolbar.querySelectorAll("span.w-px.h-5")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Font" })).toBeInTheDocument();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Find" }));
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("uses actual Word font/style values and forwards font sizes without Markdown's viewing clamp", () => {
    const { onFont, onSize, onStyle } = renderFormattingToolbar({
      selecting: true, currentFont: "Cambria", currentStyle: "Title", currentSize: 72,
      fonts: [{ id: "Cambria", label: "Cambria" }, { id: "Arial", label: "Arial" }],
      styles: [{ id: "Title", label: "Title" }, { id: "Subtitle", label: "Subtitle" }],
    });
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveValue("Cambria");
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveAttribute("title", "Font for the selected text");
    expect(screen.getByRole("combobox", { name: "Paragraph style" })).toHaveValue("Title");
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toHaveValue(72);
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "Arial" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Paragraph style" }), { target: { value: "Subtitle" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(onFont).toHaveBeenCalledExactlyOnceWith("Arial");
    expect(onStyle).toHaveBeenCalledExactlyOnceWith("Subtitle");
    expect(onSize.mock.calls).toEqual([[400], [73]]);
    expect(screen.getByRole("button", { name: "Underline" }).title).not.toContain("HTML");
  });

  it("leaves the Markdown serialization warning under its adapter's control", () => {
    renderFormattingToolbar({ selecting: true, serializationHint: "Saved as HTML in the file", onHighlight: vi.fn() });
    expect(screen.getByRole("button", { name: "Underline" }).title).toContain("Saved as HTML in the file");
    expect(screen.getByRole("combobox", { name: "Font" }).title).toBe("Font for the selected text - Saved as HTML in the file");
    expect(screen.getByRole("combobox", { name: "Highlight colour" }).closest("label")?.title).toContain("Saved as HTML in the file");
  });

  it("routes colour, highlight, print and history to the renderer callbacks", async () => {
    const onHighlight = vi.fn(), onPrint = vi.fn(), onHistory = vi.fn();
    const { onColor } = renderFormattingToolbar({ onHighlight, onPrint, onHistory });
    fireEvent.change(screen.getByRole("combobox", { name: "Text colour" }), { target: { value: "#dc2626" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Text colour" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Highlight colour" }), { target: { value: "#fef08a" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Highlight colour" }), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: "Print" }));
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(onColor.mock.calls).toEqual([["#dc2626"], [null]]);
    expect(onHighlight.mock.calls).toEqual([["#fef08a"], [null]]);
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps zoom and reading width as appearance callbacks", async () => {
    const { onAppearance } = renderFormattingToolbar();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Wider" }));
    expect(onAppearance.mock.calls).toEqual([
      [{ ...DEFAULT_APPEARANCE, zoom: 1.1 }], [{ ...DEFAULT_APPEARANCE, width: "900" }],
    ]);
  });

  it("disables editing for read-only renderer targets while allowing viewing changes", async () => {
    const { onAction, onFont, onSize, onStyle, onAppearance } = renderFormattingToolbar({ selecting: true, canEdit: false });
    for (const label of ["Bold", "Undo", "Increase font size", "Decrease font size"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: label }));
    }
    for (const label of ["Font", "Paragraph style", "Text colour"]) expect(screen.getByRole("combobox", { name: label })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toBeDisabled();
    expect(onAction).not.toHaveBeenCalled(); expect(onFont).not.toHaveBeenCalled();
    expect(onSize).not.toHaveBeenCalled(); expect(onStyle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(onAppearance).toHaveBeenCalledWith({ ...DEFAULT_APPEARANCE, zoom: 0.9 });
  });
});
