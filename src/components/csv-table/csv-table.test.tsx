import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CSV_FIXTURES } from "@/lib/csv-fixtures";
import { CsvTable } from "./csv-table";

const FRUIT = "name,qty,note\r\nPear,12,\"green, ripe\"\r\nApple,3,red\r\nPlum,100,\"dark\"\r\n";

function Host({ initial, onText, readOnly }: { initial: string; onText?: (text: string) => void; readOnly?: boolean }) {
  const [text, setText] = useState(initial);
  return <CsvTable text={text} name="fruit.csv" readOnly={readOnly} onChange={(next) => { setText(next); onText?.(next); }} />;
}

const grid = () => screen.getByRole("grid");
const cell = (text: string) => within(grid()).getByText(text, { selector: "[role=gridcell]" });
const bodyRows = () => within(grid()).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("gridcell").map((c) => c.textContent));
const key = (name: string, init: Parameters<typeof fireEvent.keyDown>[1] = {}) => fireEvent.keyDown(grid(), { key: name, ...init });

describe("CsvTable", () => {
  it("opens as a table with the first row as its header, row numbers and right-aligned numbers", () => {
    render(<Host initial={FRUIT} />);
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["name", "qty", "note"]);
    expect(bodyRows()).toEqual([["Pear", "12", "green, ripe"], ["Apple", "3", "red"], ["Plum", "100", "dark"]]);
    // The number is the line in the file, so the first data row is line 2.
    expect(within(grid()).getAllByRole("rowheader").map((n) => n.textContent)).toEqual(["2", "3", "4"]);
    expect(cell("12")).toHaveClass("is-number");
    expect(cell("Pear")).not.toHaveClass("is-number");
    expect(screen.getByRole("status")).toHaveTextContent("3 rows × 3 columns");
    expect(screen.getByRole("checkbox", { name: /header row/i })).toBeChecked();
  });

  it("leaves the header off when the first row is clearly data, and lets it be turned on", () => {
    render(<CsvTable text={"1,Apple,3\n2,Pear,12\n"} />);
    expect(screen.getByRole("checkbox", { name: /header row/i })).not.toBeChecked();
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["A", "B", "C"]);
    expect(bodyRows().length).toBe(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /header row/i }));
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["1", "Apple", "3"]);
    expect(bodyRows()).toEqual([["2", "Pear", "12"]]);
  });

  it("switches to the file's own text and back", () => {
    render(<Host initial={FRUIT} />);
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.querySelector(".csv-table-text")?.textContent).toBe(FRUIT);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(grid()).toBeInTheDocument();
  });

  it("sorts on a header click and filters, without ever changing the file", () => {
    const onText = vi.fn();
    render(<Host initial={FRUIT} onText={onText} />);
    const qty = within(grid()).getByRole("columnheader", { name: /qty/ });
    fireEvent.click(within(qty).getByRole("button"));
    expect(qty).toHaveAttribute("aria-sort", "ascending");
    expect(bodyRows().map((row) => row[0])).toEqual(["Apple", "Pear", "Plum"]);
    fireEvent.click(within(qty).getByRole("button"));
    expect(bodyRows().map((row) => row[0])).toEqual(["Plum", "Pear", "Apple"]);
    fireEvent.click(within(qty).getByRole("button"));
    expect(qty).toHaveAttribute("aria-sort", "none");
    expect(bodyRows().map((row) => row[0])).toEqual(["Pear", "Apple", "Plum"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter rows" }), { target: { value: "RE" } });
    expect(bodyRows().map((row) => row[0])).toEqual(["Pear", "Apple"]);
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3 rows");
    expect(onText).not.toHaveBeenCalled();
  });

  it("moves a cell cursor with the arrow keys and Tab, and shows the whole cell below", () => {
    render(<Host initial={FRUIT} />);
    fireEvent.mouseDown(cell("Pear"));
    expect(cell("Pear")).toHaveClass("is-cursor");
    key("ArrowDown");
    expect(cell("Apple")).toHaveClass("is-cursor");
    key("ArrowRight");
    expect(cell("3")).toHaveClass("is-cursor");
    key("Tab");
    expect(cell("red")).toHaveClass("is-cursor");
    key("ArrowUp");
    expect(cell("green, ripe")).toHaveClass("is-cursor");
    expect(document.querySelector(".csv-table-ref")?.textContent).toBe("C2");
    expect(document.querySelector(".csv-table-value")?.textContent).toBe("green, ripe");
    // Up from the first row is the header row, which is a row of the file.
    key("ArrowUp");
    expect(within(grid()).getByRole("columnheader", { name: /note/ })).toHaveClass("is-cursor");
  });

  it("edits a cell on Enter, cancels on Escape, and rewrites only that cell", () => {
    const onText = vi.fn();
    render(<Host initial={FRUIT} onText={onText} />);
    fireEvent.mouseDown(cell("Apple"));
    key("Enter");
    const editor = screen.getByRole("textbox", { name: "Edit cell" });
    fireEvent.change(editor, { target: { value: "Nope" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onText).not.toHaveBeenCalled();
    expect(cell("Apple")).toBeInTheDocument();

    key("Enter");
    fireEvent.change(screen.getByRole("textbox", { name: "Edit cell" }), { target: { value: "Quince, yellow" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit cell" }), { key: "Enter" });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenLastCalledWith("name,qty,note\r\nPear,12,\"green, ripe\"\r\n\"Quince, yellow\",3,red\r\nPlum,100,\"dark\"\r\n");
    // Enter moved down a row, as in a spreadsheet.
    expect(cell("Plum")).toHaveClass("is-cursor");
  });

  it("starts an edit by typing, and Tab saves it and moves right", () => {
    const onText = vi.fn();
    render(<Host initial={FRUIT} onText={onText} />);
    fireEvent.mouseDown(cell("3"));
    key("7");
    const editor = screen.getByRole("textbox", { name: "Edit cell" });
    expect(editor).toHaveValue("7");
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(onText).toHaveBeenLastCalledWith(FRUIT.replace("Apple,3,", "Apple,7,"));
    expect(cell("red")).toHaveClass("is-cursor");
  });

  it("undoes and redoes its own edits", () => {
    const onText = vi.fn();
    render(<Host initial={FRUIT} onText={onText} />);
    fireEvent.mouseDown(cell("red"));
    key("Delete");
    expect(onText).toHaveBeenLastCalledWith(FRUIT.replace("Apple,3,red", "Apple,3,"));
    key("z", { metaKey: true });
    expect(onText).toHaveBeenLastCalledWith(FRUIT);
    key("z", { metaKey: true, shiftKey: true });
    expect(onText).toHaveBeenLastCalledWith(FRUIT.replace("Apple,3,red", "Apple,3,"));
  });

  it("adds and deletes rows and columns", () => {
    const onText = vi.fn();
    render(<Host initial={"a,b\n1,2\n3,4\n"} onText={onText} />);
    fireEvent.mouseDown(cell("1"));
    fireEvent.click(screen.getByRole("button", { name: "+ Row" }));
    expect(onText).toHaveBeenLastCalledWith("a,b\n1,2\n,\n3,4\n");
    fireEvent.click(screen.getByRole("button", { name: "+ Column" }));
    expect(onText).toHaveBeenLastCalledWith("a,,b\n1,,2\n,,\n3,,4\n");
    fireEvent.click(screen.getByRole("button", { name: "Delete column" }));
    expect(onText).toHaveBeenLastCalledWith("a,,b\n1,,2\n,,\n3,,4\n".replace(/^([^,\n]*),/gm, ""));
    fireEvent.mouseDown(cell("4"));
    fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
    expect(onText).toHaveBeenLastCalledWith(",b\n,2\n,\n");
  });

  it("copies one cell as its text and a range as tab-separated rows", () => {
    render(<Host initial={FRUIT} />);
    const copied = () => {
      const data = { setData: vi.fn() };
      fireEvent.copy(grid(), { clipboardData: data });
      return data.setData.mock.calls[0];
    };
    fireEvent.mouseDown(cell("green, ripe"));
    expect(copied()).toEqual(["text/plain", "green, ripe"]);
    fireEvent.mouseDown(cell("Pear"));
    key("ArrowRight", { shiftKey: true });
    key("ArrowDown", { shiftKey: true });
    expect(copied()).toEqual(["text/plain", "Pear\t12\nApple\t3"]);
    expect(document.querySelector(".csv-table-value")?.textContent).toBe("4 cells selected");
    expect(document.querySelector(".csv-table-detail")?.textContent).toBe("Sum 15");
  });

  it("pastes a block from the cursor", () => {
    const onText = vi.fn();
    render(<Host initial={"a,b\n1,2\n3,4\n"} onText={onText} />);
    fireEvent.mouseDown(cell("1"));
    fireEvent.paste(grid(), { clipboardData: { getData: () => "x\ty\nz\tw, v" } });
    expect(onText).toHaveBeenLastCalledWith("a,b\nx,y\nz,\"w, v\"\n");
  });

  it("is read-only when told to be: no editor, no row or column buttons, copy still works", () => {
    const onText = vi.fn();
    render(<Host initial={FRUIT} onText={onText} readOnly />);
    expect(grid()).toHaveAttribute("aria-readonly", "true");
    expect(screen.queryByRole("button", { name: "+ Row" })).toBeNull();
    fireEvent.mouseDown(cell("Apple"));
    key("Enter");
    key("x");
    key("Delete");
    fireEvent.doubleClick(cell("Apple"));
    expect(screen.queryByRole("textbox", { name: "Edit cell" })).toBeNull();
    expect(onText).not.toHaveBeenCalled();
  });

  it("draws only the rows on screen for a large file", () => {
    const lines = ["id,name"];
    for (let i = 1; i <= 100_000; i++) lines.push(`${i},Name ${i}`);
    render(<CsvTable text={lines.join("\n") + "\n"} />);
    expect(screen.getByRole("status")).toHaveTextContent("100,000 rows × 2 columns");
    expect(grid()).toHaveAttribute("aria-rowcount", "100001");
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(80);
  });

  it("reads a semicolon file with decimal commas, and a tab file by its name", () => {
    const european = CSV_FIXTURES.find((f) => f.file === "european.csv")!;
    const { unmount } = render(<CsvTable text={european.text} name={european.file} />);
    expect(document.querySelector("[data-csv-table]")).toHaveAttribute("data-csv-delimiter", "Semicolon");
    expect(cell("12,50")).toHaveClass("is-number");
    expect(cell("Käse; alt")).toBeInTheDocument();
    unmount();
    const tsv = CSV_FIXTURES.find((f) => f.file === "data.tsv")!;
    render(<CsvTable text={tsv.text} name={tsv.file} />);
    expect(document.querySelector("[data-csv-table]")).toHaveAttribute("data-csv-delimiter", "Tab");
    expect(cell("has, comma")).toBeInTheDocument();
  });

  it("takes a new text from its host", () => {
    const { rerender } = render(<CsvTable text={"a,b\n1,2\n"} onChange={() => {}} />);
    rerender(<CsvTable text={"a,b\n9,8\n7,6\n"} onChange={() => {}} />);
    expect(bodyRows()).toEqual([["9", "8"], ["7", "6"]]);
  });
});
