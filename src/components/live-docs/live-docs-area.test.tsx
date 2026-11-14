import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveDocsLocalProject, LiveDocsProjectChange, LiveDocsProjectsApi } from "@/lib/electron";
import { LiveDocsArea, type LiveDocsShell } from "./live-docs-area";

// CodeMirror needs layout jsdom does not have. The area only needs an editor
// that shows the value and reports edits, which a textarea does.
vi.mock("@/components/source-editor", () => ({
  SourceEditor: ({ value, onChange, plainText }: { value: string; onChange: (text: string) => void; plainText?: boolean }) => (
    <textarea aria-label="Editor" data-plain-text={plainText ? "true" : "false"} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const PROJECT: LiveDocsLocalProject = { id: "11111111-1111-4111-8111-111111111111", kind: "local", name: "corner-shop", location: "~/sites/corner-shop", available: true, open: false };

// An in-memory project behind the same API main exposes.
function installProject() {
  const files = new Map<string, string>([
    ["site/pages/index.wd", "# Home\n"],
    ["site/pages/index.skin", "body\n  color: red\n"],
    ["site/pages/index.js", "export const x = 1;\n"],
    ["api/hello.js", "export default () => ({});\n"],
    ["package.json", "{}\n"],
  ]);
  const revision = (text: string) => `rev:${text.length}:${text}`;
  let listener: (change: LiveDocsProjectChange) => void = () => {};
  const folders = () => {
    const out = new Set<string>();
    for (const file of files.keys()) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
    }
    return [...out];
  };
  const api: LiveDocsProjectsApi = {
    list: vi.fn(async () => ({ ok: true as const, projects: [PROJECT] })),
    add: vi.fn(async () => ({ ok: false as const, code: "not-a-project", message: "plain is not a Darkmown project." })),
    remove: vi.fn(async () => ({ ok: true as const })),
    open: vi.fn(async () => ({ ok: true as const, project: { id: PROJECT.id, name: PROJECT.name, location: PROJECT.location, watching: true } })),
    close: vi.fn(async () => ({ ok: true as const })),
    tree: vi.fn(async () => ({
      ok: true as const,
      project: { id: PROJECT.id, name: PROJECT.name, location: PROJECT.location, watching: true },
      entries: [...folders().map((path) => ({ path, kind: "dir" as const })), ...[...files.keys()].map((path) => ({ path, kind: "file" as const }))],
      truncated: false,
    })),
    read: vi.fn(async ({ path }: { path: string }) => {
      const text = files.get(path);
      return text === undefined ? { ok: false as const, code: "missing", message: "That file no longer exists." } : { ok: true as const, file: { path, text, revision: revision(text), size: text.length } };
    }),
    write: vi.fn(async ({ path, text, baseRevision }: { path: string; text: string; baseRevision: string }) => {
      const current = files.get(path);
      if (current === undefined) return { ok: false as const, code: "missing", message: "That file no longer exists." };
      if (revision(current) !== baseRevision) return { ok: false as const, code: "conflict", message: "This file changed on disk since it was opened." };
      files.set(path, text);
      return { ok: true as const, file: { path, revision: revision(text), size: text.length } };
    }),
    onChanged: vi.fn((callback: (change: LiveDocsProjectChange) => void) => {
      listener = callback;
      return () => { listener = () => {}; };
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: "darwin", liveDocsProjects: api };
  const outsideEdit = (path: string, text: string | null) => {
    if (text === null) files.delete(path); else files.set(path, text);
    act(() => listener({ projectId: PROJECT.id, paths: [path], overflow: false, watching: true }));
  };
  return { api, files, outsideEdit, revision };
}

function renderArea() {
  let shell: LiveDocsShell | null = null;
  const view = render(<LiveDocsArea active onShellChange={(next) => { shell = next; }} />);
  return { ...view, shell: () => shell! };
}

async function openProject() {
  fireEvent.click(await screen.findByRole("button", { name: "Open corner-shop" }));
  return screen.findByRole("navigation", { name: "Project files" });
}

async function openFile(tree: HTMLElement, name: string) {
  fireEvent.click(within(tree).getByRole("button", { name }));
  await waitFor(() => expect(screen.getByRole("tab", { name: new RegExp(`^${name.replace(".", "\\.")}`) })).toBeTruthy());
}

const editor = () => screen.getAllByLabelText("Editor").find((element) => !element.closest("[hidden]")) as HTMLTextAreaElement;

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("LiveDocsArea home", () => {
  it("lists the projects main keeps, and says why a folder was not added", async () => {
    const { api } = installProject();
    renderArea();
    expect(await screen.findByRole("button", { name: "Open corner-shop" })).toBeTruthy();
    expect(screen.getByText("~/sites/corner-shop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Project…" }));
    expect(await screen.findByText("plain is not a Darkmown project.")).toBeTruthy();
    expect(api.add).toHaveBeenCalledWith();
  });

  it("says how to start when the list is empty", async () => {
    const { api } = installProject();
    vi.mocked(api.list).mockResolvedValueOnce({ ok: true, projects: [] });
    renderArea();
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("removes a project only after asking, and only from the list", async () => {
    const { api } = installProject();
    renderArea();
    fireEvent.click(await screen.findByRole("button", { name: "Remove corner-shop from Live Docs" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/The folder and its files stay where they are/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: PROJECT.id }));
  });

  it("does not load anything until the area is shown", () => {
    const { api } = installProject();
    render(<LiveDocsArea active={false} />);
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe("LiveDocsArea project", () => {
  it("shows every project file and refers to files only by their path in the project", async () => {
    const { api } = installProject();
    renderArea();
    const tree = await openProject();
    expect(api.open).toHaveBeenCalledWith({ id: PROJECT.id });
    for (const name of ["index.wd", "index.skin", "index.js", "package.json"]) expect(within(tree).getByRole("button", { name })).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "api" }));
    expect(within(tree).getByRole("button", { name: "hello.js" })).toBeTruthy();
    await openFile(tree, "index.skin");
    expect(api.read).toHaveBeenCalledWith({ path: "site/pages/index.skin" });
    expect(editor().value).toBe("body\n  color: red\n");
    expect(editor().dataset.plainText).toBe("true");
  });

  it.each(["index.wd", "index.skin", "index.js"])("edits and saves %s through the shell's Save", async (name) => {
    const { api, files, revision } = installProject();
    const { shell } = renderArea();
    const tree = await openProject();
    await openFile(tree, name);
    const path = `site/pages/${name}`;
    const before = files.get(path)!;
    fireEvent.change(editor(), { target: { value: `${before}// more\n` } });
    expect(screen.getByRole("tab", { name: new RegExp(`${name.replace(".", "\\.")}.*unsaved`) })).toBeTruthy();
    expect(shell().activeDirty).toBe(true);
    act(() => shell().save());
    await waitFor(() => expect(files.get(path)).toBe(`${before}// more\n`));
    expect(api.write).toHaveBeenCalledWith({ path, text: `${before}// more\n`, baseRevision: revision(before) });
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(shell().dirtyCount).toBe(0);
  });

  it("shows an outside edit in a clean open tab, and a new file in the tree", async () => {
    const { outsideEdit } = installProject();
    renderArea();
    const tree = await openProject();
    await openFile(tree, "index.wd");
    outsideEdit("site/pages/index.wd", "# Edited in another editor\n");
    await waitFor(() => expect(editor().value).toBe("# Edited in another editor\n"));
    outsideEdit("site/pages/about.wd", "# About\n");
    expect(await within(tree).findByRole("button", { name: "about.wd" })).toBeTruthy();
  });

  it("asks before an outside edit replaces unsaved changes, and keeps either version on request", async () => {
    const { outsideEdit, files, api, revision } = installProject();
    const { shell } = renderArea();
    const tree = await openProject();
    await openFile(tree, "index.wd");
    fireEvent.change(editor(), { target: { value: "# Mine\n" } });
    outsideEdit("site/pages/index.wd", "# Theirs\n");
    expect(await screen.findByText(/changed outside Markie, and you have unsaved changes/)).toBeTruthy();
    expect(editor().value).toBe("# Mine\n");
    fireEvent.click(screen.getByRole("button", { name: "Keep my version" }));
    act(() => shell().save());
    await waitFor(() => expect(files.get("site/pages/index.wd")).toBe("# Mine\n"));
    expect(api.write).toHaveBeenLastCalledWith({ path: "site/pages/index.wd", text: "# Mine\n", baseRevision: revision("# Theirs\n") });

    fireEvent.change(editor(), { target: { value: "# Mine again\n" } });
    outsideEdit("site/pages/index.wd", "# Theirs again\n");
    fireEvent.click(await screen.findByRole("button", { name: "Reload from disk" }));
    expect(editor().value).toBe("# Theirs again\n");
  });

  it("reports a save refused over an outside edit, and offers the disk version", async () => {
    const { files } = installProject();
    const { shell } = renderArea();
    const tree = await openProject();
    await openFile(tree, "index.wd");
    fireEvent.change(editor(), { target: { value: "# Mine\n" } });
    // Changed on disk with no watcher event, the way a slow or missed event would.
    files.set("site/pages/index.wd", "# Sneaky\n");
    act(() => shell().save());
    expect(await screen.findByText(/changed outside Markie/)).toBeTruthy();
    expect(files.get("site/pages/index.wd")).toBe("# Sneaky\n");
  });

  it("says when an open file was deleted outside Markie, and keeps its text", async () => {
    const { outsideEdit } = installProject();
    renderArea();
    const tree = await openProject();
    await openFile(tree, "index.js");
    outsideEdit("site/pages/index.js", null);
    expect(await screen.findByText(/was deleted or renamed outside Markie/)).toBeTruthy();
    expect(editor().value).toBe("export const x = 1;\n");
  });

  it("asks before closing a tab or the project with unsaved changes", async () => {
    const { api } = installProject();
    renderArea();
    const tree = await openProject();
    await openFile(tree, "index.wd");
    fireEvent.change(editor(), { target: { value: "# Unsaved\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close index.wd" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: /index\.wd/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Live Docs" }));
    expect(within(screen.getByRole("dialog")).getByText(/1 file has unsaved changes/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and close" }));
    await waitFor(() => expect(api.close).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Open corner-shop" })).toBeTruthy();
  });

  it("keeps the window open while files are unsaved, and says why", async () => {
    installProject();
    const { shell } = renderArea();
    const tree = await openProject();
    await openFile(tree, "index.wd");
    expect(shell().prepareClose()).toBe(true);
    fireEvent.change(editor(), { target: { value: "# Unsaved\n" } });
    let allowed = true;
    act(() => { allowed = shell().prepareClose(); });
    expect(allowed).toBe(false);
    expect(screen.getByText(/Markie stayed open: 1 Live Docs file has unsaved changes/)).toBeTruthy();
  });

  it("explains a file Markie will not edit", async () => {
    const { api } = installProject();
    renderArea();
    const tree = await openProject();
    vi.mocked(api.read).mockResolvedValueOnce({ ok: false, code: "binary", message: "Markie edits text files only. This one is binary." });
    fireEvent.click(within(tree).getByRole("button", { name: "package.json" }));
    expect(await screen.findByText("package.json: Markie edits text files only. This one is binary.")).toBeTruthy();
  });

  it("shows the private build's locked answer, which carries error instead of message", async () => {
    const { api } = installProject();
    vi.mocked(api.open).mockResolvedValueOnce({ ok: false, code: "private-release-locked", error: "Private release authorization is required." });
    renderArea();
    fireEvent.click(await screen.findByRole("button", { name: "Open corner-shop" }));
    expect(await screen.findByText("Private release authorization is required.")).toBeTruthy();
  });
});
