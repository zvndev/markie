import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { probeReconstruction } from "@/lib/rich-roundtrip";
import { bareEmbedLink, clearEmbedPreviews } from "@/lib/rich-embed";
import { setLinkPreviewsEnabled } from "@/lib/link-previews";
import { installBridge } from "@/test/mock-bridge";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImageLightbox } from "@/components/image-lightbox";
import { OPEN_VIDEO_VIEWER } from "@/lib/media-viewer-events";
import userEvent from "@testing-library/user-event";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// The real extension list, mounted, so node views are built the way the rich
// pane builds them.
const host = document.createElement("div");
host.className = "markdown-body";
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
  render(<ImageLightbox container={host} openOn="dblclick" />);
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
    fireEvent.click(card()!);
    const frame = screen.getByRole("dialog").querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"
    );
    expect(frame!.getAttribute("allow")).toContain("fullscreen");
    expect(card()).not.toBeNull();
    expect(host.querySelector("iframe")).toBeNull();
    // Opening the player is not an edit.
    expect(markdownOf()).toBe(YT);
  });

  it("closes the player on outside interaction, restores its card and leaves the source unchanged", () => {
    load(YT);
    const button = card()!;
    fireEvent.click(button);
    const frame = screen.getByRole("dialog").querySelector("iframe")!;
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(frame.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(markdownOf()).toBe(YT);
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops an open player when its document is replaced", async () => {
    load(YT);
    fireEvent.click(card()!);
    const frame = screen.getByRole("dialog").querySelector("iframe")!;
    load("Another document.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(frame.isConnected).toBe(false);
    expect(markdownOf()).toBe("Another document.");
  });

  it("ignores a forged provider address rather than opening an arbitrary frame", () => {
    load(YT);
    fireEvent(card()!, new CustomEvent(OPEN_VIDEO_VIEWER, { bubbles: true, detail: { url: "https://evil.test/frame" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent(card()!, new CustomEvent(OPEN_VIDEO_VIEWER, { bubbles: true, detail: { url: "https://vimeo.com/148751763" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a running viewer open when view-only card text changes", async () => {
    load(YT);
    fireEvent.click(card()!);
    host.querySelector(".markie-embed-title")!.textContent = "A late title";
    await waitFor(() => expect(card()!.textContent).toContain("A late title"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("expands a local clip with a discoverable button without serializing viewer controls", () => {
    const md = "![clip](demo/clip.mp4)";
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    load(md);
    const button = screen.getByRole("button", { name: "Expand video" });
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Video" }).querySelector("video")).toHaveAttribute("src", "demo/clip.mp4");
    expect(markdownOf()).toBe(md);
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(markdownOf()).toBe(md);
    pause.mockRestore();
  });

  it("keeps keyboard Play and Expand activation out of the editor's Enter keymap", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    for (const md of [YT, "![clip](demo/clip.mp4)"]) {
      load(md);
      const button = host.querySelector("button")!;
      button.focus();
      expect(document.activeElement).toBe(button);
      await userEvent.keyboard("{Enter}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(markdownOf()).toBe(md);
      fireEvent.keyDown(window, { key: "Escape" });
    }
    pause.mockRestore();
  });

  it("waits for deliberate hover before asking main for a safe title and inline thumbnail", async () => {
    const image = "data:image/png;base64,aGVsbG8=";
    const linkPreview = vi.fn(async () => ({
      url: YT,
      title: "Never Gonna Give You Up",
      description: null,
      siteName: "YouTube",
      image,
    }));
    installBridge({ linkPreview } as never);
    load(YT);
    const thumb = host.querySelector<HTMLImageElement>(".markie-embed-thumb")!;
    expect(thumb.getAttribute("src")).toBeNull();
    expect(linkPreview).not.toHaveBeenCalled();
    fireEvent.mouseEnter(card()!);
    expect(linkPreview).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(linkPreview).toHaveBeenCalledWith(YT));
    await vi.waitFor(() =>
      expect(host.querySelector(".markie-embed-title")!.textContent).toBe("Never Gonna Give You Up")
    );
    expect(thumb.getAttribute("src")).toBe(image);
  });

  it("does not request metadata or a direct thumbnail just from opening a document", async () => {
    const linkPreview = vi.fn(async () => null);
    installBridge({ linkPreview } as never);
    load(YT);
    await new Promise((resolve) => setTimeout(resolve, 480));
    expect(linkPreview).not.toHaveBeenCalled();
    expect(host.querySelector("img")!.getAttribute("src")).toBeNull();
  });

  it("cancels a brief hover and never fetches with previews off", async () => {
    const linkPreview = vi.fn(async () => null);
    installBridge({ linkPreview } as never);
    load(YT);
    fireEvent.mouseEnter(card()!);
    fireEvent.mouseLeave(card()!);
    await new Promise((resolve) => setTimeout(resolve, 480));
    expect(linkPreview).not.toHaveBeenCalled();
    setLinkPreviewsEnabled(false);
    fireEvent.mouseEnter(card()!);
    await new Promise((resolve) => setTimeout(resolve, 480));
    expect(linkPreview).not.toHaveBeenCalled();
  });

  it("ignores a result after previews are disabled and never loads an unguarded remote image", async () => {
    let finish!: (value: { url: string; title: string; description: null; siteName: null; image: string }) => void;
    const linkPreview = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    installBridge({ linkPreview } as never);
    load(YT);
    fireEvent.mouseEnter(card()!);
    await vi.waitFor(() => expect(linkPreview).toHaveBeenCalledWith(YT));
    setLinkPreviewsEnabled(false);
    finish({ url: YT, title: "Late private preview", description: null, siteName: null, image: "https://tracking.test/pixel.png" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(card()!.textContent).not.toContain("Late private preview");
    expect(host.querySelector("img")!.getAttribute("src")).toBeNull();
  });

  it("cancels pending hover on document disposal and inactivity", async () => {
    const linkPreview = vi.fn(async () => null);
    installBridge({ linkPreview } as never);
    load(YT);
    fireEvent.mouseEnter(card()!);
    load("Another file.");
    await new Promise((resolve) => setTimeout(resolve, 480));
    expect(linkPreview).not.toHaveBeenCalled();
    load(YT);
    fireEvent.mouseEnter(card()!);
    host.setAttribute("inert", "");
    await new Promise((resolve) => setTimeout(resolve, 480));
    host.removeAttribute("inert");
    expect(linkPreview).not.toHaveBeenCalled();
  });

  it("rejects remote image metadata even after a valid deliberate preview request", async () => {
    const linkPreview = vi.fn(async () => ({ url: YT, title: "Safe text", description: null, siteName: null, image: "https://tracking.test/pixel.png" }));
    installBridge({ linkPreview } as never);
    load(YT);
    fireEvent.focus(card()!);
    await vi.waitFor(() => expect(card()!.textContent).toContain("Safe text"));
    expect(host.querySelector("img")!.getAttribute("src")).toBeNull();
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
