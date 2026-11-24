// @vitest-environment jsdom
// Comments from the reading screen. Three things are checked in a DOM:
//   - the document's rendered text is read, highlighted and un-highlighted
//     without changing a word of it;
//   - a comment anchored here lands on the same words in the desktop's own
//     editor, the promise the whole feature rests on;
//   - the screen itself: the count, the highlights, a thread that lost its
//     place, a new thread from a selection, and access taken away mid-read.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { anchorToAbsolute, selectionToAnchor } from "@/lib/comment-anchors";
import { describeQuote, locateQuote, quoteAnchor, quoteOf } from "@/lib/quote-anchor";
import { ApiError } from "../src/lib/api";
import { prepareDocumentHtml } from "../src/lib/document-html";
import { applyMarks, clearMarks, flattenDom, rangeOffsets, threadAt } from "../src/lib/reading-comments";

vi.mock("../src/components/darkmown-view", () => ({ DarkmownView: () => null }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const MARKDOWN = `# Launch plan

We ship the **beta** on Friday. The budget is tight, and [the list](https://example.com) is long.

## Risks

- Hosting doubled.
- The budget is tight because of it.
  - A nested point about \`rate limits\`.

| Owner | Task |
| --- | --- |
| Ada | Fix the importer |
| Grace | Fix the exporter |

> Quoted: we said the beta ships Friday.

\`\`\`js
const budget = "tight";
\`\`\`

Last line, with a second mention of the beta.
`;

function article(markdown = MARKDOWN): HTMLElement {
  const el = document.createElement("article");
  el.innerHTML = prepareDocumentHtml(renderMarkdownHTML(markdown)).html;
  document.body.appendChild(el);
  return el;
}

/** The anchor the reading screen makes for the nth appearance of `words`. */
function anchorFor(root: HTMLElement, words: string, nth = 0) {
  const flat = flattenDom(root);
  const { start, end } = spanOf(flat.text, words, nth);
  return JSON.parse(JSON.stringify(quoteAnchor(describeQuote(flat.text, start, end)!)));
}

/** Where the nth `words` is. A newline in `words` stands for any break between blocks. */
function spanOf(text: string, words: string, nth = 0): { start: number; end: number } {
  const lines = words.split("\n");
  let start = -1;
  for (let i = 0; i <= nth; i++) start = text.indexOf(lines[0], start + 1);
  expect(start, `"${words}" #${nth} is in the rendered text`).toBeGreaterThan(-1);
  let end = start + lines[0].length;
  for (const line of lines.slice(1)) {
    const next = text.indexOf(line, end);
    expect(text.slice(end, next).trim(), "only a break between the lines").toBe("");
    end = next + line.length;
  }
  return { start, end };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("the rendered document as text", () => {
  it("reads blocks one after another, never run together", () => {
    const flat = flattenDom(article());
    expect(flat.text).toMatch(/Launch plan\s*\n\s*We ship the beta on Friday\./);
    expect(flat.text).toMatch(/Hosting doubled\.\s*\n\s*The budget/);
    // Table cells have nothing between them in the HTML: they still read apart.
    expect(flat.text).toMatch(/Owner\s*\n\s*Task\s*\n\s*Ada\s*\n\s*Fix the importer/);
    expect(flat.text).not.toContain("OwnerTask");
    // Every text node is accounted for, at the offset its text is found at.
    for (const { node, at } of flat.nodes) expect(flat.text.slice(at, at + node.length)).toBe(node.data);
  });

  it("highlights a quote across bold text and a link, and takes it back out untouched", () => {
    const root = article();
    const before = root.innerHTML;
    const flat = flattenDom(root);
    const quote = describeQuote(flat.text, flat.text.indexOf("ship the beta"), flat.text.indexOf("the list") + "the list".length)!;
    const range = locateQuote(flat.text, quote)!;
    const marks = applyMarks(flat, [{ id: "t1", ...range }]);
    expect(marks.map((mark) => mark.textContent).join("")).toBe("ship the beta on Friday. The budget is tight, and the list");
    expect(marks.length).toBe(4);
    expect(root.querySelector("strong mark")?.textContent).toBe("beta");
    expect(root.querySelector("a mark")?.textContent).toBe("the list");
    expect(threadAt(marks[0].firstChild!.parentElement, marks)).toBe("t1");
    // Marking changes no text, so the same quote is found in the same place.
    expect(flattenDom(root).text).toBe(flat.text);
    clearMarks(marks);
    expect(root.innerHTML).toBe(before);
  });

  it("puts no highlight between list items or table cells", () => {
    const root = article();
    const flat = flattenDom(root);
    const from = flat.text.indexOf("Hosting doubled");
    const to = flat.text.indexOf("because of it") + "because of it".length;
    const marks = applyMarks(flat, [{ id: "t1", start: from, end: to }]);
    for (const mark of marks) {
      expect(mark.textContent!.trim()).not.toBe("");
      expect(["UL", "OL", "TABLE", "TBODY", "TR"]).not.toContain(mark.parentElement!.tagName);
    }
    expect(marks.map((mark) => mark.textContent).join(" ")).toBe("Hosting doubled. The budget is tight because of it");
  });

  it("gives words two threads share to the first, and the rest to the second", () => {
    const root = article("One two three four five.");
    const flat = flattenDom(root);
    const marks = applyMarks(flat, [
      { id: "a", start: flat.text.indexOf("two"), end: flat.text.indexOf("four") - 1 },
      { id: "b", start: flat.text.indexOf("three"), end: flat.text.indexOf("five") - 1 },
    ]);
    const byThread = (id: string) => marks.filter((mark) => mark.getAttribute("data-comment-thread") === id).map((mark) => mark.textContent).join("");
    expect(byThread("a")).toBe("two three");
    expect(byThread("b")).toBe(" four");
    expect(root.textContent).toBe("One two three four five.");
  });

  it("does not mistake a document's own <mark> for a thread", () => {
    const root = article("Plain ==x== <mark data-comment-thread=\"evil\">words</mark> here.");
    const own = root.querySelector("mark");
    expect(threadAt(own ?? root, [])).toBeNull();
  });

  it("reads a selection back as offsets in the same text", () => {
    const root = article();
    const flat = flattenDom(root);
    const strong = root.querySelector("strong")!.firstChild as Text;
    const link = root.querySelector("a")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(strong, 1);
    range.setEnd(link, 3);
    const offsets = rangeOffsets(flat, range)!;
    expect(flat.text.slice(offsets.start, offsets.end)).toBe("eta on Friday. The budget is tight, and the");
    // A selection whose ends are elements, as a triple tap makes.
    const whole = document.createRange();
    whole.selectNodeContents(root.querySelector("h2")!);
    const heading = rangeOffsets(flat, whole)!;
    expect(flat.text.slice(heading.start, heading.end)).toBe("Risks");
  });
});

describe("a comment made on the reading screen, on the desktop", () => {
  let editor: Editor | null = null;
  afterEach(() => { editor?.destroy(); editor = null; });

  function desktop(markdown = MARKDOWN) {
    const ydoc = new Y.Doc();
    const element = document.createElement("div");
    document.body.appendChild(element);
    // The desktop's own extension list, with the live room's binding.
    editor = new Editor({ element, extensions: [...richBaseExtensions({ collab: true, assetBaseDir: null }), Collaboration.configure({ document: ydoc })] });
    editor.commands.setContent(markdown);
    return { editor, ydoc };
  }

  const CASES: Array<[string, number, string]> = [
    ["beta", 0, "bold text"],
    ["The budget is tight", 0, "the first of a repeated phrase"],
    ["The budget is tight", 1, "the second of a repeated phrase"],
    ["the list", 0, "link text"],
    ["Fix the", 1, "a repeat in the next table row"],
    ["rate limits", 0, "inline code in a nested list"],
    ["the beta ships Friday", 0, "a block quote"],
    ["Launch plan", 0, "a heading"],
    ["Hosting doubled.\nThe budget is tight because", 0, "two list items"],
    ["the beta", 2, "the last of three mentions"],
  ];

  it.each(CASES)("lands on the same words: %s #%i (%s)", (words, nth) => {
    const root = article();
    const flat = flattenDom(root);
    const anchor = anchorFor(root, words, nth);
    const { editor: ed, ydoc } = desktop();
    const placed = anchorToAbsolute(ed, ydoc, anchor)!;
    expect(placed, "the desktop placed it").not.toBeNull();
    expect(ed.state.doc.textBetween(placed.from, placed.to, " ").replace(/\s+/g, " ")).toBe(words.replace(/\s+/g, " "));
    // The same repeat, not just the same words: count the ones before it.
    const desktopText = ed.state.doc.textBetween(0, placed.from, "\n");
    const first = words.split("\n")[0];
    expect(desktopText.split(first).length - 1).toBe(nth);
    // And the phone, reading the thread back, highlights where it was made.
    expect(locateQuote(flat.text, quoteOf(anchor)!)).toEqual(spanOf(flat.text, words, nth));
  });

  it("goes the other way: a comment made in the desktop's room is placed on the reading screen", () => {
    const { editor: ed } = desktop();
    let from = -1;
    ed.state.doc.descendants((node, pos) => {
      if (from === -1 && node.isText && node.text!.includes("Fix the exporter")) from = pos + node.text!.indexOf("Fix the exporter");
    });
    const anchor = JSON.parse(JSON.stringify(selectionToAnchor(ed, from, from + "Fix the exporter".length)));
    const flat = flattenDom(article());
    const range = locateQuote(flat.text, quoteOf(anchor)!)!;
    expect(flat.text.slice(range.start, range.end)).toBe("Fix the exporter");
  });

  it("is unplaced on the desktop once the sentence is rewritten, and says which words it was on", () => {
    const anchor = anchorFor(article(), "Hosting doubled");
    const { editor: ed, ydoc } = desktop(MARKDOWN.replace("Hosting doubled.", "Costs went up."));
    expect(anchorToAbsolute(ed, ydoc, anchor)).toBeNull();
    expect(quoteOf(anchor)!.exact).toBe("Hosting doubled");
  });
});

// ── The screen ────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;
async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) await act(async () => { await Promise.resolve(); });
}
async function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  await settle();
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  vi.useRealTimers();
});

function comment(id: string, body: string, who = "Carol", email = "carol@example.com") {
  return { id, authorId: `u-${who}`, authorName: who, authorEmail: email, body, createdAt: "2026-11-20T10:00:00Z" };
}

interface Seat { role: "owner" | "editor" | "viewer"; threads: unknown[]; format?: string; name?: string; publicToken?: string | null; members?: unknown[] }

function fakeApi(seat: Seat) {
  const doc = {
    id: "doc-1", name: seat.name ?? "Plan.md", format: seat.format ?? "markdown", content: MARKDOWN, version: 3, role: seat.role,
    publicToken: seat.publicToken ?? null, privateLink: "https://markiedocs.com/d/doc-1", updatedAt: "2026-11-20T09:00:00Z", origin: { kind: "app", agent: null },
  };
  const state = { threads: seat.threads };
  const api = {
    origin: "https://api.markiedocs.com",
    doc: vi.fn(async () => doc),
    docLinks: vi.fn(async () => new Map()),
    shares: vi.fn(async () => seat.members ?? [{ userId: "u2", email: "carol@example.com", name: "Carol", role: "viewer", pending: false }]),
    publicLink: vi.fn(async () => null),
    docTheme: vi.fn(async () => null),
    asset: vi.fn(async () => null),
    threads: vi.fn(async () => state.threads),
    createThread: vi.fn(async (_id: string, anchor: unknown, body: string) => {
      state.threads = [...state.threads, { id: "t-new", anchor, status: "open", createdBy: "u-Carol", createdAt: "", comments: [comment("c-new", body)] }];
      return "t-new";
    }),
    reply: vi.fn(async () => undefined),
    setThreadStatus: vi.fn(async () => undefined),
    deleteComment: vi.fn(async () => undefined),
  };
  return { api, state };
}

async function screen(seat: Seat, me = { email: "carol@example.com", name: "Carol" }, linkedThread?: string) {
  const { DocumentScreen } = await import("../src/screens/document");
  const fake = fakeApi(seat);
  const onRecent = vi.fn();
  const page = await mount(createElement(DocumentScreen, {
    api: fake.api as never, target: { kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com", ...(linkedThread ? { thread: linkedThread } : {}) } as never,
    backLabel: "Recent", tone: "light" as never, onBack: () => {}, onRecent, onOpen: () => {}, onEdit: () => {},
    me, onUnauthorized: () => {},
  }));
  return { page, onRecent, ...fake };
}

function thread(id: string, anchor: unknown, body: string, status = "open") {
  return { id, anchor, status, createdBy: "u-Kirby", createdAt: "2026-11-20T10:00:00Z", comments: [comment(`c-${id}`, body, "Kirby", "kirby@example.com")] };
}

function tap(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(field: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectWords(page: HTMLElement, words: string) {
  const body = page.querySelector(".markdown-body")!;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  while (walker.nextNode()) {
    if ((walker.currentNode as Text).data.includes(words)) { node = walker.currentNode as Text; break; }
  }
  expect(node, `"${words}" is in one text node`).not.toBeNull();
  const range = document.createRange();
  range.setStart(node!, node!.data.indexOf(words));
  range.setEnd(node!, node!.data.indexOf(words) + words.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await act(async () => { await new Promise((done) => setTimeout(done, 160)); });
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("the reading screen", () => {
  it("shows a viewer the open threads on their words, with a count, and no live room", async () => {
    const seed = article();
    const threads = [
      thread("t1", anchorFor(seed, "The budget is tight", 1), "Is this still true?"),
      thread("t2", anchorFor(seed, "Fix the importer"), "Done last week.", "resolved"),
    ];
    seed.remove();
    const { page, api } = await screen({ role: "viewer", threads });
    const button = page.querySelector<HTMLElement>('button[aria-label="Comments, 1 open"]')!;
    expect(button).not.toBeNull();
    expect(button.querySelector(".m-nav-badge")?.textContent).toBe("1");
    const marks = Array.from(page.querySelectorAll('mark[data-comment-thread="t1"]'));
    expect(marks.map((mark) => mark.textContent).join("")).toBe("The budget is tight");
    expect(marks[0].closest("li")?.textContent).toContain("because of it");
    // A resolved thread is found but not highlighted.
    expect(page.querySelector('mark[data-comment-thread="t2"]')).toBeNull();
    expect("collabTicket" in api).toBe(false);

    tap(button);
    const card = sheet()!.querySelector('[data-thread="t1"]')!;
    expect(card.querySelector(".m-comment-quote-link")?.textContent).toBe("The budget is tight");
    expect(card.textContent).toContain("Is this still true?");
    // A viewer replies but does not resolve.
    expect(card.querySelector("textarea")).not.toBeNull();
    expect(Array.from(card.querySelectorAll("button")).some((b) => b.textContent === "Resolve")).toBe(false);
  });

  it("lists a thread whose words are gone, and one from before quotes, as not placed", async () => {
    const threads = [
      thread("t1", quoteAnchor({ exact: "a sentence since deleted", prefix: "Before ", suffix: " after", approxIndex: 40 }), "What happened to this?"),
      thread("t2", { from: { item: { client: 1, clock: 2 } }, to: { item: { client: 1, clock: 9 } } }, "Old live comment."),
    ];
    const { page } = await screen({ role: "editor", threads });
    expect(page.querySelectorAll("mark[data-comment-thread]").length).toBe(0);
    tap(page.querySelector('button[aria-label="Comments, 2 open"]')!);
    const gone = sheet()!.querySelector('[data-thread="t1"] [data-unplaced]')!;
    expect(gone.textContent).toContain("Not placed");
    expect(gone.textContent).toContain("a sentence since deleted");
    expect(gone.textContent).toContain("These words are no longer in the document.");
    const old = sheet()!.querySelector('[data-thread="t2"] [data-unplaced]')!;
    expect(old.textContent).toContain("Not placed");
    expect(old.textContent).toContain("Its place shows when the document is open for editing.");
    // Both can still be answered, and an editor can resolve them.
    expect(sheet()!.querySelectorAll("textarea").length).toBe(2);
    expect(sheet()!.textContent).toContain("Resolve");
  });

  it("starts a thread on the selected words, with an anchor the desktop can place", async () => {
    const { page, api } = await screen({ role: "viewer", threads: [] });
    expect(page.querySelector(".m-select-comment")).toBeNull();
    await selectWords(page, "Hosting doubled");
    tap(page.querySelector(".m-select-comment")!);
    expect(sheet()!.querySelector("blockquote")?.textContent).toBe("Hosting doubled");
    await type(sheet()!.querySelector("textarea")!, "By how much?");
    await act(async () => { sheet()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(api.createThread).toHaveBeenCalledTimes(1);
    const [docId, anchor, body] = api.createThread.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(docId).toBe("doc-1");
    expect(body).toBe("By how much?");
    expect(anchor).toMatchObject({ kind: "quote", exact: "Hosting doubled", from: { tname: "default", assoc: -1 }, to: { tname: "default", assoc: -1 } });
    expect(String(anchor.suffix).startsWith(". The budget is tight because")).toBe(true);
    // The new thread is highlighted as soon as the list comes back.
    expect(page.querySelector('mark[data-comment-thread="t-new"]')?.textContent).toBe("Hosting doubled");
    expect(page.querySelector('button[aria-label="Comments, 1 open"]')).not.toBeNull();
  });

  it("opens the thread a tapped highlight belongs to", async () => {
    const seed = article();
    const threads = [thread("t1", anchorFor(seed, "Fix the exporter"), "Which exporter?")];
    seed.remove();
    const { page } = await screen({ role: "viewer", threads });
    window.getSelection()?.removeAllRanges();
    tap(page.querySelector('mark[data-comment-thread="t1"]')!);
    expect(sheet()!.querySelector('[data-thread="t1"]')?.classList.contains("is-shown")).toBe(true);
  });

  it("lets you delete your own comment, known by your address", async () => {
    const mine = { ...thread("t1", quoteAnchor({ exact: "Risks", prefix: "", suffix: "", approxIndex: 0 }), "x"), comments: [comment("c1", "Mine"), comment("c2", "Theirs", "Kirby", "kirby@example.com")] };
    const { page, api } = await screen({ role: "viewer", threads: [mine] }, { email: "Carol@Example.com", name: "Carol" });
    tap(page.querySelector('button[aria-label^="Comments"]')!);
    const deletes = Array.from(sheet()!.querySelectorAll(".m-comment-delete"));
    expect(deletes.map((b) => b.getAttribute("aria-label"))).toEqual(["Delete Carol's comment"]);
    await act(async () => { (deletes[0] as HTMLElement).click(); });
    await settle();
    expect(api.deleteComment).toHaveBeenCalledWith("doc-1", "t1", "c1");
  });

  it("says access is gone when a reply is refused, and takes the text off the screen", async () => {
    const seed = article();
    const threads = [thread("t1", anchorFor(seed, "Hosting doubled"), "By how much?")];
    seed.remove();
    const { page, api, onRecent } = await screen({ role: "viewer", threads });
    tap(page.querySelector('button[aria-label^="Comments"]')!);
    // The owner removes the share. The next thing this reader does is reply.
    api.reply.mockRejectedValue(new ApiError(403, "forbidden"));
    api.doc.mockRejectedValue(new ApiError(404, "not found"));
    api.threads.mockRejectedValue(new ApiError(403, "forbidden"));
    await type(sheet()!.querySelector("textarea")!, "Twice.");
    await act(async () => { sheet()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    const lost = sheet()!.querySelector("[data-access-lost]")!;
    expect(lost.textContent).toContain("You no longer have access");
    expect(sheet()!.querySelector(".m-spinner")).toBeNull();
    expect(sheet()!.querySelector("textarea")).toBeNull();
    tap(Array.from(lost.querySelectorAll("button")).find((b) => b.textContent === "Close")!);
    expect(sheet()).toBeNull();
    expect(page.querySelector(".markdown-body")).toBeNull();
    expect(page.querySelector("[data-access-lost]")?.textContent).toContain("You no longer have access");
    expect(page.querySelector('button[aria-label^="Comments"]')).toBeNull();
    tap(Array.from(page.querySelectorAll("[data-access-lost] button")).find((b) => b.textContent === "Back to Recent")!);
    expect(onRecent).toHaveBeenCalled();
  });

  it("does not call a refused resolve lost access when the document still opens", async () => {
    const { page, api } = await screen({ role: "editor", threads: [thread("t1", quoteAnchor({ exact: "Risks", prefix: "", suffix: "", approxIndex: 0 }), "x")] });
    tap(page.querySelector('button[aria-label^="Comments"]')!);
    api.setThreadStatus.mockRejectedValue(new ApiError(403, "forbidden"));
    await act(async () => { Array.from(sheet()!.querySelectorAll("button")).find((b) => b.textContent === "Resolve")!.click(); });
    await settle();
    expect(sheet()!.querySelector("[data-access-lost]")).toBeNull();
    expect(sheet()!.querySelector('[role="alert"]')?.textContent).toBe("You can't do that on this document any more.");
    expect(page.querySelector(".markdown-body")).not.toBeNull();
  });

  it("gives a viewer a way to follow the document live, where an editor has the pencil", async () => {
    const { DocumentScreen } = await import("../src/screens/document");
    const at = async (role: Seat["role"], extra: Partial<Seat> = {}) => {
      const fake = fakeApi({ role, threads: [], ...extra });
      const onEdit = vi.fn();
      const page = await mount(createElement(DocumentScreen, {
        api: fake.api as never, target: { kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com" } as never,
        backLabel: "Recent", tone: "light" as never, onBack: () => {}, onRecent: () => {}, onOpen: () => {}, onEdit,
        me: { email: "carol@example.com", name: "Carol" }, onUnauthorized: () => {},
      }));
      return { page, onEdit };
    };
    const viewer = await at("viewer");
    expect(viewer.page.querySelector('[aria-label="Edit"]')).toBeNull();
    const follow = viewer.page.querySelector('[aria-label="Follow live"]')!;
    expect(follow).not.toBeNull();
    tap(follow);
    // The same door as Edit: the app opens the live document, which is read-only for a viewer.
    expect(viewer.onEdit).toHaveBeenCalledTimes(1);
    expect(viewer.onEdit.mock.calls[0][0]).toMatchObject({ id: "doc-1", role: "viewer" });
    act(() => root?.unmount()); host?.remove();
    const editor = await at("editor");
    expect(editor.page.querySelector('[aria-label="Edit"]')).not.toBeNull();
    expect(editor.page.querySelector('[aria-label="Follow live"]')).toBeNull();
    act(() => root?.unmount()); host?.remove();
    // Nothing is live about a Live Doc's source or a public link.
    const wd = await at("viewer", { format: "darkmown", name: "Counter.wd" });
    expect(wd.page.querySelector('[aria-label="Follow live"]')).toBeNull();
  });

  it("offers no comments on a text file, a public link, or the owner's own unshared document", async () => {
    const text = await screen({ role: "viewer", threads: [], format: "text", name: "notes.txt" });
    expect(text.page.querySelector('button[aria-label^="Comments"]')).toBeNull();
    expect(text.api.threads).not.toHaveBeenCalled();
    expect(text.page.textContent).not.toMatch(/comment/i);
    act(() => root?.unmount());

    const open = await screen({ role: "viewer", threads: [], publicToken: "tok" });
    expect(open.page.querySelector('button[aria-label^="Comments"]')).toBeNull();
    act(() => root?.unmount());

    const alone = await screen({ role: "owner", threads: [], members: [] });
    expect(alone.page.querySelector('button[aria-label^="Comments"]')).toBeNull();
    await selectWords(alone.page, "Hosting doubled");
    expect(alone.page.querySelector(".m-select-comment")).toBeNull();
  });
});

describe("a tapped notification's thread", () => {
  const seat = (): Seat => {
    const seed = article();
    const threads = [
      thread("t1", anchorFor(seed, "The budget is tight", 1), "Is this still true?"),
      thread("t2", anchorFor(seed, "Fix the importer"), "Done last week.", "resolved"),
    ];
    seed.remove();
    return { role: "viewer", threads };
  };

  it("opens the Comments sheet on that thread", async () => {
    await screen(seat(), undefined, "t1");
    expect(sheet()).not.toBeNull();
    expect(sheet()!.querySelector('[data-thread="t1"]')?.classList.contains("is-shown")).toBe(true);
  });

  it("shows a thread that was resolved since, instead of hiding it", async () => {
    await screen(seat(), undefined, "t2");
    await settle();
    expect(sheet()!.querySelector('[data-thread="t2"]')?.textContent).toContain("Done last week.");
  });

  it("opens the document and nothing else when the thread is not one of its own", async () => {
    const { page } = await screen(seat(), undefined, "no-such-thread");
    expect(sheet()).toBeNull();
    expect(page.querySelector(".markdown-body")?.textContent).toContain("The budget is tight");
  });

  it("moves to another thread when a second notification names one, with the document already open", async () => {
    // app.tsx hands the open screen the new link (lib/doc-stack.ts "retarget").
    const { DocumentScreen } = await import("../src/screens/document");
    const fake = fakeApi(seat());
    const props = (thread: string) => ({
      api: fake.api as never, target: { kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com", thread } as never,
      backLabel: "Recent", tone: "light" as never, onBack: () => {}, onRecent: () => {}, onOpen: () => {}, onEdit: () => {},
      me: { email: "carol@example.com", name: "Carol" }, onUnauthorized: () => {},
    });
    await mount(createElement(DocumentScreen, props("t1")));
    expect(sheet()!.querySelector('[data-thread="t1"]')?.classList.contains("is-shown")).toBe(true);
    await act(async () => { root!.render(createElement(DocumentScreen, props("t2"))); });
    await settle();
    expect(sheet()).not.toBeNull();
    expect(sheet()!.querySelector('[data-thread="t2"]')?.classList.contains("is-shown")).toBe(true);
    expect(sheet()!.querySelector('[data-thread="t1"]')?.classList.contains("is-shown")).toBe(false);
    // One screen, one document: nothing was stacked or fetched as a second copy.
    expect(document.querySelectorAll(".markdown-body")).toHaveLength(1);
  });

  it("opens nothing without a thread in the link", async () => {
    await screen(seat());
    expect(sheet()).toBeNull();
  });
});
