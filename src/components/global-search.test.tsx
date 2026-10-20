import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSearchResponse } from "@/lib/electron";
import { clearBridge, installBridge } from "@/test/mock-bridge";
import { GlobalSearch } from "./global-search";

const hits: DocumentSearchResponse = {
  results: [
    { path: "/Users/kirby/Docs/Plans/board.docx", name: "board.docx", dir: "/Users/kirby/Docs/Plans", format: "docx", mtimeMs: Date.now() - 60_000, nameHit: false, excerpt: "The Northwind budget was approved", marks: [[4, 13]] },
    { path: "/Users/kirby/Docs/northwind.md", name: "northwind.md", dir: "/Users/kirby/Docs", format: "markdown", mtimeMs: Date.now() - 120_000, nameHit: true },
  ],
  scanned: 40,
  total: 120,
  partial: false,
};

describe("GlobalSearch", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => clearBridge());

  it("searches every document type as you type and highlights the hit", async () => {
    const searchDocuments = vi.fn(async () => hits);
    installBridge({ searchDocuments });
    const user = userEvent.setup();
    render(<GlobalSearch onOpenPath={vi.fn()} onClose={vi.fn()} />);

    await user.keyboard("northwind");
    await waitFor(() => expect(searchDocuments).toHaveBeenLastCalledWith({ query: "northwind", formats: [], limit: 80 }));
    expect(await screen.findByText("board.docx")).toBeInTheDocument();
    expect(screen.getByText("Northwind", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText(/2 matches · read 40 of 120 documents/)).toBeInTheDocument();
  });

  it("narrows to the chosen types, maps Word to DOCX and DOC, and remembers them", async () => {
    const searchDocuments = vi.fn(async () => hits);
    installBridge({ searchDocuments });
    const user = userEvent.setup();
    render(<GlobalSearch onOpenPath={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Word" }));
    await user.click(screen.getByRole("button", { name: "Rich Text" }));
    await waitFor(() => expect(searchDocuments).toHaveBeenLastCalledWith({ query: "", formats: ["docx", "doc", "rtf"], limit: 80 }));
    expect(screen.getByRole("button", { name: "Word" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("markie.search.types.v1")!)).toEqual(["word", "rtf"]);

    await user.click(screen.getByRole("button", { name: "All types" }));
    await waitFor(() => expect(searchDocuments).toHaveBeenLastCalledWith({ query: "", formats: [], limit: 80 }));
  });

  it("opens the selected result with the keyboard and closes", async () => {
    installBridge({ searchDocuments: vi.fn(async () => hits) });
    const onOpenPath = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<GlobalSearch onOpenPath={onOpenPath} onClose={onClose} />);

    await screen.findByText("board.docx");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledWith("/Users/kirby/Docs/northwind.md"));
  });

  it("ignores an answer to a search the user already moved past", async () => {
    let resolveFirst!: (value: DocumentSearchResponse) => void;
    const searchDocuments = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ...hits, results: [] }))
      .mockImplementationOnce(() => new Promise<DocumentSearchResponse>((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => ({ ...hits, results: [hits.results[1]] }));
    installBridge({ searchDocuments });
    const user = userEvent.setup();
    render(<GlobalSearch onOpenPath={vi.fn()} onClose={vi.fn()} />);

    await user.keyboard("n");
    await waitFor(() => expect(searchDocuments).toHaveBeenCalledTimes(2));
    await user.keyboard("o");
    await screen.findByTitle("/Users/kirby/Docs/northwind.md");
    resolveFirst(hits);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTitle("/Users/kirby/Docs/Plans/board.docx")).not.toBeInTheDocument();
  });

  it("explains that cross-file search needs the desktop app", () => {
    installBridge({ searchDocuments: undefined });
    render(<GlobalSearch onOpenPath={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Searching across files needs the Markie desktop app.")).toBeInTheDocument();
  });
});
