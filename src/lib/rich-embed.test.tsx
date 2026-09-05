import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { probeReconstruction } from "@/lib/rich-roundtrip";
import { bareEmbedLink, clearEmbedPreviews } from "@/lib/rich-embed";
import { setLinkPreviewsEnabled } from "@/lib/link-previews";
import { installBridge } from "@/test/mock-bridge";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// The real extension list, mounted, so node views are built the way the rich
// pane builds them.
const host = document.createElement("div");
document.body.appendChild(host);
const editor = new Editor({ element: host, extensions: richBaseExtensions({ collab: true }), content: "" });
afterAll(() => editor.destroy());

const markdownOf = () =>
  (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
const load = (md: string) => {
  editor.commands.setContent(md, { emitUpdate: false });
  return markdownOf();
};
const blocks = () => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.type.name));
  return out;
};

beforeEach(() => {
  localStorage.clear();
  clearEmbedPreviews();
  // A node view for the same address survives a setContent, the way an open
  // player survives an unrelated edit, so each test starts from nothing.
  editor.commands.setContent("", { emitUpdate: false });
});
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("reading a document", () => {
  it("turns a video link alone on its line into a card, and writes the line back as it was", () => {
    const md = `Before.\n\n${YT}\n\nAfter.`;
    expect(load(md)).toBe(md);
    expect(blocks()).toEqual(["paragraph", "embed", "paragraph"]);
  });

  it("leaves a link inside a sentence, and a link with its own words, as links", () => {
    for (const md of [
      `Watch ${YT} when you can.`,
      `[the talk](${YT})`,
      `${YT} is the one.`,
    ]) {
      load(md);
      expect(blocks(), md).toEqual(["paragraph"]);
    }
  });

  it("is a link for an address that is not a video", () => {
    load("https://example.com/watch?v=dQw4w9WgXcQ");
    expect(blocks()).toEqual(["paragraph"]);
  });

  it("makes one card per line, and keeps every line", () => {
    const md = `${YT}\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nhttps://vimeo.com/148751763`;
    expect(load(md)).toBe(md);
    // The trailing paragraph is StarterKit's: a document that ends in a card
    // still needs somewhere to type.
    expect(blocks()).toEqual(["embed", "embed", "embed", "paragraph"]);
  });

  it("reproduces a whole document byte for byte, so rich editing stays on", () => {
    const md = ["# Notes", "", "Some words.", "", YT, "", "- a list", "- after", ""].join("\n");
    expect(probeReconstruction(md)).toEqual({ clean: true, output: md });
  });

  it("reads the bare-link paragraph the way the parser sees it", () => {
    const p = document.createElement("p");
    p.innerHTML = `<a href="${YT}">${YT}</a>`;
    expect(bareEmbedLink(p)?.id).toBe("dQw4w9WgXcQ");
    p.innerHTML = `<a href="${YT}">the talk</a>`;
    expect(bareEmbedLink(p)).toBeNull();
    p.innerHTML = `see <a href="${YT}">${YT}</a>`;
    expect(bareEmbedLink(p)).toBeNull();
    p.innerHTML = `<a href="${YT}">${YT}</a><br>`;
    expect(bareEmbedLink(p)).toBeNull();
  });
});

describe("the card", () => {
  const card = () => host.querySelector<HTMLButtonElement>("[data-markie-embed-card]");

  it("is a play button with the address and the provider, and no player", () => {
    load(YT);
    const button = card();
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Play the video on YouTube");
    expect(button!.textContent).toContain(YT);
    expect(button!.textContent).toContain("YouTube");
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("opens the cookie-free player only when clicked", () => {
    load(YT);
    card()!.click();
    const frame = host.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"
    );
    expect(frame!.getAttribute("allow")).toContain("fullscreen");
    expect(card()).toBeNull();
    // Opening the player is not an edit.
    expect(markdownOf()).toBe(YT);
  });

  it("uses the provider's own thumbnail and asks main for the title, with previews on", async () => {
    const linkPreview = vi.fn(async () => ({
      url: YT,
      title: "Never Gonna Give You Up",
      description: null,
      siteName: "YouTube",
      image: null,
    }));
    installBridge({ linkPreview } as never);
    load(YT);
    const thumb = host.querySelector<HTMLImageElement>(".markie-embed-thumb")!;
    expect(thumb.getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    await vi.waitFor(() => expect(linkPreview).toHaveBeenCalledWith(YT));
    await vi.waitFor(() =>
      expect(host.querySelector(".markie-embed-title")!.textContent).toBe("Never Gonna Give You Up")
    );
  });

  it("asks nobody for anything with previews off", async () => {
    setLinkPreviewsEnabled(false);
    const linkPreview = vi.fn(async () => null);
    installBridge({ linkPreview } as never);
    load(YT);
    await new Promise((r) => setTimeout(r, 50));
    expect(linkPreview).not.toHaveBeenCalled();
    const thumb = host.querySelector<HTMLImageElement>(".markie-embed-thumb")!;
    expect(thumb.hidden).toBe(true);
    expect(thumb.getAttribute("src")).toBeNull();
    // Still a card you can play.
    expect(card()).not.toBeNull();
  });
});

describe("typing one", () => {
  it("turns the line into a card on Enter, with the caret on a fresh line below", () => {
    // Typed, not parsed: the address is plain text in its paragraph, which is
    // what the editor holds before the line is finished.
    editor.commands.setContent(`<p>Notes.</p>\n<p>${YT}</p>`, { emitUpdate: false });
    expect(blocks()).toEqual(["paragraph", "paragraph"]);
    // Put the caret at the very end of the address.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(blocks()).toEqual(["paragraph", "embed", "paragraph"]);
    expect(markdownOf()).toBe(`Notes.\n\n${YT}`);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.index(0)).toBe(2);
  });

  it("leaves Enter alone on any other line", () => {
    load("Just words.");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.keyboardShortcut("Enter");
    expect(blocks()).toEqual(["paragraph", "paragraph"]);
  });
});
