// A live rich session must never write the room's text over the user's own
// file when the room cannot carry everything the file says. A rich room is
// TipTap's parse of the markdown, which has no node for front matter, raw
// HTML blocks, HTML comments or footnote definitions, so its serialization
// turns front matter into a heading and drops or escapes the rest.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, SaveResult } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => ({ id: "me", name: "Test", email: "test@example.com" }) },
  sharesClient: {
    access: async () => ({ role: "owner" }),
    list: async () => [{ user_id: "other", role: "editor" }],
    sharedByMe: async () => [],
    collabTicket: async () => ({ kind: "ticket", ticket: "test-ticket", expiresAt: 0 }),
  },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => "test-token",
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

// The live session runs over an in-memory room instead of a socket. `seed`
// fills the room before the first sync, as a server holding another client's
// writes would.
const room = vi.hoisted(() => ({
  seed: null as null | ((doc: import("yjs").Doc) => void),
  providers: 0,
}));
vi.mock("@/lib/collab-loader", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/collab-loader")>();
  const runtime = await import("@/lib/collab-runtime");
  const { Awareness } = await import("y-protocols/awareness");
  class FakeProvider {
    synced = false;
    shouldConnect = false;
    params: Record<string, string> = {};
    awareness: InstanceType<typeof Awareness>;
    #doc: import("yjs").Doc;
    #handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    constructor(_url: string, _room: string, doc: import("yjs").Doc) {
      this.#doc = doc;
      this.awareness = new Awareness(doc);
      room.providers += 1;
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
      setTimeout(() => {
        room.seed?.(this.#doc);
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
    useCollabRuntime: (wanted: boolean) => (wanted ? { runtime: fakeRuntime, failed: false } : real.useCollabRuntime(wanted)),
  };
});

import Home from "./page";
import { authStore } from "@/lib/auth-store";
import { setRichOverride } from "@/lib/rich-override";

const PATH = "/notes/shared.md";
const HELD = [
  "---",
  "title: Shared plan",
  "tags: [a, b]",
  "---",
  "",
  "# Plan",
  "",
  "Body text with a note.[^1]",
  "",
  '<div align="center">',
  "  <img src=\"logo.png\" width=\"80\">",
  "</div>",
  "",
  "<!-- keep this comment -->",
  "",
  "[^1]: The footnote.",
  "",
].join("\n");
const PLAIN = "# Plan\n\nBody text with nothing held aside.\n";

type SaveArgs = Parameters<ElectronAPI["saveFile"]>[0];

interface Handle {
  isEditable: boolean;
  commands: { insertContentAt(pos: number, text: string): void };
  state: { doc: { content: { size: number } } };
  getText(): string;
}
const richEditor = () => (window as unknown as { __markieEditor?: Handle | null }).__markieEditor ?? null;
const liveSession = () => (window as unknown as { __markieCollab?: unknown }).__markieCollab ?? null;

async function boot(content: string, extra: Partial<ElectronAPI> = {}) {
  const saveFile = vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => ({ success: true, path: PATH }));
  const draftSave = vi.fn<(args: { content: string }) => Promise<{ ok: true }>>(async () => ({ ok: true }));
  const docPush = vi.fn(async () => ({ ok: true, pushed: true }));
  installBridge({
    getInitialFile: vi.fn(async () => ({ name: "shared.md", path: PATH, content })),
    registryGet: vi.fn(async () => ({
      path: PATH, name: "shared.md", cloud_doc_id: "cloud-1", share_role: "owner",
      content_hash: null, cloud_version: 1, sync_state: "synced", last_opened_at: null, last_synced_at: null,
    })),
    saveFile,
    draftSave,
    docPush,
    ...extra,
  } as Partial<ElectronAPI>);
  const view = render(<Home />);
  return { saveFile, draftSave, docPush, view };
}

async function waitLive() {
  await waitFor(() => expect(liveSession()).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(richEditor()?.isEditable).toBe(true), { timeout: 4000 });
  // The room syncs and settles (SEED_SETTLE_MS) before anyone writes into it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  await waitFor(() => expect(richEditor()?.getText()).toContain("Plan"), { timeout: 4000 });
}

async function typeWordAndAutosave() {
  await act(async () => {
    const ed = richEditor()!;
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, " typed");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
}

const written = (saveFile: ReturnType<typeof vi.fn>) =>
  saveFile.mock.calls.map(([args]) => (args as SaveArgs).content);

beforeEach(async () => {
  localStorage.clear();
  room.seed = null;
  room.providers = 0;
  await authStore.refresh();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("a live rich session and the file on disk", () => {
  it("never writes room text over a file with front matter or raw HTML when this desktop seeds the room", async () => {
    const { saveFile, draftSave } = await boot(HELD);
    await waitLive();
    await typeWordAndAutosave();
    // The edit is in the room, for every peer to see.
    expect(richEditor()?.getText()).toContain("typed");
    // A save the user asks for writes the file as it is, not the room.
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true });
      await vi.advanceTimersByTimeAsync(500);
    });
    for (const content of written(saveFile)) expect(content).toBe(HELD);
    for (const [{ content }] of draftSave.mock.calls) {
      if (content) expect(content).toBe(HELD);
    }
    // The pane's note, and ⌘S saying the same out loud rather than nothing.
    await waitFor(() => expect(screen.getAllByText(/isn't updated from the live session/)).toHaveLength(2));
  });

  it("gives Copy all and Save a Copy the live text, and says so, while the file is left alone", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const saveFileAs = vi.fn(async (args: { content: string }) => ({ success: true, path: "/notes/copy.md", name: "copy.md", wroteCsv: false, content: args.content }));
    const { saveFile } = await boot(HELD, { saveFileAs: saveFileAs as unknown as ElectronAPI["saveFileAs"] });
    await waitLive();
    await typeWordAndAutosave();
    expect(screen.getAllByText(/isn't updated from the live session/)).toHaveLength(1);

    await act(async () => {
      fireEvent.click(document.querySelector("[data-markie-copy-all]")!);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain("typed");
    expect(await screen.findByText(/Copied the live session's text/)).toBeInTheDocument();

    await act(async () => {
      emit("onMenuSaveAs");
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(saveFileAs).toHaveBeenCalledTimes(1);
    expect((saveFileAs.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain("typed");
    expect(await screen.findByText(/Saved the live session's text/)).toBeInTheDocument();
    // The original file still has every byte it had.
    for (const content of written(saveFile)) expect(content).toBe(HELD);
  });

  // No construct on the known list: a reference link whose definition sits a
  // block away. The room cannot write it back, and nothing names why; the
  // generic guard finds out by writing it through a room once. Solo, the
  // rich pane is read-only for it until the reader says "edit anyway"; that
  // consent is for their own edits, never for a room's rewrite of the file.
  it("leaves alone a file the room cannot write back even with nothing known-unsafe in it", async () => {
    const odd = "# Plan\n\nSee [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n";
    setRichOverride(PATH, true);
    const { saveFile } = await boot(odd);
    await waitLive();
    await typeWordAndAutosave();
    expect(richEditor()?.getText()).toContain("typed");
    for (const content of written(saveFile)) expect(content).toBe(odd);
    expect(await screen.findByText(/isn't updated from the live session/)).toBeInTheDocument();
  });

  // The verifier's document, which every peer's first keystroke used to
  // rewrite: math, a right-aligned column and the closing newline.
  it("writes one typed word into a math-and-table file and changes nothing else", async () => {
    const everything = [
      "# Plan for everything",
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
    const { saveFile } = await boot(everything);
    await waitLive();
    await typeWordAndAutosave();
    await waitFor(() => expect(written(saveFile).some((c) => c.includes("typed"))).toBe(true));
    for (const content of written(saveFile)) {
      expect([everything, everything.replace("Last line.", "Last line. typed")]).toContain(content);
    }
    expect(screen.queryByText(/isn't updated from the live session/)).not.toBeInTheDocument();
  });

  it("never writes room text over that file when another client seeded the room", async () => {
    const yjs = await import("yjs");
    room.seed = (doc) => {
      const paragraph = new yjs.XmlElement("paragraph");
      paragraph.insert(0, [new yjs.XmlText("Plan written in the room.")]);
      doc.getXmlFragment("default").insert(0, [paragraph]);
    };
    const { saveFile } = await boot(HELD);
    await waitLive();
    await typeWordAndAutosave();
    for (const content of written(saveFile)) expect(content).toBe(HELD);
  });

  // Seeding the room is an editor update, and it used to autosave the room's
  // rendering over the file before anyone pressed a key.
  it("writes nothing when that file is only opened live", async () => {
    const { saveFile } = await boot(HELD);
    await waitLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    for (const content of written(saveFile)) expect(content).toBe(HELD);
  });

  it("still saves live edits to a file the room can carry", async () => {
    const { saveFile } = await boot(PLAIN);
    await waitLive();
    await typeWordAndAutosave();
    await waitFor(() => expect(written(saveFile).some((c) => c.includes("typed"))).toBe(true));
    expect(screen.queryByText(/isn't updated from the live session/)).not.toBeInTheDocument();
  });

  it("opens the file live in Source mode read-only and writes nothing", async () => {
    const { saveFile, view } = await boot(HELD);
    await waitFor(() => expect(view.container.querySelector("[data-markie-rich-pane]")).not.toBeNull());
    await act(async () => {
      emit("onSetMode", "edit");
    });
    await waitFor(() => expect(view.container.querySelector("[data-markie-rich-pane]")).toBeNull());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    for (const content of written(saveFile)) expect(content).toBe(HELD);
  });
});
