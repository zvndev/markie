// Plain <img> on purpose: this is the DOM the rich pane produces, not a page.
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImageLightbox, collectImages } from "./image-lightbox";
import { installBridge } from "@/test/mock-bridge";
import { CLOSE_MEDIA_VIEWER_COMMAND } from "@/lib/media-viewer-events";
import { act } from "react";

// A document with three pictures, one of them a link, plus a video, the way
// the rich pane lays them out: everything under one `.markdown-body`.
function Harness({ openOn }: { openOn: "click" | "dblclick" }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setEl}>
      <article className="markdown-body" tabIndex={0} data-testid="doc">
        <p>
          <img src="a.png" alt="first" />
        </p>
        <p>
          <img src="b.png" alt="second" />
        </p>
        <p>
          <a href="https://example.com">
            <img src="linked.png" alt="linked" />
          </a>
        </p>
        <p>
          <video src="clip.mp4" data-testid="clip" />
        </p>
        <p>
          <img src="c.png" alt="" />
        </p>
      </article>
      <ImageLightbox container={el} openOn={openOn} />
    </div>
  );
}

const shown = () => screen.getByRole("dialog").querySelector("img")!.getAttribute("src");

describe("collecting the document's pictures", () => {
  it("takes every picture in reading order, and no link or clip", () => {
    render(<Harness openOn="dblclick" />);
    expect(collectImages(document).map((i) => i.src)).toEqual(["a.png", "b.png", "c.png"]);
  });
});

describe("opening", () => {
  it("opens on a double-click while editing, on the picture that was clicked", () => {
    render(<Harness openOn="dblclick" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.dblClick(screen.getByAltText("second"));
    expect(shown()).toBe("b.png");
    expect(screen.getByRole("dialog")).toHaveTextContent("2 / 3");
    expect(screen.getByRole("dialog")).toHaveTextContent("second");
  });

  it("does not open on a single click while editing", () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.click(screen.getByAltText("second"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on a single click when the document is read-only", () => {
    render(<Harness openOn="click" />);
    fireEvent.click(screen.getByAltText("first"));
    expect(shown()).toBe("a.png");
  });

  it("leaves a picture inside a link to the link", () => {
    render(<Harness openOn="click" />);
    fireEvent.click(screen.getByAltText("linked"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves a modified click alone", () => {
    render(<Harness openOn="click" />);
    fireEvent.click(screen.getByAltText("first"), { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a click that is not on a picture", () => {
    render(<Harness openOn="click" />);
    fireEvent.click(screen.getByTestId("clip"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("moving through the pictures", () => {
  it("walks forward and back with the arrow keys and stops at the ends", () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    expect(shown()).toBe("a.png");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(shown()).toBe("b.png");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(shown()).toBe("c.png");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(shown()).toBe("c.png");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(shown()).toBe("b.png");
  });

  it("has buttons for the same thing, greyed at the ends", async () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    const prev = screen.getByRole("button", { name: "Previous picture" });
    const next = screen.getByRole("button", { name: "Next picture" });
    expect(prev).toBeDisabled();
    await userEvent.click(next);
    expect(shown()).toBe("b.png");
    expect(prev).toBeEnabled();
    await userEvent.click(next);
    expect(next).toBeDisabled();
  });

  it("keeps the arrows away from the editor underneath", () => {
    render(<Harness openOn="dblclick" />);
    let reachedDocument = 0;
    window.addEventListener("keydown", () => (reachedDocument += 1));
    fireEvent.dblClick(screen.getByAltText("first"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // The viewer listens in the capture phase and stops the event there, so
    // a bubble-phase listener, like the editor's keymap, never sees it.
    expect(reachedDocument).toBe(0);
  });
});

describe("closing", () => {
  it("accepts only the native media-dismiss signal and unsubscribes when closed", () => {
    let command!: (value: string) => void;
    const unsubscribe = vi.fn();
    installBridge({ onDocumentCommand: (receive: typeof command) => { command = receive; return unsubscribe; } } as never);
    render(<Harness openOn="dblclick" />);
    const doc = screen.getByTestId("doc");
    doc.focus();
    fireEvent.dblClick(screen.getByAltText("first"));
    act(() => command("save"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => command(CLOSE_MEDIA_VIEWER_COMMAND));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(doc);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("renders above the document's clipping and interaction boundaries", () => {
    const view = render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    expect(view.container.contains(screen.getByRole("dialog"))).toBe(false);
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
  });

  it("dismisses on pointer interaction outside the image, without passing through to the document", () => {
    render(<Harness openOn="dblclick" />);
    const pressed = vi.fn();
    screen.getByTestId("doc").addEventListener("pointerdown", pressed);
    fireEvent.dblClick(screen.getByAltText("first"));
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pressed).not.toHaveBeenCalled();
  });

  it("does not keep a previous document's picture visible after the source canvas is replaced", async () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    screen.getByTestId("doc").replaceChildren();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the retained document becomes inactive", async () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    screen.getByTestId("doc").parentElement!.setAttribute("inert", "");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps Tab inside the viewer", () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    const close = screen.getByRole("button", { name: "Close picture" });
    const last = screen.getByRole("button", { name: "Next picture" });
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("expands a local video on double-click without stealing its single-click controls", async () => {
    render(<Harness openOn="click" />);
    const clip = screen.getByTestId("clip");
    (clip as HTMLVideoElement).currentTime = 12;
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    fireEvent.click(clip);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.dblClick(clip);
    const dialog = screen.getByRole("dialog", { name: "Video" });
    const video = dialog.querySelector("video")!;
    expect(video).toHaveAttribute("src", "clip.mp4");
    expect(video).toHaveAttribute("controls");
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(12);
    fireEvent.pointerDown(video);
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(video).not.toHaveAttribute("src");
    expect(pause).toHaveBeenCalled();
    pause.mockRestore();
  });

  it("stops expanded playback when the source video changes", async () => {
    render(<Harness openOn="dblclick" />);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const clip = screen.getByTestId("clip");
    fireEvent.dblClick(clip);
    const video = screen.getByRole("dialog").querySelector("video")!;
    clip.setAttribute("src", "another.mp4");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(video).not.toHaveAttribute("src");
    expect(pause).toHaveBeenCalled();
    pause.mockRestore();
  });

  it("closes on Escape and gives the keyboard back to the document", () => {
    render(<Harness openOn="dblclick" />);
    const doc = screen.getByTestId("doc");
    doc.focus();
    fireEvent.dblClick(screen.getByAltText("first"));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(doc);
  });

  it("closes on the close button and on the scrim, not on the picture", async () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    fireEvent.mouseDown(screen.getByRole("dialog").querySelector("img")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.dblClick(screen.getByAltText("first"));
    await userEvent.click(screen.getByRole("button", { name: "Close picture" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toggles between fitted and actual size on a click of the picture", async () => {
    render(<Harness openOn="dblclick" />);
    fireEvent.dblClick(screen.getByAltText("first"));
    const img = screen.getByRole("dialog").querySelector("img")!;
    expect(img.className).toContain("cursor-zoom-in");
    await userEvent.click(img);
    expect(img.className).toContain("cursor-zoom-out");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // A new picture starts fitted again; an actual-size view of the last one
    // says nothing about this one.
    expect(screen.getByRole("dialog").querySelector("img")!.className).toContain("cursor-zoom-in");
  });
});
