import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "@/lib/electron";
import type { SharedByMeDoc } from "@/lib/auth-client";

const sharedByMe = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  sharesClient: { sharedByMe: () => sharedByMe() },
}));

import { CloudView } from "./cloud-view";

const item = (o: Partial<LibraryItem> = {}): LibraryItem =>
  ({
    kind: "local",
    path: "/notes/one.md",
    name: "one.md",
    cloudId: null,
    state: "local-only",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    remoteVersion: null,
    exists: true,
    // The server confirmed these belong to this account; the fixtures about
    // other people's documents say so themselves.
    owned: true,
    ...o,
  }) as LibraryItem;

const synced = (o: Partial<LibraryItem> = {}) =>
  item({ name: "synced.md", path: "/notes/synced.md", state: "synced", cloudId: "c1", ...o });

const cloudOnly = (o: Partial<LibraryItem> = {}) =>
  item({
    kind: "cloud-only",
    name: "in-my-cloud.md",
    path: null,
    state: "cloud-only",
    cloudId: "c2",
    exists: false,
    ...o,
  } as Partial<LibraryItem>);

const sharedWithMe = (o: Partial<LibraryItem> = {}) =>
  item({
    kind: "shared",
    name: "from-grace.md",
    path: null,
    state: "cloud-only",
    cloudId: "c3",
    exists: false,
    owned: false,
    shared: true,
    sharedBy: "Grace",
    role: "editor",
    ...o,
  } as Partial<LibraryItem>);

const doc = (o: Partial<SharedByMeDoc> = {}): SharedByMeDoc => ({
  id: "d1",
  name: "brief.md",
  updated_at: new Date().toISOString(),
  memberCount: 1,
  pendingCount: 0,
  ...o,
});

function props(over: Partial<React.ComponentProps<typeof CloudView>> = {}) {
  return {
    items: [],
    loading: false,
    renderRow: (i: LibraryItem) => <div key={i.name} data-testid="row">{i.name}</div>,
    signedIn: true,
    accountId: "user-a",
    onManage: vi.fn(),
    onOpenPath: vi.fn(),
    cloudError: null,
    refreshKey: 0,
    ...over,
  } satisfies React.ComponentProps<typeof CloudView>;
}

function renderView(props: Partial<React.ComponentProps<typeof CloudView>> = {}) {
  const onManage = vi.fn();
  const onOpenPath = vi.fn();
  // Stands in for the Library's row renderer, which the Cloud page borrows so
  // that badges, Download and Open live in one place (proven in library.test).
  const renderRow = vi.fn((i: LibraryItem) => (
    <div key={i.cloudId ?? i.name} data-testid="row">
      {i.name}
    </div>
  ));
  const view = render(
    <CloudView
      items={[]}
      loading={false}
      renderRow={renderRow}
      signedIn
      accountId="user-a"
      onManage={onManage}
      onOpenPath={onOpenPath}
      cloudError={null}
      refreshKey={0}
      {...props}
    />
  );
  return { onManage, onOpenPath, renderRow, view };
}

// Every row's name, top to bottom. A library row is the stub renderer's
// div; a shared-only row has no library row and leads with its name.
const rowNames = () =>
  [...document.querySelectorAll("[data-cloud-row]")].map(
    (el) => el.querySelector("[data-testid='row'], span")?.textContent
  );

const rowFor = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-cloud-row]")].find((el) =>
    el.textContent?.includes(name)
  ) ?? null;

const badge = (name: string) => rowFor(name)?.querySelector("[data-cloud-badge]")?.textContent;

const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label} \\d+$`) });

beforeEach(() => {
  localStorage.clear();
  sharedByMe.mockReset();
  sharedByMe.mockResolvedValue([]);
});

describe("the Cloud page's one list", () => {
  const MIXED = [
    // On this device and unknown to the cloud: belongs to the Library, not here.
    item({ name: "local.md", path: "/notes/local.md", state: "local-only" }),
    synced(),
    cloudOnly(),
    sharedWithMe(),
  ];

  it("lists every kind of document together, with no sections to open", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: MIXED });
    await screen.findByText("brief.md");

    expect([...rowNames()].sort()).toEqual(["brief.md", "from-grace.md", "in-my-cloud.md", "synced.md"]);
    expect(document.querySelectorAll("[data-cloud-section]")).toHaveLength(0);
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
    // A file the cloud has never heard of has nothing to say on this page.
    expect(screen.queryByText("local.md")).not.toBeInTheDocument();
  });

  it("puts the most recently updated document first, whatever its source", async () => {
    sharedByMe.mockResolvedValue([doc({ id: "d9", name: "brief.md", updated_at: "2026-03-01T00:00:00.000Z" })]);
    renderView({
      items: [
        synced({ lastOpenedAt: "2026-01-01T00:00:00.000Z" }),
        cloudOnly({ lastOpenedAt: "2026-04-01T00:00:00.000Z" }),
        sharedWithMe({ lastOpenedAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });
    await screen.findByText("brief.md");
    expect(rowNames()).toEqual(["in-my-cloud.md", "brief.md", "from-grace.md", "synced.md"]);
  });

  it("applies the same type and text query to internally fetched shared documents", async () => {
    sharedByMe.mockResolvedValue([doc({ id: "md", name: "brief.md" }), doc({ id: "txt", name: "summary.txt" })]);
    const view = render(<CloudView {...props({ items: [synced(), cloudOnly({ name: "summary.txt" })], query: { search: "summary", format: "text", sort: "name" } })} />);
    await waitFor(() => expect(rowNames()).toEqual(["summary.txt", "summary.txt"]));
    expect(screen.queryByText("brief.md")).not.toBeInTheDocument();
    expect(screen.queryByText("synced.md")).not.toBeInTheDocument();
    view.rerender(<CloudView {...props({ items: [synced()], query: { search: "", format: "all", sort: "default" } })} />);
    await screen.findByText("brief.md");
    expect(screen.getByText("synced.md")).toBeInTheDocument();
  });

  it("honors explicit name sorting across the whole list", async () => {
    sharedByMe.mockResolvedValue([doc({ id: "z", name: "zebra.md" }), doc({ id: "a", name: "alpha.md" })]);
    renderView({ items: [synced({ name: "z.md", path: "/z.md", cloudId: "zz" }), synced({ name: "a.md", path: "/a.md", cloudId: "aa" })], query: { search: "", format: "all", sort: "name" } });
    await screen.findByText("alpha.md");
    expect(rowNames()).toEqual(["a.md", "alpha.md", "z.md", "zebra.md"]);
  });

  it("shows a document I have shared once, as its library row with Manage beside it", async () => {
    // The device has the file and the server's list names it as shared. One
    // row keeps the Library's open and pull, and adds who can read it.
    sharedByMe.mockResolvedValue([doc({ id: "c1", name: "brief.md", memberCount: 3 })]);
    const { onManage, renderRow } = renderView({ items: [synced()] });
    await waitFor(() => expect(badge("synced.md")).toBe("Shared with 3"));
    expect(rowNames()).toEqual(["synced.md"]);
    expect(renderRow.mock.calls.map(([i]) => i.name)).toContain("synced.md");
    await userEvent.click(screen.getByTitle("Manage who can access brief.md"));
    expect(onManage).toHaveBeenCalledExactlyOnceWith("c1", "brief.md");
  });

  it("hands cloud-only rows to the Library's renderer, which carries Download", () => {
    const { renderRow } = renderView({ items: MIXED });
    const rendered = renderRow.mock.calls.map(([i]) => i.name);
    expect(rendered).toContain("in-my-cloud.md");
    expect(rendered).not.toContain("local.md");
  });

  it("files someone else's document as shared with me, copy on this device or not", async () => {
    // Ownership decides the source. A local copy only decides what the row
    // can do, so calling it one of mine would say the wrong thing about who
    // the document belongs to.
    renderView({
      items: [synced({ name: "theirs.md", cloudId: "c9", owned: false, shared: true, sharedBy: "Grace" })],
    });
    await waitFor(() => expect(badge("theirs.md")).toBe("Shared with you"));
    expect(rowFor("theirs.md")?.dataset.cloudRow).toBe("with-me");
  });

  it("keeps my document in the list once its file is gone from this device", async () => {
    // The cloud copy is the only one left, and the row is where the way back is.
    renderView({ items: [synced({ name: "gone.md", exists: false })] });
    await waitFor(() => expect(rowFor("gone.md")?.dataset.cloudRow).toBe("only-me"));
    expect(await screen.findByText("1 document")).toBeInTheDocument();
  });

  it("keeps a document remembered as shared under Shared with me while the server is away", async () => {
    // The list did not load. The row carries the role this account remembers
    // and no name for who shared it, and it is still in the list.
    renderView({
      items: [synced({ name: "theirs.md", cloudId: "c9", owned: false, shared: true, role: "editor", sharedBy: null })],
      cloudError: "Couldn't reach the server, so your cloud documents may be out of date.",
    });
    await waitFor(() => expect(badge("theirs.md")).toBe("Shared with you"));
    expect(rowFor("theirs.md")?.dataset.cloudRow).toBe("with-me");
  });

  it("leaves a row nobody has vouched for out of the list", async () => {
    // The server did not answer, so this row carries no owner. It is still in
    // the Library's list of what is on this device; it just cannot claim a
    // source here until somebody says whose it is.
    renderView({ items: [synced({ name: "unknown.md", owned: null })] });
    expect(await screen.findByText("Nothing in your cloud yet")).toBeInTheDocument();
    expect(screen.queryByText("unknown.md")).not.toBeInTheDocument();
  });

  it("says the cloud is empty rather than leaving a blank page", async () => {
    renderView();
    expect(await screen.findByText("Nothing in the cloud yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing in your cloud yet")).toBeInTheDocument();
  });
});

describe("how each row says it reached you", () => {
  it("names the people and invites on a document I shared", async () => {
    sharedByMe.mockResolvedValue([
      doc({ id: "a", name: "both.md", memberCount: 2, pendingCount: 1 }),
      doc({ id: "b", name: "invites.md", memberCount: 0, pendingCount: 2 }),
      doc({ id: "c", name: "one.md", memberCount: 1, pendingCount: 0 }),
    ]);
    renderView();
    await screen.findByText("both.md");
    expect(badge("both.md")).toBe("Shared with 2 · 1 invited");
    expect(badge("invites.md")).toBe("2 invited");
    expect(badge("one.md")).toBe("Shared with 1");
  });

  it("names who shared a document with me, or says it was shared when nobody is named", async () => {
    renderView({ items: [sharedWithMe(), sharedWithMe({ name: "unnamed.md", cloudId: "c4", sharedBy: null })] });
    await waitFor(() => expect(badge("from-grace.md")).toBe("Shared with you"));
    expect(badge("unnamed.md")).toBe("Shared with you");
  });

  it("says only I can see a document once the shared list has answered, and no sooner", async () => {
    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    renderView({ items: [synced()] });
    // "Only you" is a claim the shared list has to back.
    expect(badge("synced.md")).toBe("Yours");
    settle([]);
    await waitFor(() => expect(badge("synced.md")).toBe("Only you"));
  });

  it("keeps calling it mine without claiming nobody else can see it when the shared list failed", async () => {
    sharedByMe.mockResolvedValue(null);
    renderView({ items: [synced()] });
    expect(await screen.findByText("Couldn't load the documents you've shared")).toBeInTheDocument();
    expect(badge("synced.md")).toBe("Yours");
  });
});

describe("the source toggles", () => {
  const ITEMS = [synced(), cloudOnly(), sharedWithMe()];
  const SHARED = [doc({ id: "d1", name: "brief.md" }), doc({ id: "d2", name: "plan.md" })];

  it("counts each source and the whole list, starting on All", async () => {
    sharedByMe.mockResolvedValue(SHARED);
    renderView({ items: ITEMS });
    await screen.findByText("brief.md");
    expect(chip("All")).toHaveTextContent("All 5");
    expect(chip("Only me")).toHaveTextContent("Only me 2");
    expect(chip("Shared by me")).toHaveTextContent("Shared by me 2");
    expect(chip("Shared with me")).toHaveTextContent("Shared with me 1");
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Only me", "Shared by me", "Shared with me"]) {
      expect(chip(label)).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("counts only what the text query lets through", async () => {
    sharedByMe.mockResolvedValue(SHARED);
    renderView({ items: ITEMS, query: { search: "brief", format: "all", sort: "default" } });
    await screen.findByText("brief.md");
    expect(chip("All")).toHaveTextContent("All 1");
    expect(chip("Shared by me")).toHaveTextContent("Shared by me 1");
    expect(chip("Only me")).toHaveTextContent("Only me 0");
  });

  it("shows the union of every toggle that is on, and All again once they are all off", async () => {
    sharedByMe.mockResolvedValue(SHARED);
    renderView({ items: ITEMS });
    await screen.findByText("brief.md");

    await userEvent.click(chip("Shared with me"));
    expect(rowNames()).toEqual(["from-grace.md"]);
    expect(chip("All")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("1 of 5 documents")).toBeInTheDocument();

    await userEvent.click(chip("Shared by me"));
    expect([...rowNames()].sort()).toEqual(["brief.md", "from-grace.md", "plan.md"]);
    expect(chip("Shared by me")).toHaveAttribute("aria-pressed", "true");
    expect(chip("Shared with me")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(chip("Shared with me"));
    await userEvent.click(chip("Shared by me"));
    expect(rowNames()).toHaveLength(5);
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("clears every toggle when All is pressed", async () => {
    sharedByMe.mockResolvedValue(SHARED);
    renderView({ items: ITEMS });
    await screen.findByText("brief.md");
    await userEvent.click(chip("Only me"));
    expect([...rowNames()].sort()).toEqual(["in-my-cloud.md", "synced.md"]);
    await userEvent.click(chip("All"));
    expect(rowNames()).toHaveLength(5);
    expect(chip("Only me")).toHaveAttribute("aria-pressed", "false");
  });

  it("remembers the toggles across visits, and ignores what it does not recognise", async () => {
    sharedByMe.mockResolvedValue(SHARED);
    const { view } = renderView({ items: ITEMS });
    await screen.findByText("brief.md");
    await userEvent.click(chip("Shared with me"));
    await userEvent.click(chip("Only me"));
    expect(JSON.parse(localStorage.getItem("markie.cloud.sources.v1")!)).toEqual(["with-me", "only-me"]);
    view.unmount();

    localStorage.setItem("markie.cloud.sources.v1", JSON.stringify(["with-me", "public-link", 7]));
    renderView({ items: ITEMS });
    await waitFor(() => expect(rowNames()).toEqual(["from-grace.md"]));
    expect(chip("Shared with me")).toHaveAttribute("aria-pressed", "true");
    expect(chip("Only me")).toHaveAttribute("aria-pressed", "false");
  });

  it("starts on All when the stored choice is unreadable", async () => {
    localStorage.setItem("markie.cloud.sources.v1", "{not json");
    renderView({ items: [synced()] });
    await screen.findByText("synced.md");
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("names the toggles that are on when they leave the list empty", async () => {
    renderView({ items: [synced()] });
    await screen.findByText("synced.md");
    await userEvent.click(chip("Shared with me"));
    expect(screen.getByText("No documents shared with you yet")).toBeInTheDocument();
    expect(screen.getByText("Turn on more of the buttons above, or choose All.")).toBeInTheDocument();

    await userEvent.click(chip("Shared by me"));
    expect(screen.getByText("No documents you've shared or shared with you yet")).toBeInTheDocument();
    // The account is not empty, and the band does not say it is.
    expect(screen.getByText("0 of 1 document")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
  });

  it("says the search found nothing, in the terms of the toggles that are on", async () => {
    localStorage.setItem("markie.cloud.sources.v1", JSON.stringify(["only-me"]));
    renderView({ items: [synced(), sharedWithMe()], query: { search: "grace", format: "all", sort: "default" } });
    expect(await screen.findByText("No documents only you can see match this search")).toBeInTheDocument();
    expect(screen.getByText("Try other words, or turn on more of the buttons above.")).toBeInTheDocument();
  });

  it("says the search found nothing at all when no toggle is on", async () => {
    renderView({ items: [synced()], query: { search: "zzz", format: "all", sort: "default" } });
    expect(await screen.findByText("No documents match this search")).toBeInTheDocument();
    expect(screen.getByText("Try other words or another type.")).toBeInTheDocument();
  });

  it("does not call a toggle empty while the shared list it depends on is still coming", async () => {
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>(() => {}));
    localStorage.setItem("markie.cloud.sources.v1", JSON.stringify(["by-me"]));
    renderView({ items: [sharedWithMe()] });
    expect(screen.getByText("Loading documents you've shared")).toBeInTheDocument();
    expect(screen.queryByText(/No documents/)).not.toBeInTheDocument();
  });

  it("hides the shared list's loading and failure when only Shared with me is on", async () => {
    sharedByMe.mockResolvedValue(null);
    localStorage.setItem("markie.cloud.sources.v1", JSON.stringify(["with-me"]));
    renderView({ items: [sharedWithMe()] });
    await waitFor(() => expect(sharedByMe).toHaveBeenCalled());
    await act(async () => {});
    expect(rowNames()).toEqual(["from-grace.md"]);
    expect(screen.queryByText("Loading documents you've shared")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the documents you've shared")).not.toBeInTheDocument();
  });
});

describe("a row's media note", () => {
  it("says a document's media is still on its way up", async () => {
    renderView({
      items: [synced({ media: { state: "pending", skipped: [] } })],
    });
    expect(await screen.findByText("media pending")).toBeInTheDocument();
  });

  it("names the picture that was too large to sync, and the one whose type will not serve", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "diagram.png", reason: "size" },
              { ref: "clip.mov", reason: "type" },
            ],
          },
        }),
      ],
    });
    expect(
      await screen.findByText("file too large: diagram.png · not uploaded: clip.mov (type)")
    ).toBeInTheDocument();
  });

  it("finds the oversized picture behind a skip of some other kind", async () => {
    // Reading only the first entry meant a reference the viewer would refuse
    // anyway, listed first, hid the one thing worth telling someone about.
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "clip.mov", reason: "type" },
              { ref: "elsewhere.png", reason: "outside" },
              { ref: "diagram.png", reason: "size" },
            ],
          },
        }),
      ],
    });
    // The oversized file is named whatever else is in the list ahead of it,
    // and the other two reasons are named after it in their own order.
    expect(
      await screen.findByText(
        "file too large: diagram.png · not uploaded: elsewhere.png (outside the document's folder) · not uploaded: clip.mov (type)"
      )
    ).toBeInTheDocument();
  });

  it("stays quiet when there is nothing to say", async () => {
    renderView({
      items: [synced({ media: { state: "synced", skipped: [{ ref: "notes.md", reason: "count" }] } })],
    });
    await screen.findByText("synced.md");
    expect(screen.queryByText(/file too large/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not uploaded/)).not.toBeInTheDocument();
  });

  // The server refused the whole link body, which no retry of the same text
  // changes, so the row is settled rather than pending. Saying nothing would
  // leave a document whose pictures never travelled looking exactly like one
  // whose pictures did.
  it("says when the server refused the document's media outright", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [{ ref: "*", reason: "refused", status: 413 }],
          },
        }),
      ],
    });
    expect(await screen.findByText("media refused (413)")).toBeInTheDocument();
  });

  it("puts the refusal ahead of the per-picture notes", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "diagram.png", reason: "size" },
              { ref: "*", reason: "refused", status: 400 },
            ],
          },
        }),
      ],
    });
    expect(
      await screen.findByText("media refused (400) · file too large: diagram.png")
    ).toBeInTheDocument();
  });

  // A picture that stays behind because the document is shared is the one
  // skip the person looking at this page can do something about: move the
  // file in beside the document, and it travels. Saying nothing left them
  // with a document that renders here and not for the people they sent it to.
  it("names the first picture that was left behind for sitting outside the document's folder", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "clip.mov", reason: "type" },
              { ref: "../notes/board.png", reason: "outside" },
              { ref: "../notes/plan.png", reason: "outside" },
            ],
          },
        }),
      ],
    });
    expect(
      await screen.findByText(
        "not uploaded: ../notes/board.png (outside the document's folder) · not uploaded: clip.mov (type)"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/plan\.png/)).not.toBeInTheDocument();
  });

  // After the rename fix a `type` skip is a file Markie draws locally and the
  // reader of the synced copy does not get, which is worth exactly as much
  // explaining as one that sits outside the folder. Before that it only ever
  // meant a reference the local viewer would refuse too, which is why it used
  // to stay quiet.
  it("names the first picture whose type does not match the name it is stored under", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "logo.gif", reason: "type" },
              { ref: "favicon.ico", reason: "type" },
            ],
          },
        }),
      ],
    });
    expect(await screen.findByText("not uploaded: logo.gif (type)")).toBeInTheDocument();
    expect(screen.queryByText(/favicon\.ico/)).not.toBeInTheDocument();
  });

  it("orders the notes: refused, then size, then outside, then type", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "synced",
            skipped: [
              { ref: "logo.gif", reason: "type" },
              { ref: "../notes/board.png", reason: "outside" },
              { ref: "diagram.png", reason: "size" },
              { ref: "*", reason: "refused", status: 400 },
            ],
          },
        }),
      ],
    });
    expect(
      await screen.findByText(
        "media refused (400) · file too large: diagram.png · not uploaded: ../notes/board.png (outside the document's folder) · not uploaded: logo.gif (type)"
      )
    ).toBeInTheDocument();
  });

  it("puts the oversized picture first and the one outside the folder after it", async () => {
    renderView({
      items: [
        synced({
          media: {
            state: "pending",
            skipped: [
              { ref: "../notes/board.png", reason: "outside" },
              { ref: "diagram.png", reason: "size" },
            ],
          },
        }),
      ],
    });
    expect(
      await screen.findByText(
        "media pending · file too large: diagram.png · not uploaded: ../notes/board.png (outside the document's folder)"
      )
    ).toBeInTheDocument();
  });
});

describe("the Cloud page's header band", () => {
  it("condenses an empty legacy list beside snapshots without claiming the entire cloud is empty", async () => {
    renderView({ alongsideSnapshots: true });
    expect(await screen.findByText("No synced or shared files yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "File sync & sharing" })).toBeInTheDocument();
    expect(document.querySelector("[data-cloud-list]")).toBeNull();
    expect(screen.queryByRole("group", { name: "Show documents" })).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in your cloud yet")).not.toBeInTheDocument();
  });

  it("keeps sync/share rows, toggles, controls and media notes beside snapshots", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    const { onManage } = renderView({ alongsideSnapshots: true, items: [synced({ media: { state: "pending", skipped: [] } })] });
    await screen.findByText("brief.md");
    expect([...rowNames()].sort()).toEqual(["brief.md", "synced.md"]);
    expect(screen.getByText("media pending")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Show documents" })).toBeInTheDocument();
    await userEvent.click(screen.getByTitle("Manage who can access brief.md"));
    expect(onManage).toHaveBeenCalledExactlyOnceWith("d1", "brief.md");
    await userEvent.click(chip("Shared by me"));
    expect(rowNames()).toEqual(["brief.md"]);
  });

  it("preserves pending and failed shared-list recovery beside snapshots", async () => {
    let settle: (docs: SharedByMeDoc[] | null) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[] | null>((resolve) => { settle = resolve; }));
    renderView({ alongsideSnapshots: true });
    expect(screen.getByText("Checking file sync and sharing…")).toBeInTheDocument();
    expect(screen.getByText("Loading documents you've shared")).toBeInTheDocument();
    settle(null);
    expect(await screen.findByText("Some synced or shared files didn't load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    sharedByMe.mockResolvedValue([doc()]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
  });

  it("distinguishes filtered legacy results from an empty account beside snapshots", async () => {
    renderView({ alongsideSnapshots: true, items: [synced()], query: { search: "unmatched", format: "all", sort: "default" } });
    expect(await screen.findByText("No synced or shared files match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No synced or shared files yet.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-cloud-list]")).toBeNull();
  });

  it("does not call the cloud empty while a list is still on its way", async () => {
    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    renderView();

    // Counting nothing is not the same as knowing there is nothing.
    expect(screen.getByText("Checking your cloud…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in your cloud yet")).not.toBeInTheDocument();

    settle([]);
    expect(await screen.findByText("Nothing in the cloud yet")).toBeInTheDocument();
  });

  it("does not call the cloud empty when a list failed to load", async () => {
    sharedByMe.mockResolvedValue(null);
    renderView();

    expect(await screen.findByText("Some of your cloud didn't load")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in your cloud yet")).not.toBeInTheDocument();
  });

  it("does not call the cloud empty when the main listing failed", async () => {
    // The account's own documents are the half that did not load. "Shared by
    // me" answering with nothing says nothing about them.
    sharedByMe.mockResolvedValue([]);
    renderView({
      cloudError: "Couldn't reach the server, so your cloud documents may be out of date.",
    });

    expect(await screen.findByText("Some of your cloud didn't load")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in your cloud yet")).not.toBeInTheDocument();
  });

  it("counts every document once, a shared one of mine included", async () => {
    sharedByMe.mockResolvedValue([doc({ id: "c1" }), doc({ id: "d2", name: "plan.md" })]);
    renderView({ items: [synced(), cloudOnly(), sharedWithMe()] });
    expect(await screen.findByText("4 documents")).toBeInTheDocument();
  });
});

describe("documents I have shared", () => {
  it("counts the people on each one and dates it", async () => {
    sharedByMe.mockResolvedValue([
      doc({ memberCount: 2, pendingCount: 1, updated_at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    ]);
    renderView();
    expect(await screen.findByText("Shared with 2 · 1 invited")).toBeInTheDocument();
    expect(within(rowFor("brief.md")!).getByText("3h")).toBeInTheDocument();
  });

  it("opens the share dialog from the row's Manage button", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    const { onManage } = renderView();
    await userEvent.click(await screen.findByTitle("Manage who can access brief.md"));
    expect(onManage).toHaveBeenCalledExactlyOnceWith("d1", "brief.md");
  });

  it("opens the document itself when this device has the file", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    // Matched by cloud id, not by name: the file on this device may have been
    // renamed since it was shared. Nobody has vouched for this copy's owner,
    // so the server's row stands for it, and opens the file on disk.
    const { onOpenPath, onManage } = renderView({
      items: [synced({ name: "renamed.md", path: "/notes/brief.md", cloudId: "d1", owned: null })],
    });
    await userEvent.click(await screen.findByText("brief.md"));
    expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("/notes/brief.md");
    expect(onManage).not.toHaveBeenCalled();
  });

  it("does nothing on a row whose document is not on this device", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    const { onOpenPath } = renderView();
    await userEvent.click(await screen.findByText("brief.md"));
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("distinguishes a failed request from an empty account, and retries", async () => {
    // null is the client's "the request failed" answer.
    sharedByMe.mockResolvedValue(null);
    renderView();
    expect(
      await screen.findByText("Couldn't load the documents you've shared")
    ).toBeInTheDocument();
    const before = sharedByMe.mock.calls.length;

    sharedByMe.mockResolvedValue([doc()]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
    await waitFor(() => expect(sharedByMe.mock.calls.length).toBeGreaterThan(before));
  });

  it("refetches when the page is told something changed", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    const { view } = renderView({ refreshKey: 0 });
    await screen.findByText("brief.md");
    sharedByMe.mockResolvedValue([doc({ id: "d2", name: "second.md" })]);
    view.rerender(
      <CloudView
        items={[]}
        loading={false}
        renderRow={(i) => <div key={i.name}>{i.name}</div>}
        signedIn
        accountId="user-a"
        onManage={vi.fn()}
        onOpenPath={vi.fn()}
        cloudError={null}
        refreshKey={1}
      />
    );
    expect(await screen.findByText("second.md")).toBeInTheDocument();
  });
});

describe("changing accounts under an open panel", () => {
  it("drops the last account's documents before the next one's arrive", async () => {
    // A is signed in with a list on screen. A signs out, B signs in, and B's
    // request has not answered yet. A's document names must not be sitting
    // there in the meantime, clickable, under B's account.
    sharedByMe.mockResolvedValue([doc({ name: "alice-brief.md" })]);
    const view = render(<CloudView {...props()} />);
    expect(await screen.findByText("alice-brief.md")).toBeInTheDocument();

    view.rerender(
      <CloudView {...props({ signedIn: false, accountId: null, refreshKey: 1 })} />
    );
    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();

    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    view.rerender(
      <CloudView {...props({ signedIn: true, accountId: "user-b", refreshKey: 2 })} />
    );
    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();
    expect(screen.getByText("Checking your cloud…")).toBeInTheDocument();

    settle([doc({ id: "d9", name: "bob-plan.md" })]);
    expect(await screen.findByText("bob-plan.md")).toBeInTheDocument();
    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();
  });

  it("drops them when the account is replaced without ever being signed out", async () => {
    // A's token expired and B signed in over it: signedIn never flips, but
    // the account did. A's names, people counts and Manage controls must be
    // gone in the same render B arrives in, not after A's list has been drawn
    // once more under B, and not only if B's request ever answers.
    sharedByMe.mockResolvedValue([doc({ name: "alice-brief.md", memberCount: 2 })]);
    const view = render(<CloudView {...props({ accountId: "user-a" })} />);
    expect(await screen.findByText("alice-brief.md")).toBeInTheDocument();
    expect(screen.getByText(/Shared with 2/)).toBeInTheDocument();
    expect(screen.getByTitle("Manage who can access alice-brief.md")).toBeInTheDocument();

    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    view.rerender(<CloudView {...props({ accountId: "user-b" })} />);

    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();
    expect(screen.queryByText(/Shared with 2/)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Manage who can access alice-brief.md")).not.toBeInTheDocument();
    expect(screen.getByText("Checking your cloud…")).toBeInTheDocument();

    settle([doc({ id: "d9", name: "bob-plan.md" })]);
    expect(await screen.findByText("bob-plan.md")).toBeInTheDocument();
    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();
  });

  it("keeps the list in place through an ordinary refresh", async () => {
    // Only a change of account blanks it. A membership change bumps refreshKey
    // too, and blanking the list every time would make the page flicker.
    sharedByMe.mockResolvedValue([doc()]);
    const view = render(<CloudView {...props()} />);
    expect(await screen.findByText("brief.md")).toBeInTheDocument();

    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    view.rerender(<CloudView {...props({ refreshKey: 1 })} />);
    expect(screen.getByText("brief.md")).toBeInTheDocument();
    settle([doc()]);
  });
});

describe("when the cloud cannot answer", () => {
  it("waits for the snapshot before deciding anybody is signed out", () => {
    // Library starts every mount with signedIn false and corrects it when the
    // IPC answer lands. Reading that gap as "signed out" told a signed-in user
    // to sign in, every time they opened the panel.
    renderView({ loading: true, signedIn: false });
    expect(screen.getByText("Loading your cloud documents")).toBeInTheDocument();
    expect(screen.queryByText("Sign in to see your cloud")).not.toBeInTheDocument();
  });

  it("asks a signed-out user to sign in and makes no request", () => {
    renderView({ signedIn: false, items: [synced()] });
    expect(screen.getByText("Sign in to see your cloud")).toBeInTheDocument();
    expect(document.querySelector("[data-cloud-list]")).toBeNull();
    expect(screen.queryByRole("group", { name: "Show documents" })).not.toBeInTheDocument();
    expect(sharedByMe).not.toHaveBeenCalled();
  });

  it("says why the list may be short, beside the rows it does have", async () => {
    renderView({
      items: [synced()],
      cloudError: "Couldn't reach the server, so your cloud documents may be out of date.",
    });
    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument();
    expect(rowNames()).toEqual(["synced.md"]);
  });

  it("says so to a signed-out user too, who cannot see any rows at all", () => {
    renderView({
      signedIn: false,
      cloudError: "Your sign-in has expired. Sign in again to see your cloud documents.",
    });
    expect(screen.getByText(/Your sign-in has expired/)).toBeInTheDocument();
  });
});
