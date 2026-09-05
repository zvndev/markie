/* eslint-disable @next/next/no-img-element */
// Plain <img> on purpose: this is the DOM the rich pane produces, not a page.
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ImageLightbox, collectImages } from "./image-lightbox";

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
