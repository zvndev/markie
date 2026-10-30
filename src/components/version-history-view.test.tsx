import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, HistoryEntry } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import { VersionHistoryView } from "@/components/version-history-view";

const NOW = new Date(2026, 9, 30, 15, 0);
const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi).toISOString();
const stampOf = (iso: string) => iso.replace(/:/g, "-");

// Newest first, as main lists them.
const ENTRIES: HistoryEntry[] = [
  { stamp: stampOf(at(30, 14, 30)), iso: at(30, 14, 30), author: "agent", agent: "claude-code", bytes: 1 },
  { stamp: stampOf(at(30, 14, 20)), iso: at(30, 14, 20), author: "user", bytes: 1 },
  { stamp: stampOf(at(30, 14, 10)), iso: at(30, 14, 10), author: "user", bytes: 1 },
  { stamp: stampOf(at(29, 9)), iso: at(29, 9), author: "external", bytes: 1, name: "Before the trip" },
];

const BODIES: Record<string, string> = {
  [ENTRIES[0].stamp]: "# Recipes\n\nCaesar dressing with lemon.\n",
  [ENTRIES[1].stamp]: "# Recipes\n\nCaesar dressing.\n",
  [ENTRIES[2].stamp]: "# Recipes\n\nCaesar.\n",
  [ENTRIES[3].stamp]: "# Recipes\n",
};

const CURRENT = "# Recipes\n\nCaesar dressing with lemon and anchovy.\n";

function setup(overrides: Partial<ElectronAPI> = {}, props: { dirty?: boolean; fileName?: string; current?: string } = {}) {
  let list = ENTRIES.map((e) => ({ ...e }));
  const historyName = vi.fn(async ({ stamp, name }: { stamp?: string; name: string }) => {
    list = list.map((e) => (e.stamp === stamp ? { ...e, name: name || undefined } : e));
    return { ok: true, stamp, name };
  });
  const api = installBridge({
    historyList: vi.fn(async () => list),
    historyRead: vi.fn(async ({ stamp }: { stamp: string }) => ({ content: BODIES[stamp] ?? null })),
    historyHead: vi.fn(async () => ({ author: "user", iso: at(30, 14, 50) })),
    historyName,
    ...overrides,
  } as Partial<ElectronAPI>);
  const onRestore = vi.fn();
  const onClose = vi.fn();
  render(
    <VersionHistoryView
      filePath="/notes/recipes.md"
      fileName={props.fileName ?? "recipes.md"}
      currentContent={props.current ?? CURRENT}
      dirty={props.dirty ?? false}
      onRestore={onRestore}
      onClose={onClose}
      now={() => NOW}
    />
  );
  return { api, onRestore, onClose, historyName };
}

const rowFor = (label: RegExp) => within(screen.getByRole("listbox", { name: "Versions" })).getAllByRole("option").find((o) => label.test(o.textContent ?? ""))!;

beforeEach(() => {
  localStorage.clear();
});

describe("VersionHistoryView", () => {
  it("lists versions by day with the current version first, and authors by name", async () => {
    setup();
    const list = await screen.findByRole("listbox", { name: "Versions" });
    await within(list).findByText("Claude Code");
    const groups = within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Today", "Yesterday"]);
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveTextContent(/Current version/);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByText("External edit")).toBeInTheDocument();
    // The named version shows its name, in bold.
    expect(within(list).getByText("Before the trip")).toHaveClass("markie-vh-row-name");
  });

  it("folds autosaves by the same author within half an hour under one row", async () => {
    setup();
    await screen.findByText("Claude Code");
    // 14:20 and 14:10 by you fold together; the agent's 14:30 stands alone.
    const toggle = screen.getByRole("button", { name: "Show 1 more version" });
    expect(within(screen.getByRole("listbox", { name: "Versions" })).getAllByRole("option")).toHaveLength(4);
    await userEvent.click(toggle);
    expect(within(screen.getByRole("listbox", { name: "Versions" })).getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Hide minor versions" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the selected version read-only with what it changed highlighted", async () => {
    setup();
    await screen.findByText("Claude Code");
    await userEvent.click(rowFor(/October 30, 2:30 PM/));
    const doc = await screen.findByRole("main", { name: "Selected version" });
    // Compared with the version before it: "with lemon" was added.
    await waitFor(() => expect(doc.querySelector("ins.markie-vh-ins")?.textContent).toBe("with lemon"));
    expect(doc.querySelector("[contenteditable]")).toBeNull();
    expect(screen.getByText("Today, 2:30 PM")).toBeInTheDocument();
  });

  it("highlights the current text against the newest version, and turns highlighting off", async () => {
    setup();
    const doc = await screen.findByRole("main", { name: "Selected version" });
    await waitFor(() => expect(doc.querySelector("ins")?.textContent).toBe("and anchovy"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Highlight changes" }));
    expect(doc.querySelector("ins")).toBeNull();
    expect(doc).toHaveTextContent("Caesar dressing with lemon and anchovy.");
  });

  it("shows removed text struck through", async () => {
    setup({}, { current: "# Recipes\n\nCaesar dressing.\n" });
    const doc = await screen.findByRole("main", { name: "Selected version" });
    await waitFor(() => expect(doc.querySelector("del.markie-vh-del")?.textContent).toBe("with lemon"));
  });

  it("restores a version into the buffer through onRestore, and never for the current one", async () => {
    const { onRestore } = setup();
    await screen.findByText("Claude Code");
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    await userEvent.click(rowFor(/Before the trip/));
    const restore = await screen.findByRole("button", { name: "Restore this version" });
    await waitFor(() => expect(restore).toBeEnabled());
    await userEvent.click(restore);
    expect(onRestore).toHaveBeenCalledWith("# Recipes\n");
  });

  it("copies a version's text from its menu", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await screen.findByText("Claude Code");
    const row = rowFor(/October 30, 2:30 PM/);
    await userEvent.click(within(row).getByRole("button", { name: "Version actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(BODIES[ENTRIES[0].stamp]));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  it("names a version, and shows the name in the list", async () => {
    const { historyName } = setup();
    await screen.findByText("Claude Code");
    const row = rowFor(/October 30, 2:30 PM/);
    await userEvent.click(within(row).getByRole("button", { name: "Version actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Name this version" }));
    const input = screen.getByRole("textbox", { name: "Version name" });
    await userEvent.type(input, "Lemon added{Enter}");
    expect(historyName).toHaveBeenCalledWith({ path: "/notes/recipes.md", stamp: ENTRIES[0].stamp, name: "Lemon added" });
    expect(await screen.findByText("Lemon added")).toHaveClass("markie-vh-row-name");
  });

  it("names the current version through main, and not while it has unsaved edits", async () => {
    const { historyName } = setup();
    await screen.findByText("Claude Code");
    const current = rowFor(/Current version/);
    await userEvent.click(within(current).getByRole("button", { name: "Version actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Name current version" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Version name" }), "Final{Enter}");
    // No stamp: main keeps what is on disk as a version first.
    expect(historyName).toHaveBeenCalledWith({ path: "/notes/recipes.md", name: "Final" });
  });

  it("will not name the current version while it has unsaved edits", async () => {
    setup({}, { dirty: true });
    await screen.findByText("Claude Code");
    const current = rowFor(/Current version/);
    expect(current).toHaveTextContent("Unsaved changes");
    await userEvent.click(within(current).getByRole("button", { name: "Version actions" }));
    expect(screen.getByRole("menuitem", { name: "Name current version" })).toBeDisabled();
  });

  it("filters to named versions", async () => {
    setup();
    await screen.findByText("Claude Code");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Which versions" }), "named");
    const options = within(screen.getByRole("listbox", { name: "Versions" })).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Before the trip");
  });

  it("goes back to the document with Escape or the back arrow", async () => {
    const { onClose } = setup();
    await screen.findByText("Claude Code");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Back to the document" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Escape closes an open menu before it leaves history", async () => {
    const { onClose } = setup();
    await screen.findByText("Claude Code");
    await userEvent.click(within(rowFor(/October 30, 2:30 PM/)).getByRole("button", { name: "Version actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a plain text file as source, with the same highlights", async () => {
    setup(
      {
        historyList: vi.fn(async () => [ENTRIES[0]]),
        historyRead: vi.fn(async () => ({ content: "a,b\n1,2\n" })),
      } as Partial<ElectronAPI>,
      { fileName: "table.csv", current: "a,b\n1,3\n" }
    );
    const doc = await screen.findByRole("main", { name: "Selected version" });
    await waitFor(() => expect(doc.querySelector("pre ins")?.textContent).toBe("3"));
    expect(doc.querySelector("pre del")?.textContent).toBe("2");
  });

  it("treats a newest version that holds the current text as the current version", async () => {
    // The watcher records an agent's write as it lands, so the newest stored
    // version is the text on screen. It is not listed twice.
    setup({}, { current: BODIES[ENTRIES[0].stamp] });
    await screen.findByText("Claude Code");
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Versions" })).getAllByRole("option")).toHaveLength(3));
    expect(rowFor(/Current version/)).toHaveTextContent("Claude Code");
  });
});
