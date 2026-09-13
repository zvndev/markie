import { render, screen, waitFor, within } from "@testing-library/react";
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
    renderRow: (i: LibraryItem) => <div key={i.name}>{i.name}</div>,
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

const section = (id: string) =>
  document.querySelector(`[data-cloud-section="${id}"]`) as HTMLElement | null;

const sectionNames = (id: string) =>
  [...(section(id)?.querySelectorAll("[data-testid='row']") ?? [])].map(
    (el) => el.textContent
  );

beforeEach(() => {
  localStorage.clear();
  sharedByMe.mockReset();
  sharedByMe.mockResolvedValue([]);
});

describe("the Cloud page's four sections", () => {
  const MIXED = [
    // On this device and unknown to the cloud: belongs to the Library, not here.
    item({ name: "local.md", path: "/notes/local.md", state: "local-only" }),
    synced(),
    cloudOnly(),
    sharedWithMe(),
  ];

  it("puts each kind of document under the heading that explains it", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: MIXED });
    await screen.findByText("brief.md");

    expect(sectionNames("synced")).toEqual(["synced.md"]);
    expect(sectionNames("cloud")).toEqual(["in-my-cloud.md"]);
    expect(sectionNames("with-me")).toEqual(["from-grace.md"]);
    expect(within(section("by-me")!).getByText("brief.md")).toBeInTheDocument();
    // A file the cloud has never heard of has nothing to say on this page.
    expect(screen.queryByText("local.md")).not.toBeInTheDocument();
  });

  it("hands cloud-only rows to the Library's renderer, which carries Download", () => {
    const { renderRow } = renderView({ items: MIXED });
    const rendered = renderRow.mock.calls.map(([i]) => i.name);
    expect(rendered).toContain("in-my-cloud.md");
    expect(rendered).not.toContain("local.md");
  });

  it("files someone else's document under theirs, copy on this device or not", async () => {
    // Ownership decides the section. A local copy only decides what the row
    // can do, so listing it as one of mine would say the wrong thing about who
    // the document belongs to.
    renderView({
      items: [
        synced({
          name: "theirs.md",
          cloudId: "c9",
          owned: false,
          shared: true,
          sharedBy: "Grace",
        }),
      ],
    });
    await waitFor(() => expect(sectionNames("with-me")).toEqual(["theirs.md"]));
    expect(sectionNames("synced")).toEqual([]);
  });

  it("files my document under In your cloud once its file is gone from this device", async () => {
    // The cloud copy is the only one left. "Synced from this device" would be
    // describing a file that is not here; the row belongs where the way back
    // is, beside the other documents this device does not hold.
    renderView({ items: [synced({ name: "gone.md", exists: false })] });
    await waitFor(() => expect(sectionNames("cloud")).toEqual(["gone.md"]));
    expect(sectionNames("synced")).toEqual([]);
    expect(await screen.findByText("1 in your cloud")).toBeInTheDocument();
  });

  it("keeps a document remembered as shared under Shared with me while the server is away", async () => {
    // The list did not load. The row carries the role this account remembers
    // and no name for who shared it, and it still has a section.
    renderView({
      items: [
        synced({
          name: "theirs.md",
          cloudId: "c9",
          owned: false,
          shared: true,
          role: "editor",
          sharedBy: null,
        }),
      ],
      cloudError: "Couldn't reach the server, so your cloud documents may be out of date.",
    });
    await waitFor(() => expect(sectionNames("with-me")).toEqual(["theirs.md"]));
    expect(sectionNames("synced")).toEqual([]);
    expect(sectionNames("cloud")).toEqual([]);
  });

  it("leaves a row nobody has vouched for out of both ownership sections", async () => {
    // The server did not answer, so this row carries no owner. It is still in
    // the Library's list of what is on this device; it just cannot claim a
    // section here until somebody says whose it is.
    renderView({ items: [synced({ name: "unknown.md", owned: null })] });
    await waitFor(() => expect(section("synced")).not.toBeNull());
    expect(sectionNames("synced")).toEqual([]);
    expect(sectionNames("with-me")).toEqual([]);
  });

  it("keeps every section on the page, so its shape never depends on the account", async () => {
    renderView({ items: [synced()] });
    await waitFor(() => expect(section("by-me")).not.toBeNull());
    for (const id of ["synced", "cloud", "with-me", "by-me"]) {
      expect(section(id)).not.toBeNull();
    }
    // And each empty one says what it would hold, rather than sitting blank.
    expect(screen.getByText("Nothing in your cloud yet")).toBeInTheDocument();
    expect(
      screen.getByText("Nobody has shared a document with you yet")
    ).toBeInTheDocument();
    expect(await screen.findByText("You haven't shared a document yet")).toBeInTheDocument();
  });

  it("says the cloud is empty rather than leaving a blank page", async () => {
    renderView();
    expect(await screen.findByText("Nothing in the cloud yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing synced from this device yet")).toBeInTheDocument();
    expect(await screen.findByText("You haven't shared a document yet")).toBeInTheDocument();
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
  it("does not call the cloud empty while a list is still on its way", async () => {
    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    renderView();

    // Counting nothing is not the same as knowing there is nothing.
    expect(screen.getByText("Checking your cloud…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();

    settle([]);
    expect(await screen.findByText("Nothing in the cloud yet")).toBeInTheDocument();
  });

  it("does not call the cloud empty when a list failed to load", async () => {
    sharedByMe.mockResolvedValue(null);
    renderView();

    expect(await screen.findByText("Some of your cloud didn't load")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the cloud yet")).not.toBeInTheDocument();
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
  });


  it("counts every section, skipping the ones that hold nothing", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: [synced(), sharedWithMe()] });
    expect(
      await screen.findByText("1 synced · 1 shared with you · 1 shared by you")
    ).toBeInTheDocument();
  });

  it("names all four when all four have something", async () => {
    sharedByMe.mockResolvedValue([doc(), doc({ id: "d2", name: "plan.md" })]);
    renderView({ items: [synced(), cloudOnly(), sharedWithMe()] });
    expect(
      await screen.findByText("1 synced · 1 in your cloud · 1 shared with you · 2 shared by you")
    ).toBeInTheDocument();
  });
});

describe("collapsing a section", () => {
  it("hides its rows and remembers the choice", async () => {
    const { view } = renderView({ items: [synced()] });
    await waitFor(() => expect(section("synced")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /Synced from this device/ }));
    expect(sectionNames("synced")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("markie.cloud.open.v1")!).synced).toBe(false);

    view.unmount();
    renderView({ items: [synced()] });
    await waitFor(() => expect(section("synced")).not.toBeNull());
    expect(sectionNames("synced")).toEqual([]);
  });
});

describe("the Shared panel's tab becoming a section", () => {
  const shared = [sharedWithMe()];

  it("opens the list someone was last living in and collapses the other", async () => {
    localStorage.setItem("markie.sharedtab.v1", "by-me");
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: shared });

    expect(await screen.findByText("brief.md")).toBeInTheDocument();
    expect(sectionNames("with-me")).toEqual([]);
    expect(localStorage.getItem("markie.cloudtab.v1")).toBe("by-me");
  });

  it("collapses the other one, whichever tab they were on", async () => {
    localStorage.setItem("markie.sharedtab.v1", "with-me");
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: shared });

    // The band counts it either way, so this waits for the fetch rather than
    // for a row that is deliberately not on screen.
    expect(await screen.findByText(/1 shared by you/)).toBeInTheDocument();
    expect(sectionNames("with-me")).toEqual(["from-grace.md"]);
    expect(screen.queryByText("brief.md")).not.toBeInTheDocument();
  });

  it("gives a new user all four sections open", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    renderView({ items: shared });

    expect(await screen.findByText("brief.md")).toBeInTheDocument();
    expect(sectionNames("with-me")).toEqual(["from-grace.md"]);
    expect(localStorage.getItem("markie.cloudtab.v1")).toBe("with-me");
  });

  it("reads the old key once and never again", async () => {
    localStorage.setItem("markie.sharedtab.v1", "by-me");
    const { view } = renderView({ items: shared });
    await waitFor(() => expect(section("with-me")).not.toBeNull());
    view.unmount();

    // The Shared panel is gone, but a stale key must not be able to fold a
    // section away a second time after the user has opened it.
    localStorage.setItem("markie.cloud.open.v1", JSON.stringify({ "with-me": true }));
    renderView({ items: shared });
    await waitFor(() => expect(sectionNames("with-me")).toEqual(["from-grace.md"]));
  });
});

describe("documents I have shared", () => {
  it("counts the people on each one and dates it", async () => {
    sharedByMe.mockResolvedValue([
      doc({ memberCount: 2, pendingCount: 1, updated_at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    ]);
    renderView();
    expect(await screen.findByText("2 people · 1 invited · 3h")).toBeInTheDocument();
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
    // renamed since it was shared.
    const { onOpenPath, onManage } = renderView({
      items: [synced({ name: "renamed.md", path: "/notes/brief.md", cloudId: "d1" })],
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
    expect(screen.getByText(/2 people/)).toBeInTheDocument();
    expect(screen.getByTitle("Manage who can access alice-brief.md")).toBeInTheDocument();

    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    view.rerender(<CloudView {...props({ accountId: "user-b" })} />);

    expect(screen.queryByText("alice-brief.md")).not.toBeInTheDocument();
    expect(screen.queryByText(/2 people/)).not.toBeInTheDocument();
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
    expect(section("synced")).toBeNull();
    expect(sharedByMe).not.toHaveBeenCalled();
  });

  it("says why the list may be short, beside the rows it does have", async () => {
    renderView({
      items: [synced()],
      cloudError: "Couldn't reach the server, so your cloud documents may be out of date.",
    });
    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument();
    expect(sectionNames("synced")).toEqual(["synced.md"]);
  });

  it("says so to a signed-out user too, who cannot see any rows at all", () => {
    renderView({
      signedIn: false,
      cloudError: "Your sign-in has expired. Sign in again to see your cloud documents.",
    });
    expect(screen.getByText(/Your sign-in has expired/)).toBeInTheDocument();
  });
});
