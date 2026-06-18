import { describe, it, expect } from "vitest";
import { filterCommands, type AppCommand } from "./commands";

const cmd = (id: string, title: string, keywords = ""): AppCommand => ({
  id,
  title,
  group: "File",
  keywords,
  run: () => {},
});

const COMMANDS = [
  cmd("save", "Save"),
  cmd("save-as", "Save As…"),
  cmd("open", "Open File…"),
  cmd("export-pdf", "Export PDF (Dark)", "print"),
  cmd("format-tables", "Format Tables"),
];

describe("filterCommands", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(5);
  });

  it("ranks exact prefix above substring", () => {
    const out = filterCommands(COMMANDS, "save");
    expect(out[0].id).toBe("save");
    expect(out[1].id).toBe("save-as");
  });

  it("matches keywords", () => {
    const out = filterCommands(COMMANDS, "print");
    expect(out[0].id).toBe("export-pdf");
  });

  it("matches subsequences", () => {
    const out = filterCommands(COMMANDS, "fmtb");
    expect(out.some((c) => c.id === "format-tables")).toBe(true);
  });

  it("excludes non-matches", () => {
    expect(filterCommands(COMMANDS, "zzzz")).toHaveLength(0);
  });
});
