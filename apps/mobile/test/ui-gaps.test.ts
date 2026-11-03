// @vitest-environment jsdom
// Three things a person on the phone saw go wrong, checked in a DOM:
//   - a viewer on a document nobody who can edit has opened live got a blank
//     editor instead of the saved copy;
//   - a comment read "The commented text was deleted" until the sheet was
//     closed and opened again, because its words were looked for only once;
//   - an editor's share sheet named everyone but the owner.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The rich view is the desktop's TipTap editor; what matters here is what the
// screen hands it and how the screen answers its status. A viewer joining an
// empty room is told "empty" once the room has synced, as rich-view.tsx does.
vi.mock("@/components/rich-view", async () => {
  const { useEffect } = await import("react");
  const Y = await import("yjs");
  const quiet = { on() {}, off() {} };
  const session = () => ({
    ydoc: new Y.Doc(),
    runtime: {},
    provider: { ...quiet, synced: true, wsconnected: true, awareness: { ...quiet, clientID: 1, getStates: () => new Map(), setLocalStateField() {} } },
  });
  return { RichView: (props: { value: string; readOnly?: boolean; collab?: unknown; onCollabStatus?: (status: string) => void; onLiveSession?: (session: unknown) => void }) => {
    useEffect(() => {
      if (!props.collab) return;
      // The session exists before the room says it is empty.
      props.onLiveSession?.(session());
      setTimeout(() => props.onCollabStatus?.("empty"), 0);
    }, [props.collab]);
    return createElement("div", { "data-rich": props.collab ? "live" : "solo", "data-readonly": String(!!props.readOnly) }, props.collab ? "" : props.value);
  } };
});
vi.mock("@/components/text-collab-editor", () => ({ TextCollabEditor: () => null }));
// The Darkmown runtime is loaded as raw text from outside this app's root,
// which the test runner refuses; none of these tests opens a Darkmown file.
vi.mock("../src/components/darkmown-view", () => ({ DarkmownView: () => null }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
async function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  // The access and members answers, then the room's status.
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
});

describe("a viewer on a document nobody has opened live", () => {
  it("reads the saved copy, not a blank room, and is told why comments wait", async () => {
    const { EditorScreen, EMPTY_ROOM_NOTE } = await import("../src/screens/editor");
    const api = {
      origin: "https://api.markiedocs.com",
      access: vi.fn(async () => ({ role: "viewer", canRead: true, canEdit: false, canManage: false })),
      shares: vi.fn(async () => [{ userId: "u2", email: "carol@example.com", name: "Carol", role: "viewer", pending: false }]),
      collabTicket: vi.fn(async () => ({ kind: "failed", status: 404 })),
      threads: vi.fn(async () => []),
    };
    const draft = { kind: "cloud" as const, id: "doc-1", name: "Plan.md", format: "markdown" as const, content: "# Plan\n\nShip it.", version: 2, role: "viewer" };
    const page = await mount(createElement(EditorScreen, {
      api: api as never, draft, me: { id: "u2", name: "Carol", email: "carol@example.com" },
      onCancel: () => {}, onSaved: () => {}, onUnauthorized: () => {}, backGuard: { current: null },
    }));
    const pane = page.querySelector("[data-rich]");
    expect(pane?.getAttribute("data-rich")).toBe("solo");
    expect(pane?.getAttribute("data-readonly")).toBe("true");
    expect(pane?.textContent).toContain("Ship it.");
    expect(page.querySelector("[data-empty-room]")?.textContent).toBe(EMPTY_ROOM_NOTE);
  });

  it("does not leave the comments sheet asking for a selection it can't anchor", async () => {
    const { EditorScreen } = await import("../src/screens/editor");
    const api = {
      origin: "https://api.markiedocs.com",
      access: vi.fn(async () => ({ role: "viewer", canRead: true, canEdit: false, canManage: false })),
      shares: vi.fn(async () => [{ userId: "u2", email: "carol@example.com", name: "Carol", role: "viewer", pending: false }]),
      collabTicket: vi.fn(async () => ({ kind: "failed", status: 404 })),
      threads: vi.fn(async () => []),
    };
    const draft = { kind: "cloud" as const, id: "doc-1", name: "Plan.md", format: "markdown" as const, content: "# Plan", version: 2, role: "viewer", openComments: true };
    const page = await mount(createElement(EditorScreen, {
      api: api as never, draft, me: { id: "u2", name: "Carol", email: "carol@example.com" },
      onCancel: () => {}, onSaved: () => {}, onUnauthorized: () => {}, backGuard: { current: null },
    }));
    expect(page.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("comments find their words again as the document changes", () => {
  it("re-reads after every change to the document, not only when the sheet opens", async () => {
    const { useDocRevision } = await import("../src/components/comments-sheet");
    const listeners = new Set<(event: { transaction: { docChanged: boolean } }) => void>();
    const editor = {
      isDestroyed: false,
      on: (_: string, fn: (event: { transaction: { docChanged: boolean } }) => void) => { listeners.add(fn); },
      off: (_: string, fn: (event: { transaction: { docChanged: boolean } }) => void) => { listeners.delete(fn); },
    };
    const seen: number[] = [];
    function Probe() {
      seen.push(useDocRevision(editor as never));
      return null;
    }
    await mount(createElement(Probe));
    const before = seen[seen.length - 1];
    // The room syncs: the document fills in.
    await act(async () => { for (const fn of listeners) fn({ transaction: { docChanged: true } }); });
    expect(seen[seen.length - 1]).toBeGreaterThan(before);
    // A selection change alone is not a change to the words.
    const after = seen[seen.length - 1];
    await act(async () => { for (const fn of listeners) fn({ transaction: { docChanged: false } }); });
    expect(seen[seen.length - 1]).toBe(after);
  });
});

describe("the share sheet for someone who doesn't own the document", () => {
  it("names the owner, as the list does, beside the members", async () => {
    const { ShareSheet } = await import("../src/components/share-sheet");
    const people = {
      invites: true,
      list: async () => [{ userId: "u2", email: "carol@example.com", name: "Carol", role: "viewer" as const, pending: false }],
      add: async () => "member" as const,
      setRole: async () => {},
      remove: async () => {},
    };
    const page = await mount(createElement(ShareSheet, {
      title: "Plan.md", people, canManage: false, owner: "Kirby", me: { email: "dave@example.com", name: "Dave" },
      link: null, onClose: () => {}, onUnauthorized: () => {},
    }));
    const owner = page.querySelector("[data-share-owner]");
    expect(owner?.textContent).toContain("Kirby");
    expect(owner?.textContent).toContain("Owner");
    expect(page.textContent).toContain("Carol");
  });

  it("still shows an owner row when the name isn't known", async () => {
    const { ShareSheet } = await import("../src/components/share-sheet");
    const people = { invites: true, list: async () => [], add: async () => "member" as const, setRole: async () => {}, remove: async () => {} };
    const page = await mount(createElement(ShareSheet, {
      title: "Plan.md", people, canManage: false, me: { email: "dave@example.com", name: "Dave" },
      link: null, onClose: () => {}, onUnauthorized: () => {},
    }));
    expect(page.querySelector("[data-share-owner]")?.textContent).toContain("The document's owner");
  });
});

describe("an Office file Markie keeps read-only, on the phone", () => {
  const rtf = (body: string) => new TextEncoder().encode(String.raw`{\rtf1\ansi Before\par ` + body + String.raw`\pard After\par}`);
  async function open(bytes: Uint8Array) {
    const { OfficeScreen } = await import("../src/screens/office");
    const api = {
      origin: "https://api.markiedocs.com",
      platform: () => ({
        call: async () => ({ document: {} }),
        decode: async () => ({ snapshot: { id: "doc-9", name: "Table.rtf", role: "owner", version: 1 }, bytes }),
      }),
    };
    const page = await mount(createElement(OfficeScreen, {
      api: api as never, id: "doc-9", backLabel: "Recent", tone: "light", me: { email: "o@example.com", name: "O" },
      onBack: () => {}, onUnauthorized: () => {}, onChanged: () => {},
    }));
    for (let i = 0; i < 80 && !page.querySelector(".docs-word-body"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    return page;
  }

  it("reads its table as a table, offers no Edit and draws no formatting toolbar", async () => {
    const page = await open(rtf(String.raw`\trowd\cellx2000\cellx4000 Region\cell Revenue\cell\row `));
    const rows = [...page.querySelectorAll(".docs-word-body tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()));
    expect(rows).toEqual([["Region", "Revenue"]]);
    expect(page.querySelector('button[aria-label="Edit"]')).toBeNull();
    expect(page.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("still offers Edit for one it can change", async () => {
    const page = await open(rtf(String.raw`Plain words.\par `));
    expect(page.querySelector(".docs-word-body")?.textContent).toContain("Plain words.");
    expect(page.querySelector('button[aria-label="Edit"]')).not.toBeNull();
  });
});
