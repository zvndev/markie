import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "@/lib/doc-appearance";
import type { FormattingAction, FormattingToolbarProps } from "@/lib/format-controls";
import { FormattingToolbar } from "./formatting-toolbar";

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
  it("retains Markie's existing compact row, styles and SVGs without a second toolbar or ribbon", () => {
    renderFormattingToolbar();
    const toolbar = screen.getByRole("toolbar", { name: "Document formatting" });
    expect(toolbar).toHaveClass("markie-doc-toolbar", "gap-0.5", "px-2", "py-1", "overflow-x-auto");
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
    expect(toolbar.firstElementChild).toBe(screen.getByRole("button", { name: "Find" }));
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
