import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDocumentSession, restoreDocumentText } from "@/lib/document-session";
import { encodeTextDocument } from "@/lib/document-formats";
import { TextDocumentEditor } from "./text-document-editor";

// A CSV in the documents workspace opens as its table. An edited cell is
// stored as the exact text the table hands back, so the bytes written are the
// file's own everywhere but that cell.
const FILE = "﻿name;qty\r\n\"Käse; alt\";3\r\nBrot;12";

async function csvSession() {
  const blank = await createDocumentSession("csv", "stock.csv");
  return { ...blank, text: FILE.slice(1), textMetadata: { text: FILE.slice(1), encoding: "utf-8" as const, bom: true, newline: "crlf" as const } };
}

describe("a CSV in the documents workspace", () => {
  it("opens as the table, with the text one switch away", async () => {
    render(<TextDocumentEditor session={await csvSession()} onChange={vi.fn()} onFlushReady={vi.fn()} />);
    const grid = screen.getByRole("grid");
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["name", "qty"]);
    expect(document.querySelector("[data-markie-toolbar-start]")).toHaveTextContent("CSV · Table");
    expect(screen.queryByLabelText("Document text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(screen.getByLabelText("Document text")).toHaveValue("name;qty\n\"Käse; alt\";3\nBrot;12");
    expect(document.querySelector("[data-markie-toolbar-start]")).toHaveTextContent("CSV · Text");
  });

  it("stores an edited cell exactly, and saves the file's own bytes around it", async () => {
    const session = await csvSession();
    const onChange = vi.fn(), onRestoreText = vi.fn();
    render(<TextDocumentEditor session={session} onChange={onChange} onRestoreText={onRestoreText} onFlushReady={vi.fn()} />);
    const grid = screen.getByRole("grid");
    fireEvent.mouseDown(within(grid).getByText("12"));
    fireEvent.keyDown(grid, { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "Edit cell" });
    fireEvent.change(field, { target: { value: "15" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // Exact text, so the path that re-derives line endings is not used.
    expect(onChange).not.toHaveBeenCalled();
    expect(onRestoreText).toHaveBeenCalledWith("name;qty\r\n\"Käse; alt\";3\r\nBrot;15");
    const saved = restoreDocumentText(session, onRestoreText.mock.calls[0][0]);
    expect(Array.from(encodeTextDocument(saved.text, saved.textMetadata!))).toEqual(Array.from(new TextEncoder().encode(FILE.replace("Brot;12", "Brot;15"))));
  });

  it("brings the text forward for Find, which works on text", async () => {
    render(<TextDocumentEditor session={await csvSession()} onChange={vi.fn()} onFlushReady={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByLabelText("Document text")).toBeInTheDocument();
  });

  it("does not edit a read-only document", async () => {
    const onRestoreText = vi.fn();
    render(<TextDocumentEditor session={await csvSession()} readOnly onChange={vi.fn()} onRestoreText={onRestoreText} onFlushReady={vi.fn()} />);
    const grid = screen.getByRole("grid");
    fireEvent.mouseDown(within(grid).getByText("12"));
    fireEvent.keyDown(grid, { key: "Enter" });
    fireEvent.keyDown(grid, { key: "Delete" });
    expect(screen.queryByRole("textbox", { name: "Edit cell" })).toBeNull();
    expect(onRestoreText).not.toHaveBeenCalled();
  });
});
