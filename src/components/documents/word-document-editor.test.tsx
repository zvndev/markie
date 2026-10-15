import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordDocumentEditor } from "./word-document-editor";
import { createDocx } from "@/lib/office/docx";
afterEach(cleanup);
describe("multiple Word editor isolation", () => {
  it("keeps cloud/local find focus and accessible tab IDs in their own document", async () => {
    const local = await createDocx("LOCAL secret"), cloud = await createDocx("CLOUD target");
    const view = render(<><WordDocumentEditor document={local} onChange={vi.fn()} /><WordDocumentEditor document={cloud} onChange={vi.fn()} /></>);
    const queries = screen.getAllByRole("textbox", { name: "Find Word text" });
    fireEvent.change(queries[1], { target: { value: "target" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Find next" })[1]);
    expect(window.getSelection()?.toString()).toBe("target");
    const editors = view.container.querySelectorAll(".docs-word-host");
    expect(editors[1].contains(document.activeElement)).toBe(true);
    expect(editors[0].contains(document.activeElement)).toBe(false);
    const tabs = screen.getAllByRole("tab", { name: "Home" });
    expect(tabs[0].id).not.toBe(tabs[1].id);
    expect(document.getElementById(tabs[1].getAttribute("aria-controls")!)).toHaveAttribute("aria-labelledby", tabs[1].id);
  });
});
