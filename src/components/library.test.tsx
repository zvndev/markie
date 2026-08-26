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
    // Files is the default tab as of 0.5.0. The cases below are about the
    // Recent list, so they say so rather than depending on a default.
    tab?: "recent" | "files" | "default";
  } = {}
) {
  if (tab !== "default") localStorage.setItem("markie.libtab.v2", tab);
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

describe("Library rows", () => {
  // Every state a row can be in gets its own badge. A state that borrows
  // another's badge is a state the user cannot tell apart.
  const CASES: Array<[LibraryItem["state"], string, Partial<LibraryItem>]> = [
    ["local-only", "Local", {}],
    ["synced", "Synced", { cloudId: "c1" }],
    ["unpushed", "Not backed up", { cloudId: "c2" }],
    ["paused", "Paused", { cloudId: "c3" }],
    ["conflict", "Conflict", { cloudId: "c4" }],
    ["behind", "Update", { cloudId: "c5", remoteVersion: 3 }],
    ["cloud-only", "Cloud", { path: null, cloudId: "c6" }],
  ];

  it.each(CASES)("renders %s as a %s row", async (state, badge, extra) => {
    renderLibrary([item({ state, name: `${state}.md`, ...extra })]);
    const row = await rowFor(`${state}.md`);
    expect(within(row).getByText(badge)).toBeInTheDocument();
  });

  it("renders a shared row with its own badge and who shared it", async () => {
    renderLibrary([
      item({
        kind: "shared",
        name: "shared.md",
        path: null,
        cloudId: "c7",
        state: "cloud-only",
        shared: true,
        sharedBy: "Grace",
        role: "editor",
      } as Partial<LibraryItem>),
    ]);
    const row = await rowFor("shared.md");
    // Shared outranks the sync badge: "Cloud" would say nothing about access.
    expect(within(row).getByText("Shared")).toBeInTheDocument();
    expect(within(row).queryByText("Cloud")).not.toBeInTheDocument();
    expect(within(row).getByText("Shared by Grace · Editor")).toBeInTheDocument();
  });

  it("keeps the eight row kinds visually distinct", async () => {
    renderLibrary([
      ...CASES.map(([state, , extra]) =>
        item({ state, name: `${state}.md`, ...extra })
      ),
      item({
        name: "shared.md",
        path: null,
        cloudId: "c7",
        state: "cloud-only",
        shared: true,
      } as Partial<LibraryItem>),
    ]);
    await screen.findByText("local-only.md");
    // Each rendered row must carry its own badge — asserted against the DOM,
    // not against the list this test declared.
    for (const [state, badge] of CASES) {
      const row = await rowFor(`${state}.md`);
      expect(within(row).getByText(badge)).toBeInTheDocument();
    }
    const sharedRow = await rowFor("shared.md");
    expect(within(sharedRow).getByText("Shared")).toBeInTheDocument();
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
  it("opens on Files, showing the user's work rather than an empty folder tree", async () => {
    renderLibrary([item()], { tab: "default" });
    const files = await screen.findByRole("button", { name: "files" });
    expect(files.className).toContain("bg-accent");
    // And the Projects grouping, not the workspace folder tree.
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps Recent for someone who explicitly chose it before the flip", async () => {
    localStorage.setItem("markie.libtab.v1", "recent");
    renderLibrary([item()], { tab: "default" });
    const recent = await screen.findByRole("button", { name: "recent" });
    expect(recent.className).toContain("bg-accent");
  });

  it("moves a legacy Files choice straight across", async () => {
    localStorage.setItem("markie.libtab.v1", "files");
    renderLibrary([item()], { tab: "default" });
    const files = await screen.findByRole("button", { name: "files" });
    expect(files.className).toContain("bg-accent");
  });

  it("remembers the tab under the new key once the user picks one", async () => {
    renderLibrary([item()], { tab: "default" });
    await userEvent.click(await screen.findByRole("button", { name: "recent" }));
    expect(localStorage.getItem("markie.libtab.v2")).toBe("recent");
  });
});

describe("the Files tab's two shapes", () => {
  it("keeps the folder tree one click away, with its file operations intact", async () => {
    renderLibrary([item()], { tab: "files" });
    await userEvent.click(await screen.findByRole("button", { name: "Folders" }));
    expect(screen.getByRole("button", { name: "Folders" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // FilesView's own controls are back.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /new folder/i })).toBeInTheDocument()
    );
  });

  it("remembers which shape the user chose", async () => {
    renderLibrary([item()], { tab: "files" });
    await userEvent.click(await screen.findByRole("button", { name: "Folders" }));
    expect(localStorage.getItem("markie.filesview.v1")).toBe("folders");
  });

  it("offers a filter over projects, not only over Recent", async () => {
    renderLibrary([item()], { tab: "files" });
    expect(await screen.findByLabelText("Filter projects")).toBeInTheDocument();
  });
});
