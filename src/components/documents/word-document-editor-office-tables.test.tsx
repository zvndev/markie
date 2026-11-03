import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordDocumentEditor } from "./word-document-editor";
import { openRichDocument } from "@/lib/office/rich-document";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// jsdom gives import.meta.url an http origin, so resolve from the repository root vitest runs in.
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "src/lib/office/fixtures", name)));
// jsdom's Blob cannot stream, and ODT parts are deflated; browsers and Node both can.
async function open(format: "rtf" | "odt", name: string) {
  vi.stubGlobal("Blob", NodeBlob);
  const document = await openRichDocument(format, fixture(name));
  vi.unstubAllGlobals();
  return document;
}

// The desktop, the web read view and the phone all draw rich documents with this editor.
describe("TextEdit and LibreOffice documents on the shared page", () => {
  it.each([["rtf", "textedit-report.rtf"], ["odt", "textedit-report.odt"], ["odt", "libreoffice-report.odt"]] as const)("draws the %s table from %s as rows and cells, read-only", async (format, name) => {
    render(<WordDocumentEditor document={await open(format, name)} onChange={() => {}} />);
    const table = screen.getByRole("table", { name: "Document table" });
    const rows = within(table).getAllByRole("row").map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([["Name", "Qty"], ["Apples", "3"], ["Pears", "5"]]);
    expect(screen.getByRole("status").textContent).toContain("Read-only");
    expect(screen.getByText("After the table.")).toBeTruthy();
  });

  it("marks ODT list items with their bullet or number", async () => {
    const { container } = render(<WordDocumentEditor document={await open("odt", "textedit-report.odt")} onChange={() => {}} />);
    const marked = [...container.querySelectorAll("[data-list-kind]")].map((node) => [node.textContent, node.getAttribute("data-list-kind"), node.getAttribute("data-list-number")]);
    expect(marked).toEqual([["Step one", "numbered", "1"], ["Step two", "numbered", "2"], ["First item", "bullet", null], ["Second item", "bullet", null]]);
  });
});
