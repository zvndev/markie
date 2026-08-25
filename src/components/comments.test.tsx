import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "@/lib/comments";

const list = vi.fn();
const createThread = vi.fn();
const reply = vi.fn();
const setStatus = vi.fn();
const deleteComment = vi.fn();
const selectionToAnchor = vi.fn();
const anchorToAbsolute = vi.fn();

vi.mock("@/lib/comments", () => ({
  commentsClient: {
    list: (...a: unknown[]) => list(...a),
    createThread: (...a: unknown[]) => createThread(...a),
    reply: (...a: unknown[]) => reply(...a),
    setStatus: (...a: unknown[]) => setStatus(...a),
    deleteComment: (...a: unknown[]) => deleteComment(...a),
  },
  selectionToAnchor: (...a: unknown[]) => selectionToAnchor(...a),
  anchorToAbsolute: (...a: unknown[]) => anchorToAbsolute(...a),
}));

const me = vi.fn();
vi.mock("@/lib/auth-client", () => ({ authClient: { me: () => me() } }));

import { CommentLayer } from "./comments";

// --- a ProseMirror stand-in that only does what CommentLayer asks of it ------

function fakeEditor() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const run = vi.fn();
  const setTextSelection = vi.fn(() => ({ scrollIntoView: () => ({ run }) }));
  const editor = {
    state: { selection: { from: 0, to: 0, empty: true } },
    view: { coordsAtPos: (pos: number) => ({ top: 100 + pos }) },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb);
    },
    off: (event: string, cb: (...a: unknown[]) => void) => {
      handlers.get(event)?.delete(cb);
    },
    chain: () => ({ focus: () => ({ setTextSelection }) }),
  };
  const fire = (event: string) => {
    for (const cb of handlers.get(event) ?? []) cb();
  };
  const listenerCount = (event: string) => handlers.get(event)?.size ?? 0;
  return { editor, fire, listenerCount, setTextSelection, run };
}

async function bubble(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`);
    expect(el, `bubble for thread ${id}`).not.toBeNull();
    return el!;
  });
}

function thread(o: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "t1",
    doc_id: "doc-1",
    anchor: { from: 4, to: 9 },
    status: "open",
    created_by: "u2",
    created_at: "2026-01-01T10:00:00.000Z",
    comments: [
      {
        id: "c1",
        thread_id: "t1",
        author_id: "u2",
        author_name: "Grace Hopper",
        author_email: "grace@markie.app",
        body: "Tighten this paragraph.",
        created_at: "2026-01-01T10:00:00.000Z",
      },
    ],
    ...o,
  };
}

function renderLayer(
  props: {
    readonly?: boolean;
    canComment?: boolean;
    canModerate?: boolean;
    container?: HTMLDivElement | null;
  } = {}
) {
  const harness = fakeEditor();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const view = render(
    <CommentLayer
      editor={harness.editor as never}
      ydoc={{} as never}
      docId="doc-1"
      readonly={props.readonly ?? false}
      canComment={props.canComment ?? true}
      canModerate={props.canModerate ?? false}
      container={"container" in props ? props.container! : container}
    />
  );
  return { ...view, ...harness, container };
}

beforeEach(() => {
  me.mockResolvedValue({ id: "u1", name: "Ada Lovelace", email: "ada@markie.app" });
  list.mockResolvedValue([]);
  createThread.mockResolvedValue({ id: "t9" });
  reply.mockResolvedValue({ id: "c9" });
  setStatus.mockResolvedValue({ ok: true });
  deleteComment.mockResolvedValue({ ok: true });
  selectionToAnchor.mockReturnValue({ from: {}, to: {} });
  anchorToAbsolute.mockImplementation(
    (_e: unknown, _y: unknown, anchor: { from: number; to: number }) => anchor
  );
});

describe("CommentLayer", () => {
  it("shows nothing when the document has no comments", async () => {
    renderLayer();
    await waitFor(() => expect(list).toHaveBeenCalledWith("doc-1"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts a bubble on each open thread, labelled with its comment count", async () => {
    list.mockResolvedValue([
      thread({ id: "t1", anchor: { from: 4, to: 9 } }),
      thread({
        id: "t2",
        anchor: { from: 60, to: 66 },
        comments: [
          thread().comments[0],
          { ...thread().comments[0], id: "c2", body: "Agreed." },
        ],
      }),
    ]);
    renderLayer();

    const bubbles = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>("[data-comment-thread]");
      expect(found).toHaveLength(2);
      return Array.from(found);
    });
    expect(bubbles[0]).toHaveTextContent("1");
    expect(bubbles[1]).toHaveTextContent("2");
    expect(bubbles[0]).toHaveAttribute(
      "title",
      "Grace Hopper: Tighten this paragraph."
    );
  });

  it("spaces overlapping bubbles apart instead of stacking them", async () => {
    list.mockResolvedValue([
      thread({ id: "t1", anchor: { from: 4, to: 9 } }),
      thread({ id: "t2", anchor: { from: 5, to: 9 } }),
    ]);
    renderLayer();

    const bubbles = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>("[data-comment-thread]");
      expect(found).toHaveLength(2);
      return Array.from(found);
    });
    // coordsAtPos gives 104 and 105; the second is pushed to a 30px gap
    expect(bubbles[0].style.top).toBe("104px");
    expect(bubbles[1].style.top).toBe("134px");
  });

  it("drops a thread whose anchored text was deleted", async () => {
    list.mockResolvedValue([
      thread({ id: "t1", anchor: { from: 4, to: 9 } }),
      thread({ id: "t2", anchor: { from: 40, to: 49 } }),
    ]);
    anchorToAbsolute.mockImplementation(
      (_e: unknown, _y: unknown, anchor: { from: number; to: number }) =>
        anchor.from === 4 ? null : anchor
    );
    renderLayer();
    await waitFor(() =>
      expect(document.querySelectorAll("[data-comment-thread]")).toHaveLength(1)
    );
  });

  it("opens a thread, jumps the editor to it, and closes again", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([thread()]);
    const { setTextSelection } = renderLayer();

    await user.click(await bubble("t1"));

    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    expect(within(panel).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(panel).getByText("Tighten this paragraph.")).toBeInTheDocument();
    expect(within(panel).getByText("Open")).toBeInTheDocument();
    expect(setTextSelection).toHaveBeenCalledWith({ from: 4, to: 9 });

    await user.click(within(panel).getByRole("button", { name: "Close thread" }));
    expect(document.querySelector('[data-comment-panel="t1"]')).toBeNull();
  });

  it("offers Comment on a selection and files the new thread", async () => {
    const user = userEvent.setup();
    const { editor, fire } = renderLayer();

    editor.state.selection = { from: 4, to: 9, empty: false };
    fire("selectionUpdate");

    await user.click(await screen.findByRole("button", { name: /Comment/ }));
    const textarea = screen.getByPlaceholderText("Comment…");
    await user.type(textarea, "Needs a source.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(selectionToAnchor).toHaveBeenCalledWith(editor, 4, 9);
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith(
        "doc-1",
        { from: {}, to: {} },
        "Needs a source."
      )
    );
    // and it refetches so the new bubble appears
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refuses to file an empty comment", async () => {
    const user = userEvent.setup();
    const { editor, fire } = renderLayer();
    editor.state.selection = { from: 4, to: 9, empty: false };
    fire("selectionUpdate");

    await user.click(await screen.findByRole("button", { name: /Comment/ }));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.type(screen.getByPlaceholderText("Comment…"), "   ");
    await user.click(send);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("cancels the composer with Escape", async () => {
    const user = userEvent.setup();
    const { editor, fire } = renderLayer();
    editor.state.selection = { from: 4, to: 9, empty: false };
    fire("selectionUpdate");
    await user.click(await screen.findByRole("button", { name: /Comment/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Comment…")).toBeNull();
  });

  it("still offers Comment on a read-only share, because viewers may comment", async () => {
    const { editor, fire } = renderLayer({ readonly: true });
    editor.state.selection = { from: 4, to: 9, empty: false };
    fire("selectionUpdate");
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: /Comment/ })
    ).toBeInTheDocument();
  });

  it("withholds Comment when the seat may not comment at all", async () => {
    const { editor, fire } = renderLayer({ canComment: false });
    editor.state.selection = { from: 4, to: 9, empty: false };
    fire("selectionUpdate");
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Comment/ })).toBeNull();
  });

  it("replies to a thread with Enter", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([thread()]);
    renderLayer();
    await user.click(await bubble("t1"));

    await user.type(screen.getByPlaceholderText("Reply…"), "Done.{Enter}");
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith("doc-1", "t1", "Done.")
    );
  });

  it("resolves an open thread and moves it under the resolved toggle", async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce([thread()]);
    list.mockResolvedValue([thread({ status: "resolved" })]);
    renderLayer();

    await user.click(await bubble("t1"));
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(setStatus).toHaveBeenCalledWith("doc-1", "t1", "resolved");

    const toggle = await screen.findByRole("button", { name: /1 resolved/ });
    expect(document.querySelector("[data-comment-thread]")).toBeNull();

    await user.click(toggle);
    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    expect(within(panel).getByText("Resolved")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    // a resolved thread takes no replies
    expect(within(panel).queryByPlaceholderText("Reply…")).toBeNull();
  });

  it("lets you delete your own comment but not someone else's", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([
      thread({
        comments: [
          thread().comments[0],
          {
            ...thread().comments[0],
            id: "c2",
            author_id: "u1",
            author_name: "Ada Lovelace",
            body: "Mine.",
          },
        ],
      }),
    ]);
    renderLayer();
    await user.click(await bubble("t1"));

    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    const deletes = within(panel).getAllByRole("button", { name: "Delete comment" });
    expect(deletes).toHaveLength(1);

    await user.click(deletes[0]);
    expect(deleteComment).toHaveBeenCalledWith("doc-1", "t1", "c2");
  });

  it("lets the document owner delete anyone's comment", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([
      thread({
        comments: [
          thread().comments[0], // author u2, not the viewer
          {
            ...thread().comments[0],
            id: "c2",
            author_id: "u1",
            author_name: "Ada Lovelace",
            body: "Mine.",
          },
        ],
      }),
    ]);
    renderLayer({ canModerate: true });
    await user.click(await bubble("t1"));

    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    const deletes = within(panel).getAllByRole("button", { name: "Delete comment" });
    // Both comments are deletable now, not just the viewer's own.
    expect(deletes).toHaveLength(2);

    await user.click(deletes[0]);
    expect(deleteComment).toHaveBeenCalledWith("doc-1", "t1", "c1");
  });

  it("hides resolve on a read-only share but keeps the reply box", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([thread()]);
    renderLayer({ readonly: true });
    await user.click(await bubble("t1"));

    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    expect(within(panel).queryByRole("button", { name: "Resolve" })).toBeNull();
    // resolving is an editor act; replying is not
    expect(within(panel).getByPlaceholderText("Reply…")).toBeInTheDocument();

    await user.type(within(panel).getByPlaceholderText("Reply…"), "Noted.{Enter}");
    await waitFor(() => expect(reply).toHaveBeenCalledWith("doc-1", "t1", "Noted."));
  });

  it("hides the reply box when the seat may not comment at all", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([thread()]);
    renderLayer({ canComment: false });
    await user.click(await bubble("t1"));

    const panel = document.querySelector<HTMLElement>('[data-comment-panel="t1"]')!;
    expect(within(panel).queryByPlaceholderText("Reply…")).toBeNull();
  });

  it("renders no bubbles without a scroll container to measure against", async () => {
    list.mockResolvedValue([thread()]);
    renderLayer({ container: null });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(document.querySelector("[data-comment-thread]")).toBeNull();
  });

  it("detaches its editor listeners on unmount", async () => {
    list.mockResolvedValue([]);
    const { unmount, listenerCount } = renderLayer();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(listenerCount("selectionUpdate")).toBe(1);
    expect(listenerCount("update")).toBe(1);
    unmount();
    expect(listenerCount("selectionUpdate")).toBe(0);
    expect(listenerCount("update")).toBe(0);
  });
});
