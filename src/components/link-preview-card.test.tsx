import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("cancels a pending request immediately when the pointer leaves before the dwell threshold", async () => {
    vi.useFakeTimers();
    try {
      const { linkPreview } = mount(), link = screen.getByText("a link");
      fireEvent.mouseOver(link);
      act(() => { vi.advanceTimersByTime(449); });
      fireEvent.mouseOut(link, { relatedTarget: document.body });
      await act(async () => { vi.advanceTimersByTime(2); });
      expect(linkPreview).not.toHaveBeenCalled();
      // Returning during the card's grace period starts a fresh dwell, not a
      // request that inherits time spent on the previous hover.
      fireEvent.mouseOver(link);
      await act(async () => { vi.advanceTimersByTime(449); });
      expect(linkPreview).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(linkPreview).toHaveBeenCalledExactlyOnceWith(CARD.url);
    } finally { vi.useRealTimers(); }
  });

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
  it("is outside the document scroller and names the destination host", async () => {
    mount();
    await userEvent.hover(screen.getByText("a link"));
    const card = await screen.findByRole("tooltip");
    expect(card.parentElement).toBe(document.body);
    expect(card).toHaveTextContent("example.com");
    expect(card.querySelector("button")).toHaveClass("bg-surface");
  });

  it("supports keyboard focus and Escape without following the link", async () => {
    const { bridge } = mount();
    fireEvent.focusIn(screen.getByText("a link"));
    await screen.findByRole("tooltip");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it("hides immediately and asks for nothing further after its document becomes inert", async () => {
    const { linkPreview } = mount();
    const link = screen.getByText("a link");
    await userEvent.hover(link); await screen.findByRole("tooltip");
    await act(async () => { link.parentElement!.setAttribute("inert", ""); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(link);
    expect(linkPreview).toHaveBeenCalledOnce();
  });

  it("discards an old same-href response after the document identity changes", async () => {
    let answer: (value: typeof CARD) => void = () => {};
    const linkPreview = vi.fn(() => new Promise<typeof CARD>((resolve) => { answer = resolve; }));
    installBridge({ linkPreview });
    function Harness({ identity }: { identity: string }) {
      const [el, setEl] = useState<HTMLDivElement | null>(null);
      return <div ref={setEl}><a href={CARD.url}>a link</a><LinkPreviewCard container={el} documentKey={identity} /></div>;
    }
    const view = render(<Harness identity="first" />);
    await userEvent.hover(screen.getByText("a link"));
    await waitFor(() => expect(linkPreview).toHaveBeenCalledOnce());
    view.rerender(<Harness identity="second" />);
    await act(async () => { answer(CARD); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays reachable across the link-to-card gap and closes when previews are disabled", async () => {
    mount(); const link = screen.getByText("a link");
    await userEvent.hover(link); const card = await screen.findByRole("tooltip");
    fireEvent.mouseOut(link, { relatedTarget: document.body });
    fireEvent.mouseEnter(card);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(screen.getByRole("tooltip")).toBe(card);
    await act(async () => { setLinkPreviewsEnabled(false); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("removes a preview when the author changes the target in place", async () => {
    mount(); const link = screen.getByText("a link");
    await userEvent.hover(link); await screen.findByRole("tooltip");
    await act(async () => { link.setAttribute("href", "https://other.example.com"); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

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
    await screen.findByRole("tooltip");
    await userEvent.click(screen.getByRole("button", { name: "Open A page worth reading in default browser" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/post");
  });
});
