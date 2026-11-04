import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { RichView } from "@/components/rich-view";
import { installBridge } from "@/test/mock-bridge";
import { setAssetDocPath } from "@/lib/asset-url";
import { TICKET_CLOSE_REFRESH_MIN_MS, type CollabConfig, type CollabTicketAnswer } from "@/lib/collab";

// The loader stands between a shared document and its editor; a chunk that
// fails to load must not take the editor with it. Only the failure is faked.
const loader = vi.hoisted(() => ({
  failed: false,
  // When set, the live session runs over this in-memory room instead of a
  // socket: `seed` fills the room before the first sync, as a server would.
  room: null as null | { seed?: (doc: import("yjs").Doc) => void },
  // Every fake provider made, newest last, so a test can read its params.
  providers: [] as Array<{
    createdWith: Record<string, string>;
    params: Record<string, string>;
    connects: number;
    drop: (code: number) => void;
  }>,
}));
vi.mock("@/lib/collab-loader", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/collab-loader")>();
  const runtime = await import("@/lib/collab-runtime");
  const { Awareness } = await import("y-protocols/awareness");
  class FakeProvider {
    synced = false;
    shouldConnect = false;
    connects = 0;
    params: Record<string, string>;
    createdWith: Record<string, string>;
    awareness: InstanceType<typeof Awareness>;
    #doc: import("yjs").Doc;
    #handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    constructor(_url: string, _room: string, doc: import("yjs").Doc, opts?: { params?: Record<string, string> }) {
      this.#doc = doc;
      this.awareness = new Awareness(doc);
      this.params = opts?.params ?? {};
      this.createdWith = { ...this.params };
      loader.providers.push(this);
    }
    drop(code: number) {
      this.#emit("connection-close", { code });
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
      this.#handlers.get(event)!.add(fn);
    }
    off(event: string, fn: (...args: unknown[]) => void) {
      this.#handlers.get(event)?.delete(fn);
    }
    #emit(event: string, ...args: unknown[]) {
      for (const fn of this.#handlers.get(event) ?? []) fn(...args);
    }
    connect() {
      this.shouldConnect = true;
      this.connects += 1;
      setTimeout(() => {
        loader.room?.seed?.(this.#doc);
        this.synced = true;
        this.#emit("status", { status: "connected" });
        this.#emit("sync", true);
      }, 10);
    }
    disconnect() {}
    destroy() {
      this.awareness.destroy();
    }
  }
  const fakeRuntime = { ...runtime, WebsocketProvider: FakeProvider } as unknown as typeof runtime;
  return {
    ...real,
    useCollabRuntime: (wanted: boolean) =>
      wanted && loader.failed
        ? { runtime: null, failed: true }
        : wanted && loader.room
          ? { runtime: fakeRuntime, failed: false }
          : real.useCollabRuntime(wanted),
  };
});

// Opens a document in the real rich pane, runs one edit through the real
// editor, and returns the markdown the component emitted. This is the wiring
// test: the layer modules have their own suites, but only this proves the
// component actually routes a save through them.
async function editAndSerialize(
  value: string,
  edit: (editor: Editor) => void
): Promise<string> {
  const onChange = vi.fn();
  let editor: Editor | null = null;
  render(
    <RichView
      value={value}
      onChange={onChange}
      onEditorReady={(e) => {
        if (e) editor = e;
      }}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  const ready = editor as unknown as Editor;
  edit(ready);
  await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
}

const appendToFirstBlock = (text: string) => (editor: Editor) => {
  editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize - 1, text);
};

describe("RichView serialization", () => {
  it("leaves every line the user did not touch byte-identical", async () => {
    const value = [
      "First paragraph is wrapped",
      "by hand across two lines.",
      "",
      "Second paragraph is also",
      "wrapped by hand.",
      "",
      "| left | right |",
      "| :--- | ---: |",
      "| 1 | 2 |",
      "",
      "- [x] a tight task list",
      "- [ ] that serializes loose",
      "",
      "Closing paragraph wrapped",
      "across lines as well.",
      "",
    ].join("\n");

    const out = await editAndSerialize(value, appendToFirstBlock(" EDITED"));

    const before = value.split("\n");
    const after = out.split("\n");
    // The edited block collapsed its two wrapped lines into the one the
    // serializer produced; everything below it is untouched.
    expect(after[0]).toBe("First paragraph is wrapped by hand across two lines. EDITED");
    expect(after.slice(1)).toEqual(before.slice(2));
  });

  it("restores front matter, HTML comments, and raw HTML around an edit", async () => {
    const value = [
      "---",
      "title: Held aside",
      "markie:",
      "  project: Markie",
      "---",
      "Opening paragraph.",
      "",
      "<!-- a comment the editor would delete -->",
      "",
      "<div class=\"note\">",
      "<b>raw html</b>",
      "</div>",
      "",
      "Closing line.",
      "",
    ].join("\n");

    const out = await editAndSerialize(value, appendToFirstBlock(" EDITED"));

    expect(out).toContain("---\ntitle: Held aside\nmarkie:\n  project: Markie\n---\n");
    expect(out).toContain("<!-- a comment the editor would delete -->");
    expect(out).toContain("<div class=\"note\">\n<b>raw html</b>\n</div>");
    expect(out).toContain("Opening paragraph. EDITED");
    expect(out).not.toContain("markie-hold-");
  });

  it("draws an SVG data: picture and saves it back as the picture, not as escaped text", async () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>')}`;
    const value = `Opening paragraph.\n\n![Bottles opened per month](${svg})\n\nClosing line.\n`;
    const onChange = vi.fn();
    let editor: Editor | null = null;
    const { container } = render(
      <RichView value={value} onChange={onChange} onEditorReady={(e) => { if (e) editor = e; }} />
    );
    await waitFor(() => expect(editor).not.toBeNull());
    const img = container.querySelector<HTMLImageElement>(".ProseMirror img");
    expect(img?.getAttribute("src")).toBe(svg);
    expect(img?.getAttribute("alt")).toBe("Bottles opened per month");
    expect(container.querySelector(".ProseMirror")?.textContent).not.toContain("data:image");

    appendToFirstBlock(" EDITED")(editor as unknown as Editor);
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    const out = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(out).toBe(value.replace("Opening paragraph.", "Opening paragraph. EDITED"));
  });
});

describe("RichView document links", () => {
  it.each([{}, { metaKey: true }, { ctrlKey: true }])("hands one real editor link activation to the desktop browser, not two: %o", async (init) => {
    const openExternal = vi.fn(async () => {}), browserWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    installBridge({ openExternal });
    let editor: Editor | null = null;
    const view = render(<RichView value="[A web page](https://example.com/post)" onChange={vi.fn()} onEditorReady={(value) => { editor = value; }} />);
    await waitFor(() => expect(editor).not.toBeNull());
    const ready = editor as unknown as Editor, link = view.container.querySelector("a")!;
    // ProseMirror calls its actual handleClick plugin chain from mouseup,
    // before React receives the later DOM click. Pin both stages in order.
    const mouseup = new MouseEvent("mouseup", { button: 0, cancelable: true, ...init });
    Object.defineProperty(mouseup, "target", { value: link });
    ready.view.someProp("handleClick", (handler) => handler(ready.view, 1, mouseup));
    fireEvent.click(link, init);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/post");
    expect(browserWindow).not.toHaveBeenCalled(); browserWindow.mockRestore();
  });

  it("retains TipTap's browser-native link behavior without the desktop bridge", async () => {
    const browserWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    let editor: Editor | null = null;
    const view = render(<RichView value="[A web page](https://example.com/post)" onChange={vi.fn()} onEditorReady={(value) => { editor = value; }} />);
    await waitFor(() => expect(editor).not.toBeNull());
    const ready = editor as unknown as Editor, link = view.container.querySelector("a")!;
    const mouseup = new MouseEvent("mouseup", { button: 0 }); Object.defineProperty(mouseup, "target", { value: link });
    ready.view.someProp("handleClick", (handler) => handler(ready.view, 1, mouseup));
    expect(browserWindow).toHaveBeenCalledExactlyOnceWith("https://example.com/post", "_blank"); browserWindow.mockRestore();
  });

  it("keeps the doc-link mark on its anchor through an edit, once main has answered", async () => {
    const resolveDocLinks = vi.fn(async () => [{ href: "plan.md", kind: "none" as const }]);
    installBridge({ resolveDocLinks });
    setAssetDocPath("/Users/me/report/notes.md");
    try {
      let editor: Editor | null = null;
      const { container } = render(
        <RichView
          value="[the plan](plan.md)"
          onChange={() => {}}
          onEditorReady={(e) => {
            if (e) editor = e;
          }}
        />
      );
      await waitFor(() => expect(editor).not.toBeNull());

      // main answered "none" for this link; the effect in rich-view.tsx marks
      // the anchor once resolveDocLinks resolves and the debounce settles.
      await waitFor(() => {
        const a = container.querySelector('a[href="plan.md"]');
        expect(a?.getAttribute("data-doc-link")).toBe("none");
      });

      appendToFirstBlock(" more")(editor as unknown as Editor);

      // TipTap redraws the paragraph on every edit; the mark view's DOM node
      // for the link is reused rather than recreated, so the attribute
      // markDocLinks wrote directly onto it (not part of the mark's own
      // model) survives the redraw. This pins that against a TipTap upgrade.
      await waitFor(
        () => {
          const a = container.querySelector('a[href="plan.md"]');
          expect(a?.getAttribute("data-doc-link")).toBe("none");
        },
        { timeout: 2000 }
      );
    } finally {
      setAssetDocPath(null);
    }
  });
});

describe("RichView when the live session cannot load", () => {
  it("says so in one line and mounts the editor on the local copy", async () => {
    loader.failed = true;
    try {
      const onCollabStatus = vi.fn();
      let editor: Editor | null = null;
      const { container } = render(
        <RichView
          value={"# Shared\n\nA line.\n"}
          onChange={() => {}}
          collab={{
            docId: "doc-1",
            wsBase: "ws://localhost/collab",
            token: "t",
            fetchTicket: async () => ({ kind: "ticket", ticket: "tk", expiresAt: 0 }),
            user: { name: "Me", color: "#000000" },
            readonly: false,
          }}
          onEditorReady={(e) => {
            if (e) editor = e;
          }}
          onCollabStatus={onCollabStatus}
        />
      );
      const note = container.querySelector("[data-markie-live-failed]");
      expect(note).not.toBeNull();
      expect(note!.textContent).toBe("The live session could not load. You are editing your copy alone.");
      expect(container.querySelector("[data-markie-live-loading]")).toBeNull();
      await waitFor(() => expect(editor).not.toBeNull());
      expect((editor as unknown as Editor).isEditable).toBe(true);
      expect(onCollabStatus).toHaveBeenCalledWith("unavailable");
    } finally {
      loader.failed = false;
    }
  });
});

describe("RichView in a live room nobody has written yet", () => {
  const file = "Meeting Title: Monday\\\nMe: A line of the transcript.\n";
  const collab = (readonly: boolean): CollabConfig => ({
    docId: "doc-1",
    wsBase: "ws://localhost/collab",
    token: "t",
    fetchTicket: async () => ({ kind: "ticket", ticket: "tk", expiresAt: 0 }),
    user: { name: "Me", color: "#000000" },
    readonly,
  });

  it("tells the page a viewer has nothing to read, so it can show the synced copy", async () => {
    loader.room = {};
    try {
      const onChange = vi.fn();
      const onCollabStatus = vi.fn();
      render(<RichView value={file} onChange={onChange} collab={collab(true)} onCollabStatus={onCollabStatus} />);
      await waitFor(() => expect(onCollabStatus).toHaveBeenCalledWith("empty"), { timeout: 2000 });
      // A viewer never writes, and a blank room is not the document's content.
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      loader.room = null;
    }
  });

  it("lets an editor seed the room from the file instead", async () => {
    loader.room = {};
    try {
      const onCollabStatus = vi.fn();
      let editor: Editor | null = null;
      render(
        <RichView
          value={file}
          onChange={() => {}}
          collab={collab(false)}
          onCollabStatus={onCollabStatus}
          onEditorReady={(e) => {
            if (e) editor = e;
          }}
        />
      );
      await waitFor(() => expect((editor as unknown as Editor | null)?.getText()).toContain("A line of the transcript."), {
        timeout: 2000,
      });
      expect(onCollabStatus).not.toHaveBeenCalledWith("empty");
    } finally {
      loader.room = null;
    }
  });

  it("seeds an SVG data: picture into the room as a picture", async () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>')}`;
    loader.room = {};
    try {
      let editor: Editor | null = null;
      render(
        <RichView
          value={`# Chart\n\n![Bottles opened per month](${svg})\n`}
          onChange={() => {}}
          collab={collab(false)}
          onEditorReady={(e) => {
            if (e) editor = e;
          }}
        />
      );
      // The live editor's content is the room's fragment, so a picture here
      // is a picture in the room.
      await waitFor(() => expect((editor as unknown as Editor | null)?.getText()).toContain("Chart"), { timeout: 2000 });
      const live = editor as unknown as Editor;
      expect(live.getHTML()).toContain(`<img src="${svg}" alt="Bottles opened per month">`);
      expect(live.getText()).not.toContain("data:image");
    } finally {
      loader.room = null;
    }
  });

  it("shows a viewer the room once it has content", async () => {
    const yjs = await import("yjs");
    loader.room = {
      seed: (doc) => {
        const paragraph = new yjs.XmlElement("paragraph");
        paragraph.insert(0, [new yjs.XmlText("Written in the room.")]);
        doc.getXmlFragment("default").insert(0, [paragraph]);
      },
    };
    try {
      const onCollabStatus = vi.fn();
      let editor: Editor | null = null;
      render(
        <RichView
          value={file}
          onChange={() => {}}
          collab={collab(true)}
          onCollabStatus={onCollabStatus}
          onEditorReady={(e) => {
            if (e) editor = e;
          }}
        />
      );
      await waitFor(() => expect((editor as unknown as Editor | null)?.getText()).toContain("Written in the room."), {
        timeout: 2000,
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(onCollabStatus).not.toHaveBeenCalledWith("empty");
    } finally {
      loader.room = null;
    }
  });
});

describe("RichView's live-editing pass", () => {
  const SESSION_TOKEN = "account-wide-session-token";
  const collab = (fetchTicket: () => Promise<CollabTicketAnswer>): CollabConfig => ({
    docId: "doc-1",
    wsBase: "ws://localhost/collab",
    token: SESSION_TOKEN,
    fetchTicket,
    user: { name: "Me", color: "#000000" },
    readonly: false,
  });
  const latest = () => loader.providers.at(-1)!;

  it("creates the provider with no session token and connects with the server's ticket", async () => {
    loader.room = {};
    loader.providers = [];
    try {
      const fetchTicket = vi.fn(async (): Promise<CollabTicketAnswer> => ({ kind: "ticket", ticket: "tk-1", expiresAt: 0 }));
      render(<RichView value={"# Doc\n"} onChange={() => {}} collab={collab(fetchTicket)} />);
      await waitFor(() => expect(latest()?.connects).toBe(1));
      expect(latest().createdWith).toEqual({});
      expect(latest().params).toEqual({ ticket: "tk-1" });
      expect(JSON.stringify(latest().params)).not.toContain(SESSION_TOKEN);
    } finally {
      loader.room = null;
    }
  });

  it("falls back to the token on a server that has no ticket route", async () => {
    loader.room = {};
    loader.providers = [];
    try {
      render(<RichView value={"# Doc\n"} onChange={() => {}} collab={collab(async () => ({ kind: "legacy" }))} />);
      await waitFor(() => expect(latest()?.connects).toBe(1));
      expect(latest().params).toEqual({ token: SESSION_TOKEN });
    } finally {
      loader.room = null;
    }
  });

  it("does not connect at all when no ticket can be had, and tells the page the session is unavailable", async () => {
    loader.room = {};
    loader.providers = [];
    try {
      const onCollabStatus = vi.fn();
      render(
        <RichView
          value={"# Doc\n"}
          onChange={() => {}}
          collab={collab(async () => ({ kind: "failed", status: 401 }))}
          onCollabStatus={onCollabStatus}
        />
      );
      await waitFor(() => expect(onCollabStatus).toHaveBeenCalledWith("unavailable"));
      expect(latest().connects).toBe(0);
      expect(latest().params).toEqual({});
    } finally {
      loader.room = null;
    }
  });

  it("puts a fresh ticket in provider.params when the connection drops", async () => {
    loader.room = {};
    loader.providers = [];
    const realNow = Date.now;
    try {
      let n = 0;
      const fetchTicket = vi.fn(async (): Promise<CollabTicketAnswer> => ({ kind: "ticket", ticket: `tk-${++n}`, expiresAt: 0 }));
      render(<RichView value={"# Doc\n"} onChange={() => {}} collab={collab(fetchTicket)} />);
      await waitFor(() => expect(latest()?.params).toEqual({ ticket: "tk-1" }));
      const start = realNow();
      vi.spyOn(Date, "now").mockImplementation(() => start + TICKET_CLOSE_REFRESH_MIN_MS + 1000);
      latest().drop(1006);
      await waitFor(() => expect(latest().params).toEqual({ ticket: "tk-2" }));
      expect(latest().connects).toBe(1);
    } finally {
      vi.restoreAllMocks();
      loader.room = null;
    }
  });
});

// The verifier's document (see src/lib/live-snapshot.test.ts): KaTeX inline
// and display with a thin space, a right-aligned table column, a closing
// newline. Solo editing kept it byte for byte; a live room rewrote all of it
// on the first keystroke anyone made, in every reader's stored copy.
const EVERYTHING = [
  "# Everything",
  "",
  "Inline math $e^{i\\pi} + 1 = 0$ in a sentence.",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| Item | Price |",
  "| :--- | ---: |",
  "| Tea | 3 |",
  "| Cake | 12 |",
  "",
  "Last line.",
  "",
].join("\n");

describe("RichView in a live room: what it writes back", () => {
  const collab: CollabConfig = {
    docId: "doc-everything",
    wsBase: "ws://localhost/collab",
    token: "t",
    fetchTicket: async () => ({ kind: "ticket", ticket: "tk", expiresAt: 0 }),
    user: { name: "Me", color: "#000000" },
    readonly: false,
  };

  // Alice opens the stored copy live and seeds the room; Bob then joins the
  // room she wrote, from his own copy of the stored text, and edits it.
  async function seededRoom(text: string): Promise<{ state: Uint8Array; first: string }> {
    const Y = await import("yjs");
    loader.room = {};
    const onRoomReady = vi.fn();
    const { unmount } = render(
      <RichView value={text} onChange={() => {}} collab={collab} holdUntilReady onRoomReady={onRoomReady} />
    );
    try {
      await waitFor(() => expect(onRoomReady).toHaveBeenCalled(), { timeout: 3000 });
      const session = (window as unknown as { __markieCollab?: { ydoc: import("yjs").Doc } | null }).__markieCollab;
      return { state: Y.encodeStateAsUpdate(session!.ydoc), first: onRoomReady.mock.calls[0][0] as string };
    } finally {
      unmount();
      loader.room = null;
    }
  }

  async function peerEdits(text: string, state: Uint8Array, edit: (editor: Editor) => void): Promise<string> {
    const Y = await import("yjs");
    loader.room = { seed: (doc) => Y.applyUpdate(doc, state) };
    try {
      const onChange = vi.fn();
      let editor: Editor | null = null;
      render(
        <RichView value={text} onChange={onChange} collab={collab} holdUntilReady onEditorReady={(e) => { if (e) editor = e; }} />
      );
      await waitFor(() => expect((editor as unknown as Editor | null)?.isEditable).toBe(true), { timeout: 3000 });
      const before = onChange.mock.calls.length;
      edit(editor as unknown as Editor);
      await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(before), { timeout: 2000 });
      return onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    } finally {
      loader.room = null;
    }
  }

  it("says the stored copy back byte for byte when the room is ready", async () => {
    const { first } = await seededRoom(EVERYTHING);
    expect(first).toBe(EVERYTHING);
  });

  it("keeps every block a peer did not touch, math, alignment and closing newline included", async () => {
    const { state } = await seededRoom(EVERYTHING);
    const out = await peerEdits(EVERYTHING, state, (editor) => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Bob");
    });
    expect(out).toBe(EVERYTHING.replace("Last line.", "Last line. Bob"));
  });

  it("keeps inline math as written in the paragraph a peer did edit", async () => {
    const { state } = await seededRoom(EVERYTHING);
    const out = await peerEdits(EVERYTHING, state, (editor) => {
      // The end of the paragraph holding `$e^{i\pi} + 1 = 0$`.
      editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1, " Bob");
    });
    expect(out).toBe(EVERYTHING.replace("in a sentence.", "in a sentence. Bob"));
  });
});

// ── The editor data model, live: math nodes, table alignment, front matter,
// and rooms from older builds (src/lib/rich-math.ts, rich-table-align.ts,
// rich-room-migrate.ts, collab.ts) ─────────────────────────────────────────

const FRONT = "---\ntitle: Plan\nmarkie:\n  project: Markie\n---\n";
const MODEL_BODY = [
  "# Plan",
  "",
  "Inline $e^{i\\pi} + 1 = 0$ here.",
  "",
  "$$",
  "\\int_0^1 x^2",
  "  \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| Item | Price | Note |",
  "| :--- | :---: | ---: |",
  "| Tea | 3 | hot |",
  "",
  "Last line.",
  "",
].join("\n");
const MODEL = FRONT + MODEL_BODY;

describe("RichView in a live room: the editor data model", () => {
  const collab = (readonly = false): CollabConfig => ({
    docId: "doc-model",
    wsBase: "ws://localhost/collab",
    token: "t",
    fetchTicket: async () => ({ kind: "ticket", ticket: "tk", expiresAt: 0 }),
    user: { name: "Me", color: "#000000" },
    readonly,
  });
  const liveDoc = () => (window as unknown as { __markieCollab?: { ydoc: import("yjs").Doc } | null }).__markieCollab!.ydoc;

  // One client opens `text` live over a room filled by `seed` (or seeds an
  // empty one), and the test reads what it reports and what the room holds.
  async function openLive(
    text: string,
    seed: ((doc: import("yjs").Doc) => void) | undefined,
    opts: { readonly?: boolean } = {}
  ) {
    const Y = await import("yjs");
    loader.room = seed ? { seed } : {};
    const onRoomReady = vi.fn();
    const onChange = vi.fn();
    const onCollabStatus = vi.fn();
    let editor: Editor | null = null;
    const view = render(
      <RichView
        value={text}
        onChange={onChange}
        collab={collab(opts.readonly)}
        holdUntilReady
        onRoomReady={onRoomReady}
        onCollabStatus={onCollabStatus}
        onEditorReady={(e) => { if (e) editor = e; }}
      />
    );
    return {
      onRoomReady,
      onChange,
      onCollabStatus,
      editor: () => editor as unknown as Editor,
      state: () => Y.encodeStateAsUpdate(liveDoc()),
      meta: (key: string) => liveDoc().getMap("meta").get(key),
      done: () => { view.unmount(); loader.room = null; },
    };
  }

  const topTypes = (editor: Editor) => {
    const types: string[] = [];
    editor.state.doc.forEach((node) => types.push(node.type.name));
    return types;
  };

  it("keeps front matter out of the room, and says the stored copy back byte for byte", async () => {
    const live = await openLive(MODEL, undefined);
    try {
      await waitFor(() => expect(live.onRoomReady).toHaveBeenCalled(), { timeout: 3000 });
      expect(live.onRoomReady.mock.calls[0][0]).toBe(MODEL);
      // No rule and no `title:` heading: the room starts at the body.
      const types = topTypes(live.editor());
      expect(types[0]).toBe("heading");
      expect(types).not.toContain("horizontalRule");
      expect(live.editor().getText()).not.toContain("title: Plan");
      expect(live.editor().getText()).not.toContain("project");
      // A room with a formula in it is schema 2, which keeps older builds out.
      expect(live.meta("schemaVersion")).toBe(2);
    } finally {
      live.done();
    }
  });

  it("seeds a room without math as schema 1, open to every build", async () => {
    const live = await openLive(FRONT + "# Plain\n\nNo formulas.\n", undefined);
    try {
      await waitFor(() => expect(live.onRoomReady).toHaveBeenCalled(), { timeout: 3000 });
      expect(live.meta("schemaVersion")).toBe(1);
    } finally {
      live.done();
    }
  });

  // Alice seeds; Bob joins her room from his own copy of the stored text and
  // edits it; what Bob's pane writes is the stored copy with his edit only.
  async function seededState(text: string): Promise<Uint8Array> {
    const live = await openLive(text, undefined);
    try {
      await waitFor(() => expect(live.onRoomReady).toHaveBeenCalled(), { timeout: 3000 });
      return live.state();
    } finally {
      live.done();
    }
  }
  async function peerWrites(text: string, state: Uint8Array, edit: (editor: Editor) => void): Promise<string> {
    const Y = await import("yjs");
    const live = await openLive(text, (doc) => Y.applyUpdate(doc, state));
    try {
      await waitFor(() => expect(live.editor()?.isEditable).toBe(true), { timeout: 3000 });
      const before = live.onChange.mock.calls.length;
      edit(live.editor());
      await waitFor(() => expect(live.onChange.mock.calls.length).toBeGreaterThan(before), { timeout: 2000 });
      return live.onChange.mock.calls.at(-1)![0] as string;
    } finally {
      live.done();
    }
  }
  const nodePos = (editor: Editor, type: string, nth = 0) => {
    const found: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === type) found.push(pos);
    });
    return found[nth];
  };
  const setSource = (type: string, change: (source: string) => string) => (editor: Editor) => {
    const pos = nodePos(editor, type);
    const node = editor.state.doc.nodeAt(pos)!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: change(node.attrs.source) }));
  };

  it("an edit inside a multi-line display formula keeps its lines and every other byte", async () => {
    const state = await seededState(MODEL);
    const out = await peerWrites(MODEL, state, setSource("mathBlock", (s) => s.replace("\\frac{1}{3}", () => "\\frac{1}{3} + C")));
    expect(out).toBe(MODEL.replace("\\frac{1}{3}", () => "\\frac{1}{3} + C"));
  });

  it("an edit inside inline math keeps the sentence and every other byte", async () => {
    const state = await seededState(MODEL);
    const out = await peerWrites(MODEL, state, setSource("mathInline", (s) => s.replace("+ 1", () => "- 1")));
    expect(out).toBe(MODEL.replace("$e^{i\\pi} + 1 = 0$", () => "$e^{i\\pi} - 1 = 0$"));
  });

  it("an edit right next to a formula keeps the formula exact", async () => {
    const state = await seededState(MODEL);
    const out = await peerWrites(MODEL, state, (editor) => {
      // Straight after the inline formula, in the same paragraph.
      const pos = nodePos(editor, "mathInline");
      editor.commands.insertContentAt(pos + 1, " (Euler)");
    });
    expect(out).toBe(MODEL.replace("$e^{i\\pi} + 1 = 0$", () => "$e^{i\\pi} + 1 = 0$ (Euler)"));
  });

  it("an edit inside an aligned table keeps every column's alignment", async () => {
    const state = await seededState(MODEL);
    const out = await peerWrites(MODEL, state, (editor) => {
      // The end of the "Tea" cell.
      let at = -1;
      editor.state.doc.descendants((node, pos) => {
        if (at === -1 && node.isText && node.text === "Tea") at = pos + node.nodeSize;
      });
      editor.commands.insertContentAt(at, " (green)");
    });
    // Re-padded for the longer cell, with every column's colons.
    expect(out).toContain("| Item        | Price | Note |\n| :---------- | :---: | ---: |\n| Tea (green) | 3     | hot  |\n");
    // Only the table was rewritten; the front matter and the rest are as stored.
    expect(out.startsWith(FRONT + "# Plan\n\nInline $e^{i\\pi} + 1 = 0$ here.\n\n$$\n\\int_0^1 x^2\n  \\, dx = \\frac{1}{3}\n$$\n\n")).toBe(true);
    expect(out.endsWith("\n\nLast line.\n")).toBe(true);
  });

  it("writes each client's own copy's front matter, so the stored copy's wins and nothing doubles", async () => {
    const state = await seededState(MODEL);
    const otherFront = "---\ntitle: Someone else's\n---\n";
    const out = await peerWrites(otherFront + MODEL_BODY, state, (editor) => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Bob");
    });
    expect(out).toBe(otherFront + MODEL_BODY.replace("Last line.", "Last line. Bob"));
  });

  // A room seeded by desktop 0.9.4: the front matter parsed as a rule and a
  // setext heading, math as text with its line breaks folded to spaces.
  async function olderBuildRoom(doc: import("yjs").Doc) {
    const { prosemirrorJSONToYXmlFragment } = await import("@tiptap/y-tiptap");
    const { Editor: Headless } = await import("@tiptap/core");
    const { richBaseExtensions } = await import("@/lib/rich-extensions");
    const scratch = new Headless({ extensions: richBaseExtensions({ collab: true }), content: "" });
    const text = (t: string) => ({ type: "text", text: t });
    const p = (t: string) => ({ type: "paragraph", attrs: { textAlign: null }, content: [text(t)] });
    const json = {
      type: "doc",
      content: [
        { type: "horizontalRule" },
        { type: "heading", attrs: { level: 2, textAlign: null }, content: [text("title: Plan markie: project: Markie")] },
        { type: "heading", attrs: { level: 1, textAlign: null }, content: [text("Plan")] },
        p("Inline $e^{i\\pi} + 1 = 0$ here."),
        p("$$ \\int_0^1 x^2 \\, dx = \\frac{1}{3} $$"),
        p("Last line."),
      ],
    };
    prosemirrorJSONToYXmlFragment(scratch.schema, json, doc.getXmlFragment("default"));
    doc.getMap("meta").set("schemaVersion", 1);
    scratch.destroy();
  }
  const OLDER_STORED = FRONT + "# Plan\n\nInline $e^{i\\pi} + 1 = 0$ here.\n\n$$\n\\int_0^1 x^2\n  \\, dx = \\frac{1}{3}\n$$\n\nLast line.\n";

  it("brings a room an older build seeded up to date: front matter out once, formulas with their lines back", async () => {
    let seed: ((doc: import("yjs").Doc) => void) | undefined;
    {
      const Y = await import("yjs");
      const prepared = new Y.Doc();
      await olderBuildRoom(prepared);
      const state = Y.encodeStateAsUpdate(prepared);
      seed = (doc) => Y.applyUpdate(doc, state);
    }
    const live = await openLive(OLDER_STORED, seed);
    try {
      await waitFor(() => expect(live.onRoomReady).toHaveBeenCalled(), { timeout: 3000 });
      // The stored copy, exactly: the front matter written once, the
      // display formula on its own lines.
      expect(live.onRoomReady.mock.calls[0][0]).toBe(OLDER_STORED);
      const types = topTypes(live.editor());
      expect(types).not.toContain("horizontalRule");
      expect(types).toContain("mathBlock");
      expect(live.editor().getText()).not.toContain("title: Plan");
      expect(live.meta("schemaVersion")).toBe(2);
    } finally {
      live.done();
    }
  });

  it("refuses an older room whose front matter was edited in the room, rather than write it twice", async () => {
    const Y = await import("yjs");
    const prepared = new Y.Doc();
    await olderBuildRoom(prepared);
    // Somebody on the older build changed the heading the front matter became.
    const heading = prepared.getXmlFragment("default").get(1) as import("yjs").XmlElement;
    (heading.get(0) as import("yjs").XmlText).insert(0, "edited ");
    const state = Y.encodeStateAsUpdate(prepared);
    const live = await openLive(OLDER_STORED, (doc) => Y.applyUpdate(doc, state));
    try {
      await waitFor(() => expect(live.onCollabStatus).toHaveBeenCalledWith("unavailable"), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 400));
      expect(live.onRoomReady).not.toHaveBeenCalled();
      expect(live.onChange).not.toHaveBeenCalled();
      // Nothing in the room was changed.
      expect(live.editor().state.doc.firstChild?.type.name).toBe("horizontalRule");
    } finally {
      live.done();
    }
  });

  it("refuses a room a newer build stamped, and never writes from it", async () => {
    const Y = await import("yjs");
    const prepared = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("From the future.")]);
    prepared.getXmlFragment("default").insert(0, [paragraph]);
    prepared.getMap("meta").set("schemaVersion", 3);
    const state = Y.encodeStateAsUpdate(prepared);
    const live = await openLive("From the future.\n", (doc) => Y.applyUpdate(doc, state));
    try {
      await waitFor(() => expect(live.onCollabStatus).toHaveBeenCalledWith("unavailable"), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 400));
      expect(live.onRoomReady).not.toHaveBeenCalled();
      expect(live.onChange).not.toHaveBeenCalled();
      expect(live.editor().isEditable).toBe(false);
    } finally {
      live.done();
    }
  });

  it("refuses a room holding a node this build does not know, even unstamped", async () => {
    const Y = await import("yjs");
    const prepared = new Y.Doc();
    const unknown = new Y.XmlElement("hologram");
    prepared.getXmlFragment("default").insert(0, [unknown]);
    const state = Y.encodeStateAsUpdate(prepared);
    const live = await openLive("Anything.\n", (doc) => Y.applyUpdate(doc, state));
    try {
      await waitFor(() => expect(live.onCollabStatus).toHaveBeenCalledWith("unavailable"), { timeout: 3000 });
      expect(live.onRoomReady).not.toHaveBeenCalled();
      expect(live.onChange).not.toHaveBeenCalled();
      // The room still holds what this build could not draw.
      expect(liveDoc().getXmlFragment("default").get(0)).toBeInstanceOf(Y.XmlElement);
    } finally {
      live.done();
    }
  });

  it("raises a plain room to schema 2 when the first formula arrives", async () => {
    const plain = "# Plain\n\nNo formulas yet.\n";
    const state = await seededState(plain);
    const Y = await import("yjs");
    const live = await openLive(plain, (doc) => Y.applyUpdate(doc, state));
    try {
      await waitFor(() => expect(live.editor()?.isEditable).toBe(true), { timeout: 3000 });
      expect(live.meta("schemaVersion")).toBe(1);
      live.editor().commands.insertContentAt(live.editor().state.doc.content.size - 1, [
        { type: "text", text: " See " },
        { type: "mathInline", attrs: { source: "$x^2$" } },
      ]);
      await waitFor(() => expect(live.meta("schemaVersion")).toBe(2), { timeout: 2000 });
      await waitFor(() => expect(live.onChange).toHaveBeenCalled(), { timeout: 2000 });
      expect(live.onChange.mock.calls.at(-1)![0]).toBe("# Plain\n\nNo formulas yet. See $x^2$\n");
    } finally {
      live.done();
    }
  });
});
