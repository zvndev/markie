import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewDocumentModal, NEW_DOCUMENT_TYPES } from "./new-document-modal";
import { createDocumentSession } from "@/lib/document-session";

describe("NewDocumentModal", () => {
  it("offers every creatable type in one centered dialog and reports the choice", async () => {
    const onCreate = vi.fn(), onClose = vi.fn();
    render(<NewDocumentModal onCreate={onCreate} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "New document" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    for (const label of ["New Markdown document", "New Word document", "New Rich Text document", "New OpenDocument document", "New text document", "New Darkmown document", "New CSV document", "New JSON document", "New YAML document", "New XML document"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "New Rich Text document" }));
    expect(onCreate).toHaveBeenCalledWith("rtf");
  });

  it("closes on Escape and on Cancel without creating", async () => {
    const onCreate = vi.fn(), onClose = vi.fn();
    render(<NewDocumentModal onCreate={onCreate} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel new document" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("only lists formats the document session can actually create", async () => {
    for (const type of NEW_DOCUMENT_TYPES) {
      const session = await createDocumentSession(type.format);
      expect(session.format).toBe(type.format);
      expect(session.name.endsWith(type.extension)).toBe(true);
    }
  });
});
