import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { Toolbar } from "./toolbar";

function renderToolbar(props: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  const handlers = {
    onModeChange: vi.fn(), onOpenFile: vi.fn(), onExportPDF: vi.fn(), onSaveAs: vi.fn(),
    onExportHTML: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onThemePresets: vi.fn(),
  };
  const view = render(<Toolbar mode="preview" fileName="notes.md" isDirty={false} canRename {...handlers} {...props} />);
  return { ...handlers, view };
}

beforeEach(() => { installBridge(); });

describe("the existing Markie top bar", () => {
  it("preserves Markdown modes and rendered export actions by default", async () => {
    const { onModeChange, onExportHTML } = renderToolbar();
    const modes = screen.getByRole("group", { name: "Editing mode" });
    expect(within(modes).getAllByRole("button")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Source mode (⌘2)" }));
    expect(onModeChange).toHaveBeenCalledWith("edit");
    expect(screen.queryByRole("button", { name: "Save file" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    expect(screen.getByRole("button", { name: "Save a Copy…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF (Dark)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF (Light)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export HTML" }));
    expect(onExportHTML).toHaveBeenCalledTimes(1);
  });

  it("reuses the top bar while exposing only the active document's save and copy capabilities", async () => {
    const onSave = vi.fn();
    const { onSaveAs, onOpenFile, onShare, onExportHTML, onExportPDF } = renderToolbar({
      documentMode: true, onSave, fileName: "proposal.docx", isDirty: true,
    });
    expect(document.querySelectorAll(".markie-toolbar")).toHaveLength(1);
    expect(screen.getByText("Markie")).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Export HTML" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^PDF/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save a Copy…" }));
    expect(onSaveAs).toHaveBeenCalledTimes(1);
    expect(onExportHTML).not.toHaveBeenCalled();
    expect(onExportPDF).not.toHaveBeenCalled();
  });
});
