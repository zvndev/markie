import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { setLinkPreviewsEnabled } from "@/lib/link-previews";
import { LinkPreviewCard } from "./link-preview-card";

const CARD = {
  url: "https://example.com/post",
  title: "A page worth reading",
  description: "What the page is about, in one line.",
  siteName: "Example",
  image: null,
};

function mount(linkPreview = vi.fn(async () => CARD)) {
  const bridge = installBridge({ linkPreview } as never);
  function Harness() {
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    return (
      <div ref={setEl}>
        <a href="https://example.com/post">a link</a>
        <a href="notes.md">a local link</a>
        <LinkPreviewCard container={el} />
      </div>
    );
  }
  render(<Harness />);
  return { linkPreview, bridge };
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("hovering a link", () => {
  it("asks for nothing until the pointer rests on one", async () => {
    // The whole point: opening a document must not call out to every address
    // in it. Somebody else wrote the document.
    const { linkPreview } = mount();
    expect(linkPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the card for the link the pointer rested on", async () => {
    const { linkPreview } = mount();
    await userEvent.hover(screen.getByText("a link"));
    await waitFor(() => expect(linkPreview).toHaveBeenCalledWith("https://example.com/post"), {
      timeout: 3000,
    });
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent("A page worth reading");
    expect(card).toHaveTextContent("What the page is about");
    expect(card).toHaveTextContent("Example");
  });

  it("ignores a link that does not go out to the web", async () => {
    const { linkPreview } = mount();
    await userEvent.hover(screen.getByText("a local link"));
    await new Promise((r) => setTimeout(r, 700));
    expect(linkPreview).not.toHaveBeenCalled();
  });

  it("asks for nothing at all when the switch is off", async () => {
    setLinkPreviewsEnabled(false);
    const { linkPreview } = mount();
    await userEvent.hover(screen.getByText("a link"));
    await new Promise((r) => setTimeout(r, 700));
    expect(linkPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows nothing when the site has nothing to show", async () => {
    const { linkPreview } = mount(vi.fn(async () => null) as never);
    await userEvent.hover(screen.getByText("a link"));
    await waitFor(() => expect(linkPreview).toHaveBeenCalled(), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("takes the card away when the pointer leaves", async () => {
    mount();
    await userEvent.hover(screen.getByText("a link"));
    await screen.findByRole("tooltip");
    await userEvent.unhover(screen.getByText("a link"));
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull(), { timeout: 2000 });
  });
});

describe("the card is the link", () => {
  it("opens the page in the browser when clicked", async () => {
    const openExternal = vi.fn(async () => {});
    installBridge({ linkPreview: vi.fn(async () => CARD), openExternal } as never);
    function Harness() {
      const [el, setEl] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setEl}>
          <a href="https://example.com/post">a link</a>
          <LinkPreviewCard container={el} />
        </div>
      );
    }
    render(<Harness />);
    await userEvent.hover(screen.getByText("a link"));
    await userEvent.click(await screen.findByRole("tooltip"));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/post");
  });
});
