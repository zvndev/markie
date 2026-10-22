import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ pick: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/web-files", () => ({
  pickWebDocument: files.pick,
  downloadWebDocument: files.download,
}));

import { DocumentWorkbench } from "./document-workbench";

beforeEach(() => {
  localStorage.clear();
  files.pick.mockReset();
  files.download.mockReset();
  files.download.mockReturnValue({ method: "download", name: "copy.txt" });
});
afterEach(() => vi.restoreAllMocks());

describe("isolated document engine workbench", () => {
  it("keeps an edited copy when replacement is canceled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<DocumentWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "New test DOCX" }));
    const run = await screen.findByRole("textbox", { name: "Paragraph 1, run 1" });
    fireEvent.change(run, { target: { value: "Keep my edits" } });
    fireEvent.click(screen.getByRole("button", { name: "New test DOCX" }));
    expect(confirm).toHaveBeenCalled();
    expect(run).toHaveValue("Keep my edits");
    fireEvent.click(screen.getByRole("button", { name: "Open document copy" }));
    expect(files.pick).not.toHaveBeenCalled();
    expect(run).toHaveValue("Keep my edits");
  });
  it("creates an original DOCX, edits a supported run, and downloads a copy", async () => {
    render(<DocumentWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "New test DOCX" }));
    const run = await screen.findByRole("textbox", { name: "Paragraph 1, run 1" });
    fireEvent.change(run, { target: { value: "Original engine edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Download a copy" }));
    await waitFor(() => expect(files.download).toHaveBeenCalled());
    const payload = files.download.mock.calls[0][0];
    expect(payload.name).toMatch(/\.docx$/);
    const { openDocx } = await import("@/lib/office/docx");
    expect((await openDocx(payload.bytes)).text).toContain("Original engine edit");
    expect(screen.getByRole("status")).toHaveTextContent("Download started");
    expect(screen.getByRole("status")).toHaveTextContent("not overwritten");
  });

  it("opens plain text literally and preserves its encoding on download", async () => {
    const { classifyDocumentFormat } = await import("@/lib/document-formats");
    files.pick.mockResolvedValue({ name: "notes.txt", bytes: new Uint8Array(),
      format: classifyDocumentFormat("notes.txt"),
      text: { text: "# literal\r\n**stars**\r\n", encoding: "utf-16le", bom: true, newline: "crlf" } });
    render(<DocumentWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "Open document copy" }));
    const text = await screen.findByRole("textbox", { name: "Document text" });
    expect(text).toHaveValue("# literal\n**stars**\n");
    fireEvent.click(screen.getByRole("button", { name: "Download a copy" }));
    await waitFor(() => expect(files.download).toHaveBeenCalled());
    const { decodeTextDocument } = await import("@/lib/document-formats");
    expect(decodeTextDocument(files.download.mock.calls[0][0].bytes)).toMatchObject({
      encoding: "utf-16le", bom: true, text: "# literal\r\n**stars**\r\n",
    });
  });

  it("cancellation keeps the current document and unsupported formats fail visibly", async () => {
    const { classifyDocumentFormat } = await import("@/lib/document-formats");
    render(<DocumentWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "New test DOCX" }));
    await screen.findByRole("textbox", { name: "Paragraph 1, run 1" });
    files.pick.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Open document copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open document copy" })).not.toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Paragraph 1, run 1" })).toBeInTheDocument();
    files.pick.mockResolvedValueOnce({ name: "unsafe.html", bytes: new Uint8Array(), format: classifyDocumentFormat("unsafe.html"), text: null });
    fireEvent.click(screen.getByRole("button", { name: "Open document copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not supported");
    expect(screen.getByRole("textbox", { name: "Paragraph 1, run 1" })).toBeInTheDocument();
  });
});
