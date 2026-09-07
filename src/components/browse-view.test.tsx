import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, MdRow, MdScanResult } from "@/lib/electron";

// The real formatters, wrapped so calls can be counted. `updatedOn` is called
// once per file row render and nowhere else, which is how the memo test below
// counts renders without reaching inside the component.
const time = vi.hoisted(() => ({ updatedAgo: vi.fn(), updatedOn: vi.fn() }));
vi.mock("@/lib/relative-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/relative-time")>();
  time.updatedAgo.mockImplementation(real.updatedAgo);
  time.updatedOn.mockImplementation(real.updatedOn);
  return { ...real, updatedAgo: time.updatedAgo, updatedOn: time.updatedOn };
});
import { emit, installBridge } from "@/test/mock-bridge";
import { BrowseView } from "./browse-view";

const row = (o: Partial<MdRow> = {}): MdRow => ({
  path: "/home/me/notes/one.md",
  name: "one.md",
  dir: "/home/me/notes",
  mtimeMs: 1,
  ...o,
});

const scan = (o: Partial<MdScanResult> = {}): MdScanResult => ({
  files: [row()],
  scannedAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

function renderBrowse(result: MdScanResult, overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({
    mdIndexScan: vi.fn(async () => result),
    mdIndexStars: vi.fn(async () => []),
    ...overrides,
  });
  const onOpenPath = vi.fn();
  render(<BrowseView onOpenPath={onOpenPath} activePath={null} />);
  return { api, onOpenPath };
}

const NOTE = /^Index is incomplete:/;

beforeEach(() => {
  localStorage.clear();
  time.updatedAgo.mockClear();
  time.updatedOn.mockClear();
});

describe("BrowseView truncated index", () => {
  it("says the index is incomplete, with the reason main gave", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "time budget reached" }));
    expect(
      await screen.findByText("Index is incomplete: time budget reached")
    ).toBeInTheDocument();
  });

  it("still says so when the reason is missing", async () => {
    renderBrowse(scan({ truncated: true }));
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("says nothing when the field is absent, as an older main leaves it", async () => {
    renderBrowse(scan());
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("says nothing for a complete scan", async () => {
    renderBrowse(scan({ truncated: false, truncatedReason: null }));
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("sits above the list, not in place of it", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "depth cap" }));
    const note = await screen.findByText("Index is incomplete: depth cap");
    expect(screen.getByText("one.md")).toBeInTheDocument();
    expect(
      note.compareDocumentPosition(screen.getByText("one.md")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("clears once a rescan comes back complete", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "time budget reached" }), {
      mdIndexRefresh: vi.fn(async () => scan()),
    } as Partial<ElectronAPI>);
    await screen.findByText(NOTE);
    await userEvent.click(screen.getByTitle("Rescan"));
    await waitFor(() => expect(screen.queryByText(NOTE)).not.toBeInTheDocument());
  });

  it("appears when a pushed index update is the truncated one", async () => {
    renderBrowse(scan());
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    await act(async () => {
      emit("onMdIndexUpdated", {
        ...scan({ truncated: true, truncatedReason: "too many folders" }),
      });
    });
    expect(
      await screen.findByText("Index is incomplete: too many folders")
    ).toBeInTheDocument();
  });

  it("stays out of the way of a failed scan, which has its own message", async () => {
    renderBrowse({
      files: undefined as unknown as MdRow[],
      scannedAt: null,
      error: "Couldn't read your markdown files.",
      truncated: true,
    });
    expect(
      await screen.findByText(/Couldn't read your markdown files\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});

const MIN = 60_000;
const HOUR = 60 * MIN;

// A project with two folders under it, so the tree has a branch to open at and
// names and times that disagree about the order everything belongs in: "docs"
// sorts first by name, "notes" holds the file touched most recently.
const project = (): MdRow[] => [
  row({ path: "/home/me/work/docs/guide.md", name: "guide.md", dir: "/home/me/work/docs", mtimeMs: Date.now() - 3 * HOUR }),
  row({ path: "/home/me/work/notes/aaa.md", name: "aaa.md", dir: "/home/me/work/notes", mtimeMs: Date.now() - 2 * HOUR }),
  row({ path: "/home/me/work/notes/zzz.md", name: "zzz.md", dir: "/home/me/work/notes", mtimeMs: Date.now() - 5 * MIN }),
];

const folderLabels = () =>
  [...document.querySelectorAll("[data-markie-folder-node]")].map((n) =>
    n.getAttribute("data-markie-folder-node")
  );

describe("BrowseView browsing", () => {
  it("has no mode toggle: the folder tree is the only view", async () => {
    renderBrowse(scan());
    await screen.findByText("one.md");
    expect(screen.queryByText("All files")).not.toBeInTheDocument();
    expect(screen.queryByText("Folders")).not.toBeInTheDocument();
  });

  // Everything used to start closed, so Browse opened on a single row.
  it("opens down to the first folder that offers a choice", async () => {
    renderBrowse(scan({ files: project() }));
    // The two subfolders are on screen; what is inside them is not.
    expect(await screen.findByText("docs")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
  });

  it("nests a level inside a bordered container rather than by padding", async () => {
    renderBrowse(scan({ files: project() }));
    await screen.findByText("docs");
    const root = document.querySelector('[data-markie-folder-node="/home/me/work"]');
    const children = root?.querySelector("[data-markie-browse-children]");
    expect(children).toBeTruthy();
    expect(children?.className).toContain("border-l");
    expect(children?.className).toContain("border-border");
    // A level costs the 12 px it always cost: the hairline comes out of the
    // old indent, it is not added to it.
    expect(children?.className).toContain("ml-[6px]");
    expect(children?.className).toContain("pl-[5px]");
    // The row itself keeps one small padding at every depth.
    expect(root?.firstElementChild?.className).toContain("pl-1");
  });

  it("prints how long ago each file changed, with the full date behind it", async () => {
    const when = Date.now() - 2 * HOUR;
    renderBrowse(scan({ files: [row({ mtimeMs: when })] }));
    await screen.findByText("one.md");
    const cell = document.querySelector("[data-markie-browse-updated]");
    expect(cell?.textContent).toBe("2h ago");
    expect(cell?.getAttribute("title")).toBe(new Date(when).toLocaleString());
    // A name squeezed out by the indent is still one hover from readable.
    expect(screen.getByText("one.md")).toHaveAttribute("title", "/home/me/notes/one.md");
  });

  it("sorts files by name, and by when they changed when asked to", async () => {
    renderBrowse(scan({ files: project() }));
    await userEvent.click(await screen.findByText("notes"));
    const names = () =>
      [...document.querySelectorAll('[data-markie-folder-node="/home/me/work/notes"] [data-markie-browse-updated]')]
        .map((cell) => cell.previousElementSibling?.textContent);
    expect(names()).toEqual(["aaa.md", "zzz.md"]);
    await userEvent.click(screen.getByText("Updated"));
    expect(names()).toEqual(["zzz.md", "aaa.md"]);
  });

  it("sorts folders by the newest file beneath them", async () => {
    renderBrowse(scan({ files: project() }));
    await screen.findByText("docs");
    expect(folderLabels()).toEqual([
      "/home/me/work",
      "/home/me/work/docs",
      "/home/me/work/notes",
    ]);
    await userEvent.click(screen.getByText("Updated"));
    expect(folderLabels()).toEqual([
      "/home/me/work",
      "/home/me/work/notes",
      "/home/me/work/docs",
    ]);
  });

  it("remembers the sort across a fresh mount", async () => {
    localStorage.setItem("markie.browse.sort.v1", "updated");
    renderBrowse(scan({ files: project() }));
    await screen.findByText("docs");
    expect(screen.getByText("Updated")).toHaveAttribute("aria-pressed", "true");
  });

  it("remembers what the user opened and closed, and prefers it to the initial rule", async () => {
    localStorage.setItem(
      "markie.browse.open.v1",
      JSON.stringify({ open: ["/home/me/work/notes"], closed: ["/home/me/work"] })
    );
    renderBrowse(scan({ files: project() }));
    // The root is closed because the user closed it, even though the rule
    // would have opened it and a remembered folder sits inside it.
    await waitFor(() => expect(screen.queryByText("Scanning your markdown…")).not.toBeInTheDocument());
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
  });

  it("opens a new ancestor above a remembered folder rather than hiding it", async () => {
    // The user had /home/me/work open (its own root at the time). Today the
    // index also has /home/me/downloads, so the root is /home/me, which no
    // stored set could have named.
    localStorage.setItem("markie.browse.open.v1", JSON.stringify({ open: ["/home/me/work"], closed: [] }));
    renderBrowse(
      scan({
        files: [
          ...project(),
          row({ path: "/home/me/downloads/x.md", name: "x.md", dir: "/home/me/downloads" }),
        ],
      })
    );
    await screen.findByText("docs");
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("downloads")).toBeInTheDocument();
    // downloads itself was never opened, so its file stays out of sight.
    expect(screen.queryByText("x.md")).not.toBeInTheDocument();
  });

  it("reads the first storage shape, an open list alone, as having closed nothing", async () => {
    localStorage.setItem("markie.browse.open.v1", JSON.stringify(["/home/me/work/notes"]));
    renderBrowse(scan({ files: project() }));
    // Nothing says the root was closed by hand, so the remembered folder is
    // reachable: the root opens for it.
    await screen.findByText("notes");
    expect(screen.getByText("zzz.md")).toBeInTheDocument();
  });

  it("writes what is open and what was closed back to storage", async () => {
    renderBrowse(scan({ files: project() }));
    await userEvent.click(await screen.findByText("notes"));
    expect(JSON.parse(localStorage.getItem("markie.browse.open.v1") as string)).toEqual({
      open: ["/home/me/work", "/home/me/work/notes"],
      closed: [],
    });
    expect(screen.getByText("zzz.md")).toBeInTheDocument();
    await userEvent.click(screen.getByText("notes"));
    expect(JSON.parse(localStorage.getItem("markie.browse.open.v1") as string)).toEqual({
      open: ["/home/me/work"],
      closed: ["/home/me/work/notes"],
    });
    expect(screen.queryByText("zzz.md")).not.toBeInTheDocument();
  });
});

const filterField = () => screen.getByPlaceholderText(/Filter by name or path/);
const dateCell = () => document.querySelector("[data-markie-browse-updated]");

describe("BrowseView dates that keep themselves honest", () => {
  it("shows nothing, and no tooltip, for a file the indexer could not stat", async () => {
    renderBrowse(scan({ files: [row({ mtimeMs: 0 })] }));
    await screen.findByText("one.md");
    expect(dateCell()?.textContent).toBe("");
    expect(dateCell()?.hasAttribute("title")).toBe(false);
  });

  // Browse can sit open all afternoon without a click, and "just now" was
  // staying on screen long after it stopped being true.
  it("ages while the panel sits open, with nobody touching it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));
      renderBrowse(scan({ files: [row({ mtimeMs: Date.now() - 30_000 })] }));
      await act(async () => {});
      expect(dateCell()?.textContent).toBe("just now");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(dateCell()?.textContent).toBe("2m ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops ticking once Browse is gone", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));
      const { unmount } = render(<BrowseView onOpenPath={vi.fn()} activePath={null} />);
      await act(async () => {});
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BrowseView toggling under a filter", () => {
  // The filter holds matching rows open, so a chevron has nothing to close.
  // What used to last was the save: the filtered tree's shape was written over
  // the user's own open set, and folders they never touched closed when the
  // filter cleared.
  it("leaves the remembered open set alone", async () => {
    renderBrowse(scan({ files: project() }));
    await screen.findByText("docs");
    expect(localStorage.getItem("markie.browse.open.v1")).toBeNull();

    await userEvent.type(filterField(), "docs");
    expect(await screen.findByText("guide.md")).toBeInTheDocument();

    const forcedRow = document.querySelector("[data-markie-folder-node] > div") as HTMLElement;
    await userEvent.click(forcedRow);
    // Still open, because the filter says so, and nothing was written down.
    expect(screen.getByText("guide.md")).toBeInTheDocument();
    expect(localStorage.getItem("markie.browse.open.v1")).toBeNull();

    await userEvent.clear(filterField());
    expect(await screen.findByText("notes")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("still opens a file from a row the filter forced open", async () => {
    const { onOpenPath } = renderBrowse(scan({ files: project() }));
    await screen.findByText("docs");
    await userEvent.type(filterField(), "guide");
    await userEvent.click(await screen.findByText("guide.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/home/me/work/docs/guide.md");
  });
});

// One folder holding the whole index is allowed: electron/mdindex.js indexes up
// to 200,000 files and nothing says they have to be spread out. The tree used
// to open closed, so this folder was never drawn; now it opens on sight.
const CROWDED = 200_000;
const crowded = (): MdRow[] =>
  Array.from({ length: CROWDED }, (_, i) => ({
    path: `/home/me/big/file${i}.md`,
    name: `file${i}.md`,
    dir: "/home/me/big",
    mtimeMs: i + 1,
  }));

const childRows = () =>
  [...(document.querySelector("[data-markie-browse-children]")?.children ?? [])];

describe("BrowseView with one enormous folder", () => {
  it("draws 200 rows and offers the rest", async () => {
    renderBrowse(scan({ files: crowded() }));
    await screen.findByText("file0.md");
    // 200 files, then the row that offers the other 199,800.
    expect(childRows()).toHaveLength(201);
    expect(screen.getByText("Show 199,800 more")).toBeInTheDocument();
  }, 30_000);

  it("draws the rest when asked, and only then", async () => {
    renderBrowse(scan({ files: crowded().slice(0, 320) }));
    await screen.findByText("file0.md");
    expect(childRows()).toHaveLength(201);
    await userEvent.click(screen.getByText("Show 120 more"));
    expect(childRows()).toHaveLength(320);
    expect(screen.queryByText(/^Show /)).not.toBeInTheDocument();
  }, 30_000);

  it("puts the cap back when the index is refreshed under the same sort and filter", async () => {
    renderBrowse(scan({ files: crowded().slice(0, 320) }));
    await screen.findByText("file0.md");
    await userEvent.click(screen.getByText("Show 120 more"));
    expect(childRows()).toHaveLength(320);
    // A rescan found one more file in the same folder: a different list, and
    // the folder that was asked for all its rows is not this one.
    const labelled = time.updatedAgo.mock.calls.length;
    await act(async () => {
      emit("onMdIndexUpdated", scan({ files: crowded().slice(0, 321) }));
    });
    expect(childRows()).toHaveLength(201);
    expect(screen.getByText("Show 121 more")).toBeInTheDocument();
    expect(time.updatedAgo.mock.calls.length - labelled).toBeLessThan(321);
  }, 30_000);

  it("keeps a reveal when a file is starred with the star filter off", async () => {
    let starred: string[] = [];
    renderBrowse(scan({ files: crowded().slice(0, 320) }), {
      mdIndexStars: vi.fn(async () => starred.map((path) => ({ path, kind: "file" as const }))),
      mdIndexToggleStar: vi.fn(async (path: string) => {
        starred = [path];
        return { starred: true };
      }),
    });
    await screen.findByText("file0.md");
    await userEvent.click(screen.getByText("Show 120 more"));
    expect(childRows()).toHaveLength(320);
    // Starring is decoration on a list that has not changed: the row keeps
    // its star and the folder keeps its rows.
    const stars = screen.getAllByTitle("Star");
    await userEvent.click(stars[stars.length - 1]);
    await screen.findByTitle("Unstar");
    expect(childRows()).toHaveLength(320);
  }, 30_000);

  it("puts the cap back when the list underneath changes, before anything is drawn", async () => {
    renderBrowse(scan({ files: crowded().slice(0, 320) }));
    await screen.findByText("file0.md");
    await userEvent.click(screen.getByText("Show 120 more"));
    expect(childRows()).toHaveLength(320);
    // The parent labels every file it draws, so the labels counted across the
    // change are the rows that were ever drawn for the new list. A reset that
    // ran after the render would have drawn all 320 first.
    const labelled = time.updatedAgo.mock.calls.length;
    await userEvent.click(screen.getByText("Updated"));
    expect(childRows()).toHaveLength(201);
    expect(time.updatedAgo.mock.calls.length - labelled).toBeLessThan(320);
  }, 30_000);
});

describe("BrowseView minute tick", () => {
  // The tick re-renders the tree so the dates age. A row whose date is three
  // days old has nothing to say differently, and must not be re-rendered to
  // print the same words twice.
  it("leaves rows alone when their date has not changed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));
      renderBrowse(scan({ files: [row({ mtimeMs: Date.now() - 3 * 24 * 60 * 60_000 })] }));
      await act(async () => {});
      expect(dateCell()?.textContent).toBe("Sep 4");
      const rendersSoFar = time.updatedOn.mock.calls.length;
      const labelsSoFar = time.updatedAgo.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000);
      });

      // The tick fired and the label was recomputed, and the row still did not
      // re-render, because the answer came back the same.
      expect(time.updatedAgo.mock.calls.length).toBeGreaterThan(labelsSoFar);
      expect(time.updatedOn.mock.calls.length).toBe(rendersSoFar);
      expect(dateCell()?.textContent).toBe("Sep 4");
    } finally {
      vi.useRealTimers();
    }
  });
});
