import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, LibraryItem } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  sharesClient: { sharedByMe: async () => [] },
}));

import { Library } from "./library";

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
    // The server confirmed these are the account's own; the shared fixtures
    // below say otherwise for themselves.
    owned: true,
    ...o,
  }) as LibraryItem;

function renderLibrary(
  items: LibraryItem[],
  {
    signedIn = true,
    overrides = {},
    props = {},
    tab = "recent",
  }: {
    signedIn?: boolean;
    overrides?: Partial<ElectronAPI>;
    props?: Partial<React.ComponentProps<typeof Library>>;
    // The Library is Recent and Projects, one flat row. Cases below say which
    // one they are about rather than depending on a default.
    tab?: "recent" | "projects" | "default";
  } = {}
) {
  if (tab !== "default") localStorage.setItem("markie.libtab.v4", tab);
  const api = installBridge({
    libraryState: vi.fn(async () => ({ signedIn, items })),
    wsRoots: vi.fn(async () => ["/Users/test/Markie"]),
    ...overrides,
  });
  const handlers = {
    onClose: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenFile: vi.fn(),
    onAddPaths: vi.fn(),
    onSignIn: vi.fn(),
    onManageShare: vi.fn(),
    onSyncChanged: vi.fn(),
  };
  const view = render(
    <Library
      view="library"
      {...handlers}
      activePath={null}
      accountId={null}
      refreshKey={0}
      {...props}
    />
  );
  return { api, view, ...handlers };
}

const rowFor = async (name: string) => {
  const label = await screen.findByText(name);
  return label.closest("div.group") as HTMLElement;
};

const openMenu = async (name: string) => {
  const row = await rowFor(name);
  await userEvent.click(within(row).getByRole("button", { name: "Actions" }));
  return row;
};

beforeEach(() => {
  localStorage.clear();
});

// Every state a row can be in gets its own badge. A state that borrows
// another's badge is a state the user cannot tell apart.
const CASES: Array<[LibraryItem["state"], string, Partial<LibraryItem>]> = [
  ["local-only", "Local", {}],
  ["synced", "Synced", { cloudId: "c1" }],
  ["unpushed", "Not backed up", { cloudId: "c2" }],
  ["paused", "Paused", { cloudId: "c3" }],
  ["conflict", "Conflict", { cloudId: "c4" }],
  ["behind", "Update", { cloudId: "c5", remoteVersion: 3 }],
];

const cloudOnly = (o: Partial<LibraryItem> = {}) =>
  item({
    kind: "cloud-only",
    path: null,
    cloudId: "c6",
    state: "cloud-only",
    name: "cloud-only.md",
    exists: false,
    ...o,
  } as Partial<LibraryItem>);

describe("Library rows", () => {

  it.each(CASES)("renders %s as a %s row", async (state, badge, extra) => {
    renderLibrary([item({ state, name: `${state}.md`, ...extra })]);
    const row = await rowFor(`${state}.md`);
    expect(within(row).getByText(badge)).toBeInTheDocument();
  });

  it("keeps the six on-device row kinds visually distinct", async () => {
    renderLibrary(
      CASES.map(([state, , extra]) => item({ state, name: `${state}.md`, ...extra }))
    );
    await screen.findByText("local-only.md");
    // Each rendered row must carry its own badge, asserted against the DOM
    // rather than against the list this test declared.
    for (const [state, badge] of CASES) {
      const row = await rowFor(`${state}.md`);
      expect(within(row).getByText(badge)).toBeInTheDocument();
    }
  });

  it("says a tracked file is gone rather than opening nothing", async () => {
    const { onOpenPath } = renderLibrary([
      item({ name: "gone.md", exists: false }),
    ]);
    const row = await rowFor("gone.md");
    expect(within(row).getByText("Missing on disk")).toBeInTheDocument();
    await userEvent.click(row);
    // A row that points at nothing must not pretend it opened something.
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("opens a file that is there", async () => {
    const { onOpenPath } = renderLibrary([item({ name: "here.md" })]);
    await userEvent.click(await rowFor("here.md"));
    expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("/notes/one.md");
  });
});

describe("Library notices", () => {
  it("shows a failed action as an error and lets go of the menu", async () => {
    const docResolve = vi.fn(async () => ({ error: "Server refused the pull." }));
    const { onSyncChanged } = renderLibrary(
      [item({ name: "behind.md", state: "behind", cloudId: "c5" })],
      { overrides: { docResolve } as Partial<ElectronAPI> }
    );
    const row = await openMenu("behind.md");
    await userEvent.click(within(row).getByRole("button", { name: "Pull latest" }));

    const notice = await screen.findByText("Server refused the pull.");
    expect(notice).toBeInTheDocument();
    // Errors are red; an acknowledgement is not.
    expect(notice).toHaveClass("text-[var(--status-red)]");
    // A failed action must never leave the row menu stuck open.
    await waitFor(() =>
      expect(
        within(row).queryByRole("button", { name: "Pull latest" })
      ).not.toBeInTheDocument()
    );
    expect(onSyncChanged).toHaveBeenCalled();
  });

  it("shows a thrown action the same way", async () => {
    const docResolve = vi.fn(async () => {
      throw new Error("Couldn't reach the server.");
    });
    renderLibrary([item({ name: "behind.md", state: "behind", cloudId: "c5" })], {
      overrides: { docResolve } as unknown as Partial<ElectronAPI>,
    });
    const row = await openMenu("behind.md");
    await userEvent.click(within(row).getByRole("button", { name: "Pull latest" }));
    expect(await screen.findByText("Couldn't reach the server.")).toHaveClass(
      "text-[var(--status-red)]"
    );
  });

  it("rewrites an errno at the front of a message into a sentence", async () => {
    const docResolve = vi.fn(async () => ({
      error: "ENOENT: no such file or directory, open '/notes/behind.md'",
    }));
    renderLibrary([item({ name: "behind.md", state: "behind", cloudId: "c5" })], {
      overrides: { docResolve } as Partial<ElectronAPI>,
    });
    const row = await openMenu("behind.md");
    await userEvent.click(within(row).getByRole("button", { name: "Pull latest" }));
    expect(
      await screen.findByText(/That file isn't there anymore\./)
    ).toBeInTheDocument();
  });

  it("shows a library that could not be read as an error, not an empty shelf", async () => {
    renderLibrary([], {
      overrides: {
        libraryState: vi.fn(async () => ({
          signedIn: false,
          items: [],
          error: "database is locked",
        })),
      } as Partial<ElectronAPI>,
    });
    expect(
      await screen.findByText(/Library couldn't load: database is locked/)
    ).toBeInTheDocument();
  });
});

describe("Library signed-out state", () => {
  it("offers sign-in below the list", async () => {
    const { onSignIn } = renderLibrary([item()], { signedIn: false });
    const prompt = await screen.findByRole("button", { name: /Sign in to sync these files/ });
    await userEvent.click(prompt);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("hides the sign-in prompt once signed in", async () => {
    renderLibrary([item()], { signedIn: true });
    await screen.findByText("one.md");
    expect(
      screen.queryByRole("button", { name: /Sign in to sync these files/ })
    ).not.toBeInTheDocument();
  });

  it("keeps cloud actions out of a signed-out menu", async () => {
    renderLibrary([item({ name: "solo.md" })], { signedIn: false });
    const row = await openMenu("solo.md");
    expect(within(row).getByRole("button", { name: "Copy path" })).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Sync to cloud" })
    ).not.toBeInTheDocument();
  });

  it("points an empty library at the workspace it just set up", async () => {
    const { onOpenFile } = renderLibrary([], { signedIn: false });
    expect(await screen.findByText("Workspace ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });
});

describe("which tab opens", () => {
  it("opens on Recent, which is what the Library is for", async () => {
    renderLibrary([item()], { tab: "default" });
    const recent = await screen.findByRole("button", { name: "Recent" });
    expect(recent.className).toContain("bg-accent");
  });

  it("moves someone who was on Folders onto Projects, the same slot renamed", async () => {
    // That tab listed real directories. It holds Markie's own structure now,
    // but it is still the not-Recent tab, and someone who picked not-Recent
    // must not be dropped back on Recent.
    localStorage.setItem("markie.libtab.v3", "folders");
    renderLibrary([item()], { tab: "default" });
    const projects = await screen.findByRole("button", { name: "Projects" });
    expect(projects.className).toContain("bg-accent");
  });

  it("moves either half of the old Files tab onto Projects", async () => {
    localStorage.setItem("markie.libtab.v2", "files");
    localStorage.setItem("markie.filesview.v1", "projects");
    renderLibrary([item()], { tab: "default" });
    const projects = await screen.findByRole("button", { name: "Projects" });
    expect(projects.className).toContain("bg-accent");
  });

  it("remembers the tab under the new key once the user picks one", async () => {
    renderLibrary([item()], { tab: "default" });
    await userEvent.click(await screen.findByRole("button", { name: "Projects" }));
    expect(localStorage.getItem("markie.libtab.v4")).toBe("projects");
  });
});

describe("the Library's one row of tabs", () => {
  it("has exactly two sections and nothing nested under them", async () => {
    // The panel used to spend two of its first three rows on navigation: you
    // picked Files, then picked Projects inside it. Projects is one tab now,
    // and the second row is gone rather than restyled.
    renderLibrary([item()], { tab: "recent" });
    const tabs = await screen.findByRole("group", { name: "Library sections" });
    expect(within(tabs).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Recent",
      "Projects",
    ]);
    expect(screen.queryByRole("group", { name: /how to group/i })).not.toBeInTheDocument();
    expect(document.querySelector("[data-files-subview]")).toBeNull();
    expect(document.querySelector("[data-markie-projects-tree]")).toBeNull();
  });

  it("shows Projects with one search over project and file names", async () => {
    renderLibrary([item()], { tab: "projects" });
    expect(await screen.findByRole("button", { name: "Projects" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Search projects and files")).toBeInTheDocument()
    );
  });

  it("no longer offers to make a real directory on disk", async () => {
    // This tab used to be the filesystem, so it had New folder, rename and
    // delete. Projects is Markie's own structure over files that never move,
    // so there is nothing here that writes to the disk layout.
    renderLibrary([item()], { tab: "projects" });
    await screen.findByRole("button", { name: "Projects" });
    expect(screen.queryByRole("button", { name: /new folder/i })).toBeNull();
  });

  it("offers the filter on Recent, where the list it filters is", async () => {
    renderLibrary([item()], { tab: "recent" });
    expect(await screen.findByLabelText("Filter documents")).toBeInTheDocument();
  });
});

// The Library is this device's shelf. Everything the cloud holds, including the
// copies of these same files, is the Cloud page's job now, so a document is
// never listed twice with two different answers to "where is it".
describe("the Library is what is on this device", () => {
  const MIXED = [
    item({ name: "here.md", path: "/notes/here.md" }),
    cloudOnly({ name: "in-my-cloud.md" }),
    item({
      kind: "shared",
      name: "from-grace.md",
      path: null,
      cloudId: "c7",
      state: "cloud-only",
      exists: false,
      shared: true,
      sharedBy: "Grace",
    } as Partial<LibraryItem>),
  ];

  it("leaves the cloud-only and shared groups to the Cloud page", async () => {
    renderLibrary(MIXED);
    expect(await screen.findByText("On this device")).toBeInTheDocument();
    expect(screen.queryByText("In your cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared with me")).not.toBeInTheDocument();
    expect(screen.queryByText("in-my-cloud.md")).not.toBeInTheDocument();
    expect(screen.queryByText("from-grace.md")).not.toBeInTheDocument();
  });

  it("counts this device in the band and nothing else", async () => {
    renderLibrary(MIXED);
    // Three documents in the account, one of them here.
    expect(await screen.findByText("1 on this device")).toBeInTheDocument();
    expect(screen.getByText("All clear")).toBeInTheDocument();
  });
});

describe("the Cloud page inside the panel", () => {
  const cloudProps = { props: { view: "cloud" as const } };

  it("titles the panel Cloud", async () => {
    renderLibrary([], cloudProps);
    expect(await screen.findByText("Cloud")).toBeInTheDocument();
  });

  it("renders a cloud-only row with its badge and the Download action", async () => {
    renderLibrary([cloudOnly()], cloudProps);
    const row = await rowFor("cloud-only.md");
    expect(within(row).getByText("Cloud")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Actions" }));
    expect(within(row).getByRole("button", { name: /Download/ })).toBeInTheDocument();
  });

  it("offers my document whose file is gone the way back, in the menu and on the row", async () => {
    // Deleted from disk, still in the cloud. The row says the file is missing
    // and offers Download, the same recovery a document that was never here
    // gets; before this, it opened nothing and offered nothing.
    const gone = item({
      name: "gone.md",
      path: "/notes/gone.md",
      state: "synced",
      cloudId: "c8",
      exists: false,
    });
    const { api, onOpenPath } = renderLibrary([gone], cloudProps);
    const row = await rowFor("gone.md");
    expect(within(row).getByText("Missing on disk")).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: "Actions" }));
    await userEvent.click(within(row).getByRole("button", { name: /Download/ }));
    expect(api.docPull).toHaveBeenCalledExactlyOnceWith({
      cloudId: "c8",
      suggestedName: "gone.md",
    });

    await userEvent.click(row);
    expect(api.docPull).toHaveBeenCalledTimes(2);
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("offers nothing for a gone file nobody has vouched for", async () => {
    // Offline, with no confirmed role: the cloud may or may not hold this for
    // whoever is signed in, so the row says it is missing and no more.
    const { api } = renderLibrary(
      [item({ name: "gone.md", path: "/notes/gone.md", state: "synced", cloudId: "c8", exists: false, owned: null })],
      cloudProps
    );
    // Not in any Cloud section, so it is found through the Library instead.
    expect(await screen.findByText("Nothing synced from this device yet")).toBeInTheDocument();
    expect(screen.queryByText("gone.md")).not.toBeInTheDocument();
    expect(api.docPull).not.toHaveBeenCalled();
  });

  it("renders a shared row remembered offline without the sharer's name", async () => {
    // The server is away, so the role is what this account remembers and the
    // name of who shared it is not known. The row still says what it can.
    renderLibrary(
      [
        item({
          name: "theirs.md",
          path: "/notes/theirs.md",
          state: "synced",
          cloudId: "c9",
          owned: false,
          shared: true,
          role: "viewer",
          sharedBy: null,
        }),
      ],
      cloudProps
    );
    const row = await rowFor("theirs.md");
    expect(within(row).getByText("Shared")).toBeInTheDocument();
    expect(within(row).getByText("Shared with you · Viewer")).toBeInTheDocument();
  });

  it("renders a shared row with its own badge and who shared it", async () => {
    renderLibrary(
      [
        item({
          kind: "shared",
          name: "shared.md",
          path: null,
          cloudId: "c7",
          state: "cloud-only",
          exists: false,
          owned: false,
          shared: true,
          sharedBy: "Grace",
          role: "editor",
        } as Partial<LibraryItem>),
      ],
      cloudProps
    );
    const row = await rowFor("shared.md");
    // Shared outranks the sync badge: "Cloud" would say nothing about access.
    expect(within(row).getByText("Shared")).toBeInTheDocument();
    expect(within(row).queryByText("Cloud")).not.toBeInTheDocument();
    expect(within(row).getByText("Shared by Grace · Editor")).toBeInTheDocument();
  });
});

describe("the cloud half failing to load", () => {
  const failing = (items: LibraryItem[]) => ({
    overrides: {
      libraryState: vi.fn(async () => ({
        signedIn: true,
        items,
        cloudError: "Your sign-in has expired. Sign in again to see your cloud documents.",
      })),
    },
  });

  it("says so on the Cloud page, beside the rows it does have", async () => {
    const items = [item({ name: "here.md", path: "/notes/here.md", state: "synced", cloudId: "c1" })];
    renderLibrary(items, { ...failing(items), props: { view: "cloud" } });
    expect(await screen.findByText("here.md")).toBeInTheDocument();
    expect(await screen.findByText(/Your sign-in has expired/)).toBeInTheDocument();
  });

  it("does not repeat the cloud's problem under the Library", async () => {
    const items = [item({ name: "here.md", path: "/notes/here.md" })];
    renderLibrary(items, failing(items));
    expect(await screen.findByText("here.md")).toBeInTheDocument();
    expect(screen.queryByText(/Your sign-in has expired/)).not.toBeInTheDocument();
  });
});
