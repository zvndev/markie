import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsListing } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import { FilesView } from "./files-view";

const ROOT = "/Users/test/Markie";

const listing = (o: Partial<WsListing> = {}): WsListing => ({
  folders: [],
  files: [],
  ...o,
});

const TREE: Record<string, WsListing> = {
  [ROOT]: listing({
    folders: [{ name: "notes", path: `${ROOT}/notes` }],
    files: [{ name: "readme.md", path: `${ROOT}/readme.md`, ext: ".md" }],
  }),
  [`${ROOT}/notes`]: listing({
    files: [{ name: "todo.md", path: `${ROOT}/notes/todo.md`, ext: ".md" }],
  }),
};

function renderFiles(
  bridge: Parameters<typeof installBridge>[0] = {},
  props: Partial<React.ComponentProps<typeof FilesView>> = {}
) {
  const api = installBridge({
    wsRoots: vi.fn(async () => [ROOT]),
    wsDefaultPath: vi.fn(async () => ROOT),
    wsListDir: vi.fn(async (p: string) => TREE[p] ?? listing()),
    ...bridge,
  });
  const onOpenPath = vi.fn();
  const onNotice = vi.fn();
  const view = render(
    <FilesView
      activePath={null}
      refreshKey={0}
      onOpenPath={onOpenPath}
      onNotice={onNotice}
      {...props}
    />
  );
  return { ...view, api, onOpenPath, onNotice };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  });
});

describe("FilesView", () => {
  it("shows a loading skeleton before the roots arrive", () => {
    installBridge({ wsRoots: vi.fn(() => new Promise<string[]>(() => {})) });
    render(
      <FilesView activePath={null} refreshKey={0} onOpenPath={vi.fn()} onNotice={vi.fn()} />
    );
    expect(screen.getByText("Loading files")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("says the desktop app is required with no workspace bridge", () => {
    installBridge({ wsRoots: undefined as never });
    render(
      <FilesView activePath={null} refreshKey={0} onOpenPath={vi.fn()} onNotice={vi.fn()} />
    );
    expect(screen.getByText("Desktop app required")).toBeInTheDocument();
  });

  it("lists the root's folders and files, expanded", async () => {
    renderFiles();
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    // MARKIE is the root header, marked as the default workspace
    expect(screen.getByText("Markie")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    // a nested folder stays closed until asked for
    expect(screen.queryByText("todo.md")).toBeNull();
  });

  it("opens a file on click and expands a folder", async () => {
    const user = userEvent.setup();
    const { onOpenPath } = renderFiles();

    await user.click(await screen.findByText("readme.md"));
    expect(onOpenPath).toHaveBeenCalledWith(`${ROOT}/readme.md`);

    await user.click(screen.getByText("notes"));
    expect(await screen.findByText("todo.md")).toBeInTheDocument();
  });

  it("offers to create the default workspace when there are no roots", async () => {
    const user = userEvent.setup();
    const wsCreateDefault = vi.fn(async () => ({ error: "Permission denied." }));
    const { onNotice } = renderFiles({
      wsRoots: vi.fn(async () => []),
      wsCreateDefault,
    });

    expect(
      await screen.findByText(/Markie could not set up its default workspace/)
    ).toBeInTheDocument();
    // the bootstrap already tried once and reported why
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Permission denied."));

    await user.click(screen.getByRole("button", { name: /^Create / }));
    expect(wsCreateDefault).toHaveBeenCalledTimes(2);
  });

  it("adds a folder the user picks", async () => {
    const user = userEvent.setup();
    const wsAddRoot = vi.fn(async () => ({ ok: true, path: "/Other" }));
    const wsRoots = vi
      .fn()
      .mockResolvedValueOnce([ROOT])
      .mockResolvedValue([ROOT, "/Other"]);
    renderFiles({ wsAddRoot, wsRoots });

    await user.click(await screen.findByRole("button", { name: "+ Add folder" }));
    expect(wsAddRoot).toHaveBeenCalled();
    expect(await screen.findByText("Other")).toBeInTheDocument();
  });

  it("reports a failed folder pick without changing the tree", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderFiles({
      wsAddRoot: vi.fn(async () => ({ error: "That folder is unreadable." })),
    });
    await user.click(await screen.findByRole("button", { name: "+ Add folder" }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("That folder is unreadable.")
    );
  });

  it("creates a new file and opens it", async () => {
    const user = userEvent.setup();
    const wsNewFile = vi.fn(async () => ({ ok: true, path: `${ROOT}/idea.md` }));
    const { onOpenPath, api } = renderFiles({ wsNewFile });

    await user.click(await screen.findByText("notes"));
    await user.click(screen.getAllByRole("button", { name: "Actions" })[0]);
    await user.click(screen.getByRole("button", { name: "New file" }));

    const input = screen.getByPlaceholderText("untitled.md");
    await user.type(input, "idea.md{Enter}");

    expect(wsNewFile).toHaveBeenCalledWith(`${ROOT}/notes`, "idea.md");
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledWith(`${ROOT}/idea.md`));
    expect(api.wsListDir).toHaveBeenCalledWith(`${ROOT}/notes`);
  });

  it("commits a create exactly once when Enter also blurs the input", async () => {
    const user = userEvent.setup();
    const wsMkdir = vi.fn(async () => ({ ok: true }));
    renderFiles({ wsMkdir });

    await user.click(await screen.findByTitle("New folder"));
    await user.type(screen.getByPlaceholderText("New folder"), "drafts{Enter}");
    expect(wsMkdir).toHaveBeenCalledTimes(1);
    expect(wsMkdir).toHaveBeenCalledWith(ROOT, "drafts");
  });

  it("does not rename on Escape, even though it blurs the input", async () => {
    const user = userEvent.setup();
    const wsRename = vi.fn(async () => ({ ok: true }));
    renderFiles({ wsRename });

    await screen.findByText("readme.md");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Rename" }));

    const input = screen.getByDisplayValue("readme.md");
    await user.clear(input);
    await user.type(input, "notes.md{Escape}");
    expect(wsRename).not.toHaveBeenCalled();
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });

  it("renames a file on Enter", async () => {
    const user = userEvent.setup();
    const wsRename = vi.fn(async () => ({ ok: true }));
    renderFiles({ wsRename });

    await screen.findByText("readme.md");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("readme.md");
    await user.clear(input);
    await user.type(input, "notes.md{Enter}");

    expect(wsRename).toHaveBeenCalledWith(`${ROOT}/readme.md`, "notes.md");
  });

  it("reports a rename the main process refused", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderFiles({
      wsRename: vi.fn(async () => ({ error: "A file with that name exists." })),
    });

    await screen.findByText("readme.md");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("readme.md");
    await user.type(input, "x{Enter}");

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("A file with that name exists.")
    );
  });

  it("trashes a file and reloads its folder", async () => {
    const user = userEvent.setup();
    const wsTrash = vi.fn(async () => ({ ok: true }));
    const { api } = renderFiles({ wsTrash });

    await screen.findByText("readme.md");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Trash" }));

    expect(wsTrash).toHaveBeenCalledWith(`${ROOT}/readme.md`);
    await waitFor(() => expect(api.wsListDir).toHaveBeenCalledWith(ROOT));
  });

  it("reveals a file in Finder and copies its path", async () => {
    const user = userEvent.setup();
    const { api, onNotice } = renderFiles();

    await screen.findByText("readme.md");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(api.wsReveal).toHaveBeenCalledWith(`${ROOT}/readme.md`);

    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Path copied."));
    await expect(navigator.clipboard.readText()).resolves.toBe(`${ROOT}/readme.md`);
  });

  it("highlights the file that is currently open", async () => {
    renderFiles({}, { activePath: `${ROOT}/readme.md` });
    const row = (await screen.findByText("readme.md")).closest("div")!;
    expect(row.classList.contains("bg-accent")).toBe(true);
  });

  it("invites the user to start when a root is empty", async () => {
    renderFiles({ wsListDir: vi.fn(async () => listing()) });
    expect(await screen.findByText("Markie is ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });

  it("moves a file into a folder on drop", async () => {
    const user = userEvent.setup();
    const wsMove = vi.fn(async () => ({ ok: true }));
    renderFiles({ wsMove });

    const file = (await screen.findByText("readme.md")).closest("[draggable]")!;
    const folder = screen.getByText("notes").closest("[draggable]")!;
    const data = { getData: () => "", setData: () => {}, effectAllowed: "" };

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragStart(file, { dataTransfer: data });
    fireEvent.dragOver(folder, { dataTransfer: data });
    fireEvent.drop(folder, { dataTransfer: data });

    await waitFor(() =>
      expect(wsMove).toHaveBeenCalledWith(`${ROOT}/readme.md`, `${ROOT}/notes`)
    );
    void user;
  });

  it("closes the actions menu when another row's menu opens", async () => {
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText("readme.md");

    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    expect(screen.getByRole("button", { name: "Trash" })).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    expect(screen.queryByRole("button", { name: "Trash" })).toBeNull();
  });

  it("shows the folder-only actions on a folder row", async () => {
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText("notes");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[0]);
    const menu = screen.getByRole("button", { name: "Trash" }).parentElement!;
    expect(within(menu).getByRole("button", { name: "New file" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });
});
