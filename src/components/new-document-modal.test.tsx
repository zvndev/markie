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

  it("groups writing and data formats with a miniature sheet for every choice", async () => {
    const { container } = render(<NewDocumentModal onCreate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Writing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Data and source" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-document-format-mark]")).toHaveLength(NEW_DOCUMENT_TYPES.length);
    for (const type of NEW_DOCUMENT_TYPES) {
      expect(container.querySelector(`[data-document-format-mark="${type.format}"]`)).not.toBeNull();
    }
    const markdown = screen.getByRole("button", { name: "New Markdown document" });
    expect(markdown).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "New Word document" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("button", { name: "New XML document" })).toHaveFocus();
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
