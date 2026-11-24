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
const nameBox = () => screen.getByRole("textbox", { name: "Cell" });
const formulaBar = () => screen.getByRole("textbox", { name: "Cell contents" });
const letters = () => Array.from(document.querySelectorAll(".csv-table-letter:not(.is-fill)"));
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
    expect(nameBox()).toHaveValue("C2");
    expect(formulaBar()).toHaveValue("green, ripe");
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
    // The active cell stays where the selection began; the status bar adds the block up.
    expect(nameBox()).toHaveValue("A2");
    expect(cell("Pear")).toHaveClass("is-cursor");
    expect(cell("3")).toHaveClass("is-selected");
    expect(document.querySelector(".csv-table-stats")?.textContent).toBe("Sum 15Average 7.5Count 2");
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

  describe("as a spreadsheet", () => {
    const SHEET = "item,qty,price,change,paid,due,link\nPear,12,$1.20,-4%,true,2026-11-24,https://example.com/pear\nApple,-3,($0.85),12.5%,False,11/30/2026,\nPlum,100,€2,0%,,soon,not a link\n";

    it("opens with the column letters, the row numbers, the first cell selected and the file as the one sheet tab", () => {
      render(<Host initial={FRUIT} />);
      expect(letters().map((letter) => letter.textContent)).toEqual(["A", "B", "C"]);
      // The header row is line 1 of the file and is numbered as that.
      expect(document.querySelector(".csv-table-head .csv-table-num")?.textContent).toBe("1");
      expect(nameBox()).toHaveValue("A2");
      expect(formulaBar()).toHaveValue("Pear");
      expect(cell("Pear")).toHaveClass("is-cursor");
      // The selected cell's letter and row number light up.
      expect(letters().map((letter) => letter.classList.contains("is-selected"))).toEqual([true, false, false]);
      expect(within(grid()).getAllByRole("rowheader").map((n) => n.classList.contains("is-selected"))).toEqual([true, false, false]);
      expect(document.querySelector(".csv-table-tab")?.textContent).toBe("fruit");
      expect(document.querySelector(".csv-table-range.is-single .csv-table-handle")).not.toBeNull();
      // No stripes: every row is the same.
      expect(document.querySelector(".csv-table-row.is-odd")).toBeNull();
    });

    it("adds a row at the end until a cell has been picked", () => {
      const onText = vi.fn();
      render(<Host initial={"a,b\n1,2\n3,4\n"} onText={onText} />);
      fireEvent.click(screen.getByRole("button", { name: "+ Row" }));
      expect(onText).toHaveBeenLastCalledWith("a,b\n1,2\n3,4\n,\n");
    });

    it("edits the selected cell from the formula bar, showing the cell as it is typed", () => {
      const onText = vi.fn();
      render(<Host initial={FRUIT} onText={onText} />);
      fireEvent.mouseDown(cell("Apple"));
      fireEvent.focus(formulaBar());
      fireEvent.change(formulaBar(), { target: { value: "Quince" } });
      expect(cell("Quince")).toHaveClass("is-cursor");
      expect(onText).not.toHaveBeenCalled();
      fireEvent.keyDown(formulaBar(), { key: "Enter" });
      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText).toHaveBeenLastCalledWith(FRUIT.replace("Apple", "Quince"));
      expect(cell("Plum")).toHaveClass("is-cursor");

      // Escape leaves the cell as it was.
      fireEvent.focus(formulaBar());
      fireEvent.change(formulaBar(), { target: { value: "Nope" } });
      fireEvent.keyDown(formulaBar(), { key: "Escape" });
      fireEvent.blur(formulaBar());
      expect(onText).toHaveBeenCalledTimes(1);
      expect(cell("Plum")).toBeInTheDocument();

      // Leaving the bar saves, as leaving a cell does.
      fireEvent.focus(formulaBar());
      fireEvent.change(formulaBar(), { target: { value: "Fig" } });
      fireEvent.blur(formulaBar());
      expect(onText).toHaveBeenLastCalledWith(FRUIT.replace("Apple", "Quince").replace("Plum", "Fig"));
    });

    it("shows the formula bar as text, not a field, when the sheet is read-only", () => {
      render(<Host initial={FRUIT} readOnly />);
      fireEvent.mouseDown(cell("green, ripe"));
      expect(screen.queryByRole("textbox", { name: "Cell contents" })).toBeNull();
      expect(document.querySelector(".csv-table-value")?.textContent).toBe("green, ripe");
      expect(nameBox()).toHaveValue("C2");
    });

    it("goes to a cell typed in the name box", () => {
      render(<Host initial={FRUIT} />);
      fireEvent.change(nameBox(), { target: { value: "b4" } });
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      expect(cell("100")).toHaveClass("is-cursor");
      expect(nameBox()).toHaveValue("B4");
      // The header row is a row of the file: C1.
      fireEvent.change(nameBox(), { target: { value: "C1" } });
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      expect(within(grid()).getByRole("columnheader", { name: /note/ })).toHaveClass("is-cursor");
      // A cell the file does not have goes nowhere.
      fireEvent.change(nameBox(), { target: { value: "Z99" } });
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      expect(within(grid()).getByRole("columnheader", { name: /note/ })).toHaveClass("is-cursor");
    });

    it("selects a column from its letter, a row from its number and everything from the corner", () => {
      render(<Host initial={FRUIT} />);
      fireEvent.mouseDown(within(letters()[1] as HTMLElement).getByRole("button"));
      expect(["12", "3", "100"].map((value) => cell(value).classList.contains("is-selected"))).toEqual([true, true, true]);
      expect(cell("Pear")).not.toHaveClass("is-selected");
      expect(document.querySelector(".csv-table-stats")?.textContent).toBe("Sum 115Average 38.33Count 3");
      fireEvent.mouseDown(within(grid()).getAllByRole("rowheader")[1]);
      expect(["Apple", "3", "red"].map((value) => cell(value).classList.contains("is-selected"))).toEqual([true, true, true]);
      expect(cell("Pear")).not.toHaveClass("is-selected");
      fireEvent.mouseDown(document.querySelector(".csv-table-corner")!);
      expect(within(grid()).getAllByRole("gridcell").every((c) => c.classList.contains("is-selected"))).toBe(true);
      // A block with no numbers in it is only counted.
      fireEvent.mouseDown(cell("Pear"));
      key("ArrowDown", { shiftKey: true });
      expect(document.querySelector(".csv-table-stats")?.textContent).toBe("2 cells selected");
      key("Escape");
      expect(document.querySelector(".csv-table-stats")).toBeNull();
    });

    it("selects a block by dragging and by a Shift click", () => {
      render(<Host initial={FRUIT} />);
      fireEvent.mouseDown(cell("12"));
      fireEvent.mouseEnter(cell("red"));
      fireEvent.mouseUp(window);
      expect(["12", "green, ripe", "3", "red"].map((value) => cell(value).classList.contains("is-selected"))).toEqual([true, true, true, true]);
      expect(cell("100")).not.toHaveClass("is-selected");
      // The drag is over: moving the pointer no longer changes it.
      fireEvent.mouseEnter(cell("dark"));
      expect(cell("dark")).not.toHaveClass("is-selected");
      fireEvent.mouseDown(cell("Pear"));
      fireEvent.mouseDown(cell("100"), { shiftKey: true });
      expect(["Pear", "12", "Apple", "3", "Plum", "100"].map((value) => cell(value).classList.contains("is-selected"))).toEqual([true, true, true, true, true, true]);
      expect(nameBox()).toHaveValue("A2");
    });

    it("draws numbers, money, percents and dates on the right, negatives in red, TRUE and FALSE in the middle", () => {
      const onText = vi.fn();
      render(<Host initial={SHEET} onText={onText} />);
      for (const value of ["12", "$1.20", "-4%", "2026-11-24", "11/30/2026", "€2", "0%"]) expect(cell(value), value).toHaveClass(value.includes("/") || value.includes("-11-") ? "is-date" : "is-number");
      for (const value of ["-4%", "-3", "($0.85)"]) expect(cell(value), value).toHaveClass("is-negative");
      for (const value of ["12", "12.5%", "0%"]) expect(cell(value), value).not.toHaveClass("is-negative");
      expect(cell("TRUE")).toHaveClass("is-boolean");
      expect(cell("FALSE")).toHaveClass("is-boolean");
      for (const value of ["Pear", "soon", "not a link"]) expect(cell(value).className).not.toMatch(/is-(number|date|boolean|link|negative)/);
      // What is drawn is never what is saved: the formula bar and the file keep the text as typed.
      fireEvent.mouseDown(cell("FALSE"));
      expect(formulaBar()).toHaveValue("False");
      expect(onText).not.toHaveBeenCalled();
    });

    it("draws a web address as a link: ⌘ click opens it where the sheet is edited, a plain click where it is only read", () => {
      const open = vi.fn();
      const { unmount } = render(<CsvTable text={SHEET} onChange={() => {}} onOpenLink={open} />);
      const link = () => within(grid()).getByRole("link", { name: "https://example.com/pear" });
      expect(link()).toHaveAttribute("href", "https://example.com/pear");
      expect(link()).toHaveAttribute("rel", "noopener noreferrer");
      expect(fireEvent.click(link())).toBe(false);
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(link(), { metaKey: true });
      expect(open).toHaveBeenLastCalledWith("https://example.com/pear");
      unmount();
      render(<CsvTable text={SHEET} readOnly onOpenLink={open} />);
      fireEvent.click(link());
      expect(open).toHaveBeenCalledTimes(2);
      expect(within(grid()).queryByRole("link", { name: "not a link" })).toBeNull();
    });

    it("draws the empty sheet out to the edges of the window", () => {
      const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
      const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
      try {
        render(<Host initial={FRUIT} />);
        // Letters carry on past the last column, and numbers past the last row of the file.
        const fillLetters = Array.from(document.querySelectorAll(".csv-table-letter.is-fill")).map((letter) => letter.textContent);
        expect(fillLetters.slice(0, 3)).toEqual(["D", "E", "F"]);
        const fillRows = Array.from(document.querySelectorAll(".csv-table-row.is-fill"));
        expect(fillRows.length).toBeGreaterThan(8);
        expect(fillRows[0].querySelector(".csv-table-num")?.textContent).toBe("5");
        expect(fillRows[0].querySelectorAll(".csv-table-cell.is-fill").length).toBe(3 + fillLetters.length);
        // They are drawn, not part of the table: the file has three rows and three columns.
        expect(bodyRows()).toEqual([["Pear", "12", "green, ripe"], ["Apple", "3", "red"], ["Plum", "100", "dark"]]);
        expect(within(grid()).getAllByRole("rowheader").length).toBe(3);
        expect(screen.getByRole("status")).toHaveTextContent("3 rows × 3 columns");
        // The columns take the whole width and nothing more, so nothing scrolls sideways.
        const template = (grid() as HTMLElement).style.getPropertyValue("--csv-cols").split(" ").map((size) => parseFloat(size));
        expect(template.reduce((sum, size) => sum + size, 0)).toBe(900);
      } finally {
        width.mockRestore();
        height.mockRestore();
      }
    });

    it("names and sorts the columns by letter when there is no header row", () => {
      render(<CsvTable text={"1,Apple,3\n2,Pear,12\n3,Fig,7\n"} />);
      expect(document.querySelector(".csv-table-head")).toBeNull();
      expect(within(grid()).getAllByRole("rowheader").map((n) => n.textContent)).toEqual(["1", "2", "3"]);
      const column = within(grid()).getAllByRole("columnheader")[2];
      fireEvent.click(within(column).getByRole("button", { name: "Sort column C" }));
      expect(column).toHaveAttribute("aria-sort", "ascending");
      expect(bodyRows().map((row) => row[1])).toEqual(["Apple", "Fig", "Pear"]);
    });
  });

  it("takes a new text from its host", () => {
    const { rerender } = render(<CsvTable text={"a,b\n1,2\n"} onChange={() => {}} />);
    rerender(<CsvTable text={"a,b\n9,8\n7,6\n"} onChange={() => {}} />);
    expect(bodyRows()).toEqual([["9", "8"], ["7", "6"]]);
  });
});
