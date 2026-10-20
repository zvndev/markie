import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, editDocumentText, restoreDocumentText, serializeDocumentSession, type DocumentSession } from "@/lib/document-session";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
import { loadThemeStore, MARKIE_DARK, MARKIE_LIGHT, saveThemeStore, THEME_APPLIED_EVENT } from "@/lib/theme";
import { DarkmownDocumentEditor } from "./darkmown-document-editor";

vi.mock("@/lib/darkmown/preview", () => ({ compileDarkmownPreview: vi.fn() }));
const compile = vi.mocked(compileDarkmownPreview);
const SOURCE = "# Counter\r\n\r\n:state count = 0\r\n\r\n:button Add -> count++\r\n";
function frame() { return screen.queryByTitle("Darkmown document preview") as HTMLIFrameElement | null; }
function deferred<T>() { let resolve!: (result: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { compile.mockReset().mockImplementation(async (source, trusted) => ({ srcDoc: `<p>${trusted ? "trusted" : "inactive"}:${source}</p>`, warnings: [] })); });
afterEach(cleanup);

describe("Darkmown source and isolated preview", () => {
  it("shares one real toolbar, preserves source bytes and trusts only an opaque local-state frame", async () => {
    const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
    const before = await serializeDocumentSession(session), onChange = vi.fn();
    render(<DarkmownDocumentEditor session={session} onChange={onChange} onFlushReady={vi.fn()} />);
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(document.querySelectorAll(".markie-doc-toolbar")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rich view" })).not.toBeInTheDocument();
    expect(screen.getByText("Local state only. No network, files, accounts or persistent storage.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    expect(frame()).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame()).not.toHaveAttribute("allow");
    const trustedFrame = frame();
    fireEvent.click(screen.getByRole("button", { name: "Reset state" }));
    await waitFor(() => expect(frame()).not.toBe(trustedFrame));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke trust" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(onChange).not.toHaveBeenCalled();
    expect(await serializeDocumentSession(session)).toEqual(before);
  });

  it("follows Markie theme changes without rebuilding the document, replacing its frame or losing trust", async () => {
    const originalTheme = loadThemeStore();
    saveThemeStore({ ...originalTheme, activeId: MARKIE_LIGHT.id });
    try {
      const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
      render(<DarkmownDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
      await waitFor(() => expect(frame()).toHaveStyle({ colorScheme: "light" }));
      fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
      await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
      const runningFrame = frame(), compilationCount = compile.mock.calls.length;
      const postTheme = vi.spyOn(runningFrame!.contentWindow!, "postMessage");
      act(() => window.dispatchEvent(new CustomEvent(THEME_APPLIED_EVENT, { detail: { tokens: MARKIE_DARK.tokens } })));
      expect(frame()).toBe(runningFrame);
      expect(frame()).toHaveStyle({ colorScheme: "dark" });
      expect(frame()).toHaveAttribute("sandbox", "allow-scripts");
      expect(compile).toHaveBeenCalledTimes(compilationCount);
      expect(postTheme).toHaveBeenLastCalledWith({ type: "markie:preview-theme", theme: "dark" }, "*");
      act(() => window.dispatchEvent(new CustomEvent(THEME_APPLIED_EVENT, { detail: { editorTheme: "light" } })));
      expect(frame()).toBe(runningFrame);
      expect(frame()).toHaveStyle({ colorScheme: "light" });
      expect(compile).toHaveBeenCalledTimes(compilationCount);
      expect(postTheme).toHaveBeenLastCalledWith({ type: "markie:preview-theme", theme: "light" }, "*");
      postTheme.mockClear();
      fireEvent.load(runningFrame!);
      expect(postTheme).toHaveBeenCalledExactlyOnceWith({ type: "markie:preview-theme", theme: "light" }, "*");
    } finally {
      saveThemeStore(originalTheme);
    }
  });

  it("opens on the applied theme tone even when the saved preset disagrees", async () => {
    const originalTheme = loadThemeStore();
    saveThemeStore({ ...originalTheme, activeId: MARKIE_LIGHT.id });
    document.documentElement.dataset.themeTone = "dark";
    try {
      const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
      render(<DarkmownDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
      await waitFor(() => expect(frame()).toHaveStyle({ colorScheme: "dark" }));
      expect(compile.mock.calls.at(-1)?.[2]?.colorScheme).toBe("dark");
    } finally {
      delete document.documentElement.dataset.themeTone;
      saveThemeStore(originalTheme);
    }
  });

  it("rebuilds only an inactive static preview for theme changes without granting scripts", async () => {
    const originalTheme = loadThemeStore();
    saveThemeStore({ ...originalTheme, activeId: MARKIE_LIGHT.id });
    try {
      const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
      render(<DarkmownDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
      await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
      const inactiveFrame = frame();
      expect(compile.mock.calls.at(-1)?.[2]?.colorScheme).toBe("light");
      act(() => window.dispatchEvent(new CustomEvent(THEME_APPLIED_EVENT, { detail: { editorTheme: "dark" } })));
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(frame()).not.toBe(inactiveFrame);
      expect(frame()).toHaveAttribute("sandbox", "");
      expect(compile.mock.calls.at(-1)?.[2]?.colorScheme).toBe("dark");
      expect(screen.getByRole("button", { name: "Trust this document" })).toBeInTheDocument();
    } finally {
      saveThemeStore(originalTheme);
    }
  });

  it("revokes trust on edits and undo, retains source history through native View modes and opens source for Find", async () => {
    let latest: DocumentSession = { ...await createDocumentSession("darkmown"), text: SOURCE };
    let commands: DocumentCommandTarget | null = null;
    const register = (target: DocumentCommandTarget | null) => { commands = target; };
    function Host() {
      const [session, setSession] = useState(latest);
      const update = (next: DocumentSession) => { latest = next; setSession(next); };
      return <DarkmownDocumentEditor session={session} onChange={(text) => update(editDocumentText(latest, text))} onRestoreText={(text) => update(restoreDocumentText(latest, text))} onFlushReady={vi.fn()} onCommandsReady={register} />;
    }
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Document text" });
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    const trustedFrame = frame();
    fireEvent.change(field, { target: { value: `${SOURCE}\nChanged` } });
    expect(trustedFrame).not.toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect((commands as DocumentCommandTarget | null)?.enabledCommands).toContain("view-darkmown-preview");
    act(() => commands!.execute("view-darkmown-preview"));
    expect(screen.queryByRole("textbox", { name: "Document text" })).not.toBeInTheDocument();
    act(() => commands!.execute("find"));
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    expect(screen.getByRole("search", { name: "Find document text" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    act(() => commands!.execute("view-darkmown-preview"));
    expect(screen.queryByRole("textbox", { name: "Document text" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    fireEvent.change(screen.getByRole("textbox", { name: "Find document text" }), { target: { value: "Counter" } });
    fireEvent.click(screen.getByRole("button", { name: "Find next" }));
    expect((field as HTMLTextAreaElement).value.slice((field as HTMLTextAreaElement).selectionStart, (field as HTMLTextAreaElement).selectionEnd)).toBe("Counter");
    act(() => commands!.execute("view-darkmown-source"));
    expect(frame()).toBeNull();
    act(() => commands!.execute("undo"));
    expect(latest.text).toBe(SOURCE);
    act(() => commands!.execute("view-darkmown-split"));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(screen.getByRole("button", { name: "Trust this document" })).toBeInTheDocument();
    expect(document.querySelectorAll(".markie-doc-toolbar")).toHaveLength(1);
  });

  it("disposes the running frame on blocked/inactive state or document switch and never reuses its trust", async () => {
    const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
    const props = { session, onChange: vi.fn(), onFlushReady: vi.fn() };
    const view = render(<DarkmownDocumentEditor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    const trustedFrame = frame();
    view.rerender(<DarkmownDocumentEditor {...props} readOnly />);
    expect(trustedFrame).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trust this document" })).toBeDisabled();
    view.rerender(<DarkmownDocumentEditor {...props} />);
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", "allow-scripts"));
    view.rerender(<DarkmownDocumentEditor {...props} active={false} />);
    expect(frame()).toBeNull();
    view.rerender(<DarkmownDocumentEditor {...props} session={{ ...session, epoch: "another-document" }} />);
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
  });

  it("reveals authored source for preview-mode formatting, undo, redo and paragraph style edits", async () => {
    let latest: DocumentSession = { ...await createDocumentSession("darkmown"), text: SOURCE };
    let commands: DocumentCommandTarget | null = null;
    function Host() {
      const [session, setSession] = useState(latest);
      const update = (next: DocumentSession) => { latest = next; setSession(next); };
      return <DarkmownDocumentEditor session={session} onChange={(text) => update(editDocumentText(latest, text))} onRestoreText={(text) => update(restoreDocumentText(latest, text))} onFlushReady={vi.fn()} onCommandsReady={(value) => { commands = value; }} />;
    }
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Document text" }) as HTMLTextAreaElement;
    field.setSelectionRange(2, 9);
    act(() => commands!.execute("view-darkmown-preview"));
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    expect(latest.text).toBe(SOURCE.replace("Counter", "**Counter**"));
    act(() => commands!.execute("view-darkmown-preview"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    expect(latest.text).toBe(SOURCE);
    act(() => commands!.execute("view-darkmown-preview"));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    expect(latest.text).toBe(SOURCE.replace("Counter", "**Counter**"));
    field.setSelectionRange(0, 0);
    act(() => commands!.execute("view-darkmown-preview"));
    fireEvent.change(screen.getByRole("combobox", { name: "Paragraph style" }), { target: { value: "h2" } });
    expect(screen.getByRole("textbox", { name: "Document text" })).toBe(field);
    expect(latest.text).toMatch(/^## \*\*Counter\*\*/);
  });

  it("ignores stale async success and errors after source or trust changes", async () => {
    const pending = deferred<{ srcDoc: string; warnings: string[] }>();
    compile.mockImplementationOnce(() => pending.promise);
    const session = { ...await createDocumentSession("darkmown"), text: "old" };
    const props = { onChange: vi.fn(), onFlushReady: vi.fn() };
    const view = render(<DarkmownDocumentEditor {...props} session={session} />);
    const firstSignal = compile.mock.calls[0][2]?.signal;
    view.rerender(<DarkmownDocumentEditor {...props} session={{ ...session, text: "current", generation: 1 }} />);
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(frame()?.srcdoc).toContain("current"));
    await act(async () => pending.resolve({ srcDoc: "STALE", warnings: ["OLD"] }));
    expect(frame()?.srcdoc).toContain("current");
    expect(screen.queryByText("OLD")).not.toBeInTheDocument();
    const trusted = deferred<{ srcDoc: string; warnings: string[] }>();
    compile.mockImplementationOnce(() => trusted.promise);
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    expect(frame()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke trust" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    await act(async () => trusted.reject(new Error("STALE ERROR")));
    expect(screen.queryByText("STALE ERROR")).not.toBeInTheDocument();
    expect(frame()).toHaveAttribute("sandbox", "");
  });

  it("withholds commands and trust while blocked and rejects retained commands inside an inert scope", async () => {
    const session = { ...await createDocumentSession("darkmown"), text: SOURCE };
    let commands: DocumentCommandTarget | null = null;
    const props = { session, onChange: vi.fn(), onFlushReady: vi.fn(), onCommandsReady: (value: DocumentCommandTarget | null) => { commands = value; } };
    const view = render(<div inert><DarkmownDocumentEditor {...props} /></div>);
    const retained = commands!;
    act(() => retained.execute("view-darkmown-source"));
    fireEvent.click(screen.getByRole("button", { name: "Trust this document" }));
    await waitFor(() => expect(frame()).toHaveAttribute("sandbox", ""));
    expect(document.querySelector(".docs-darkmown-mode-split")).toBeInTheDocument();
    view.rerender(<DarkmownDocumentEditor {...props} readOnly />);
    expect((commands as DocumentCommandTarget | null)?.enabledCommands).toEqual([]);
    act(() => commands!.execute("view-darkmown-source"));
    expect(screen.getByRole("button", { name: "Trust this document" })).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("shows current compilation errors and warnings without losing editable source", async () => {
    const session = { ...await createDocumentSession("darkmown"), text: "broken" };
    compile.mockRejectedValueOnce(new Error("Line 2: missing directive value"));
    render(<DarkmownDocumentEditor session={session} onChange={vi.fn()} onFlushReady={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Line 2: missing directive value");
    expect(screen.getByRole("textbox", { name: "Document text" })).toHaveValue("broken");
    compile.mockResolvedValueOnce({ srcDoc: "repaired", warnings: ["External requests are disabled."] });
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(frame()?.srcdoc).toBe("repaired"));
    expect(screen.getByRole("status")).toHaveTextContent("External requests are disabled.");
  });
});
