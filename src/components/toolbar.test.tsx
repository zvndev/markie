import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { Toolbar } from "./toolbar";
import { exportFormatsFor } from "@/lib/export-formats";

function renderToolbar(props: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  const handlers = {
    onOpenFile: vi.fn(), onExportPDF: vi.fn(), onSaveAs: vi.fn(),
    onExportHTML: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onThemePresets: vi.fn(),
  };
  const view = render(<Toolbar fileName="notes.md" isDirty={false} canRename {...handlers} {...props} />);
  return { ...handlers, view };
}

beforeEach(() => { installBridge(); });

describe("the existing Markie top bar", () => {
  it("keeps a cold document Open action disabled until its format tools are ready", async () => {
    const onOpenFile = vi.fn(), test = renderToolbar({ openFileDisabled: true, onOpenFile });
    const button = screen.getByRole("button", { name: "Open" });
    expect(button).toBeDisabled(); expect(button).toHaveAttribute("title", "Preparing document tools…");
    await userEvent.click(button); expect(onOpenFile).not.toHaveBeenCalled();
    test.view.rerender(<Toolbar fileName="notes.md" isDirty={false} canRename onOpenFile={onOpenFile} onExportPDF={vi.fn()} onSaveAs={vi.fn()} onExportHTML={vi.fn()} onRename={vi.fn()} onShare={vi.fn()} onThemePresets={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" })); expect(onOpenFile).toHaveBeenCalledOnce();
  });
  it("keeps Markdown modes out of the top bar while preserving rendered export actions", async () => {
    const { onExportHTML } = renderToolbar();
    expect(screen.queryByRole("group", { name: "Editing mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Rich|Source|Split) mode/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save file" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.getByRole("button", { name: "Save a Copy…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF (Dark)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF (Light)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "HTML (.html)" }));
    expect(onExportHTML).toHaveBeenCalledTimes(1);
  });

  it("reuses the top bar while exposing only the active document's save and copy capabilities", async () => {
    const onSave = vi.fn();
    const { onSaveAs, onOpenFile, onShare, onExportHTML, onExportPDF } = renderToolbar({
      documentMode: true, onSave, fileName: "proposal.docx", isDirty: true,
    });
    expect(document.querySelectorAll(".markie-toolbar")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Markie" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /proposal\.docx/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Editing mode" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Theme presets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark theme" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onShare).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.queryByRole("button", { name: "HTML (.html)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Export as" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^PDF/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save a Copy…" }));
    expect(onSaveAs).toHaveBeenCalledTimes(1);
    expect(onExportHTML).not.toHaveBeenCalled();
    expect(onExportPDF).not.toHaveBeenCalled();
  });

  it("uses one format-aware Word PDF action in the existing Export menu", async () => {
    const onDocumentExportPDF = vi.fn();
    const { onExportPDF, view } = renderToolbar({ documentMode: true, onDocumentExportPDF });
    expect(screen.queryByRole("note", { name: "Document PDF information" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.getByRole("note", { name: "Document PDF information" })).toHaveTextContent("Review comments are not included");
    expect(screen.queryByRole("button", { name: /PDF \((Dark|Light)\)/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export PDF…" }));
    expect(onDocumentExportPDF).toHaveBeenCalledOnce(); expect(onExportPDF).not.toHaveBeenCalled();
    view.rerender(<Toolbar documentMode exporting onDocumentExportPDF={onDocumentExportPDF} onOpenFile={vi.fn()} onExportPDF={onExportPDF} onSaveAs={vi.fn()} onExportHTML={vi.fn()} onRename={vi.fn()} onShare={vi.fn()} onThemePresets={vi.fn()} fileName="proposal.docx" isDirty canRename={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.getByRole("button", { name: "Export PDF…" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Export PDF…" }));
    expect(onDocumentExportPDF).toHaveBeenCalledOnce();
  });

  it("groups every export under Export as, in order, with the RTF and ODT limit stated", async () => {
    const onExportFormat = vi.fn();
    renderToolbar({ exportFormats: exportFormatsFor("markdown"), onExportFormat });
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    const group = screen.getByRole("group", { name: "Export as" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "PDF (Dark)", "PDF (Light)", "HTML (.html)", "Word (.docx)", "RTF (.rtf)", "OpenDocument (.odt)", "Plain text (.txt)",
    ]);
    expect(within(group).getByRole("note")).toHaveTextContent("Tables there become tab-separated rows");
    await userEvent.click(within(group).getByRole("button", { name: "Word (.docx)" }));
    expect(onExportFormat).toHaveBeenCalledExactlyOnceWith("docx");
    expect(screen.queryByRole("group", { name: "Export as" })).not.toBeInTheDocument();
  });

  it("offers Markdown instead of plain text for a text file, and greys exports out while one runs", async () => {
    renderToolbar({ exportFormats: exportFormatsFor("text"), onExportFormat: vi.fn(), exporting: true });
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.getByRole("button", { name: "Markdown (.md)" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Plain text (.txt)" })).not.toBeInTheDocument();
  });

  it("puts Copy all in the top bar beside Export and copies the freshest text", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderToolbar({ copyText: "old", readCopyText: () => "# Latest" });
    const copy = screen.getByRole("button", { name: "Copy all" });
    expect(copy).toHaveAttribute("title", "Copy all");
    expect(copy.closest('[data-window-control-region="file"]')).not.toBeNull();
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("# Latest");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("disables Copy all for an empty document and hides it for a Word session", () => {
    const { view } = renderToolbar({ copyText: "" });
    expect(screen.getByRole("button", { name: "Copy all" })).toBeDisabled();
    view.rerender(<Toolbar documentMode fileName="proposal.docx" isDirty={false} canRename={false} onOpenFile={vi.fn()} onExportPDF={vi.fn()} onSaveAs={vi.fn()} onExportHTML={vi.fn()} onRename={vi.fn()} onShare={vi.fn()} onThemePresets={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Copy all" })).not.toBeInTheDocument();
  });

  it("keeps narrow-screen file, share and appearance actions reachable in the existing overflow", async () => {
    const onSave = vi.fn();
    const { onShare, onThemePresets } = renderToolbar({ documentMode: true, onSave, live: true, liveStatus: "connected", themeLocked: true, peers: [{ name: "Ada", color: "#123456" }] });
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    const menu = document.querySelector(".markie-menu-panel")!;
    expect(menu).toHaveClass("right-0", "sm:left-0");
    expect(menu).toHaveTextContent("Owner theme pinned");
    expect(menu).toHaveTextContent("Live: connected");
    expect(menu.querySelector('[aria-label="Live collaborators"]')).toHaveTextContent("Ada");
    const findMenuButton = (name: string) => Array.from(document.querySelector(".markie-menu-panel")!.querySelectorAll("button")).find((button) => button.textContent === name)!;
    await userEvent.click(findMenuButton("Save file"));
    expect(onSave).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    await userEvent.click(findMenuButton("Share"));
    expect(onShare).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    await userEvent.click(findMenuButton("Theme presets"));
    expect(onThemePresets).toHaveBeenCalledOnce();
  });
});
