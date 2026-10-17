import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { LibraryDocumentFilters } from "./library-document-filters";

function ControlledFilters() {
  const [query, setQuery] = useState<LibraryDocumentQuery>({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY });
  return <><LibraryDocumentFilters query={query} onChange={setQuery} /><output>{JSON.stringify(query)}</output><button type="button">Outside</button></>;
}

describe("compact Library filters", () => {
  it("offers a separate Darkmown filter without treating it as Markdown", async () => {
    const user = userEvent.setup();
    render(<ControlledFilters />);
    await user.click(screen.getByRole("button", { name: "Document type: All types" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Darkmown" }));
    expect(screen.getByRole("button", { name: "Document type: Darkmown" })).toHaveFocus();
    expect(screen.getByText(/"format":"darkmown"/)).toBeInTheDocument();
  });
  it("offers keyboard-complete type selection, visible selected state and focus restoration", async () => {
    const user = userEvent.setup();
    render(<ControlledFilters />);
    const trigger = screen.getByRole("button", { name: "Document type: All types" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu", { name: "Document type" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "All types" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByRole("button", { name: "Document type: DOCX" })).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Document type: DOCX" }));
    expect(screen.getByRole("menuitemradio", { name: "DOCX" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Document type: DOCX" })).toHaveFocus();
  });

  it("supports wrapped arrows, Home/End, Escape, Tab and outside dismissal", async () => {
    const user = userEvent.setup();
    render(<ControlledFilters />);
    await user.click(screen.getByRole("button", { name: "Sort documents: Default order" }));
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "Type" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitemradio", { name: "Default order" })).toHaveFocus();
    await user.keyboard("{End}{Enter}");
    expect(screen.getByRole("button", { name: "Sort documents: Type" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Sort documents: Type" }));
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Sort documents: Type" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("clears only search with Escape and resets every criterion with Clear filters", async () => {
    const user = userEvent.setup();
    render(<ControlledFilters />);
    await user.click(screen.getByRole("button", { name: "Document type: All types" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Text" }));
    const search = screen.getByRole("textbox", { name: "Filter documents" });
    await user.type(search, "something{Escape}");
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "Document type: Text" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "Document type: All types" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });
});
