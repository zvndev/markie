import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import {
  readRichSections,
  RichSectionRail,
  SectionRail,
  SourceSectionRail,
} from "@/components/section-rail";
import { NIGHTLY_STORAGE_KEY } from "@/lib/nightly";
import type { Section } from "@/lib/section-outline";

// jsdom has no layout: give a scroller the sizes a long document would have.
function makeScroller({ clientHeight = 600, scrollHeight = 3000 } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  document.body.appendChild(el);
  return el;
}

const SECTIONS: Section[] = [
  { level: 1, text: "Overview", snippet: "What this is about." },
  { level: 2, text: "Install", snippet: "Run the installer." },
  { level: 3, text: "Options", snippet: "" },
  { level: 2, text: "Usage", snippet: "Open a file and read it." },
];
const TOPS = [0, 700, 1400, 2100];

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("SectionRail", () => {
  it("shows one labelled tick per section, longest for H1", () => {
    const scroller = makeScroller();
    render(<SectionRail sections={SECTIONS} scroller={scroller} measure={() => TOPS} onSelect={() => {}} placement="overlay" />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    const ticks = Array.from(nav.querySelectorAll("button"));
    expect(ticks.map((b) => b.getAttribute("aria-label"))).toEqual(["Overview", "Install", "Options", "Usage"]);
    const widths = ticks.map((b) => parseFloat((b.firstElementChild as HTMLElement).style.width));
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
  });

  it("stays hidden for a short document or fewer than three headings", () => {
    const short = makeScroller({ clientHeight: 600, scrollHeight: 800 });
    const { unmount } = render(
      <SectionRail sections={SECTIONS} scroller={short} measure={() => TOPS} onSelect={() => {}} placement="overlay" />
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    unmount();
    render(
      <SectionRail sections={SECTIONS.slice(0, 2)} scroller={makeScroller()} measure={() => TOPS} onSelect={() => {}} placement="overlay" />
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("highlights the section on screen and follows the scroll", async () => {
    const scroller = makeScroller();
    render(<SectionRail sections={SECTIONS} scroller={scroller} measure={() => TOPS} onSelect={() => {}} placement="overlay" />);
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "location");

    scroller.scrollTop = 1450;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByRole("button", { name: "Options" })).toHaveAttribute("aria-current", "location"));
    expect(screen.getByRole("button", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("shows the heading and the start of its section on hover", () => {
    render(<SectionRail sections={SECTIONS} scroller={makeScroller()} measure={() => TOPS} onSelect={() => {}} placement="overlay" />);
    const tick = screen.getByRole("button", { name: "Install" });
    fireEvent.mouseEnter(tick);
    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("Install");
    expect(card).toHaveTextContent("Run the installer.");
    expect(tick).toHaveAttribute("aria-describedby", card.id);

    fireEvent.mouseLeave(screen.getByRole("navigation"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("selects the section on click and lights its tick straight away", async () => {
    const onSelect = vi.fn();
    render(<SectionRail sections={SECTIONS} scroller={makeScroller()} measure={() => TOPS} onSelect={onSelect} placement="overlay" />);
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(onSelect).toHaveBeenCalledWith(3);
    await waitFor(() => expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-current", "location"));
  });

  it("is one tab stop, walked with the arrow keys, and Escape hides the card", () => {
    render(<SectionRail sections={SECTIONS} scroller={makeScroller()} measure={() => TOPS} onSelect={() => {}} placement="column" />);
    const ticks = screen.getAllByRole("button");
    expect(ticks.filter((b) => b.tabIndex === 0)).toHaveLength(1);

    act(() => ticks[0].focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Overview");
    fireEvent.keyDown(ticks[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks[1]);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Install");
    fireEvent.keyDown(ticks[1], { key: "End" });
    expect(document.activeElement).toBe(ticks[3]);
    fireEvent.keyDown(ticks[3], { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("readRichSections", () => {
  it("reads top-level H1 to H3 with a preview that skips code and runs to the next heading at its level", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<h2>Title</h2><p>Intro <strong>text</strong>.</p><pre>code()</pre><ul><li>item</li></ul>",
      "<h4>Small</h4><p>more</p>",
      "<h2>Part</h2><blockquote><h2>quoted, not a section</h2></blockquote>",
      "<h3></h3><h3>Same</h3><h3>Same</h3>",
    ].join("");
    const { sections, headings } = readRichSections(root);
    expect(sections).toEqual([
      { level: 2, text: "Title", snippet: "Intro text. item Small more" },
      { level: 2, text: "Part", snippet: "quoted, not a section Same Same" },
      { level: 3, text: "Same", snippet: "" },
      { level: 3, text: "Same", snippet: "" },
    ]);
    expect(headings).toHaveLength(4);
  });
});

function fakeEditor(dom: HTMLElement) {
  const handlers = new Set<(e: { transaction: { docChanged: boolean } }) => void>();
  return {
    editor: {
      isDestroyed: false,
      view: { dom },
      on: (_: string, fn: (e: { transaction: { docChanged: boolean } }) => void) => handlers.add(fn),
      off: (_: string, fn: (e: { transaction: { docChanged: boolean } }) => void) => handlers.delete(fn),
    } as unknown as Editor,
    change: () => handlers.forEach((fn) => fn({ transaction: { docChanged: true } })),
  };
}

describe("RichSectionRail", () => {
  let dom: HTMLElement;
  beforeEach(() => {
    const scroller = makeScroller();
    scroller.className = "markie-document-scroll";
    dom = document.createElement("div");
    dom.innerHTML = "<h1>One</h1><p>a</p><h2>Two</h2><p>b</p><h2>Three</h2><p>c</p>";
    scroller.appendChild(dom);
  });

  it("renders nothing outside the super-nightly build", () => {
    const { editor } = fakeEditor(dom);
    render(<RichSectionRail editor={editor} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("reads the editor's headings and rereads them after an edit", async () => {
    localStorage.setItem(NIGHTLY_STORAGE_KEY, "1");
    const { editor, change } = fakeEditor(dom);
    render(<RichSectionRail editor={editor} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["One", "Two", "Three"]);

    dom.insertAdjacentHTML("beforeend", "<h3>Four</h3>");
    change();
    await waitFor(() => expect(screen.getByRole("button", { name: "Four" })).toBeInTheDocument());
  });
});

describe("SourceSectionRail", () => {
  const md = ["---", "title: x", "---", "# One", "text", "```", "# not a heading", "```", "## Two", "Three", "-----", "body"].join("\n");

  it("renders nothing outside the super-nightly build", () => {
    render(<SourceSectionRail markdown={md} scroller={makeScroller()} lineTop={(l) => l * 20} scrollToLine={() => {}} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("takes headings from the markdown and scrolls to the heading's line", () => {
    localStorage.setItem(NIGHTLY_STORAGE_KEY, "1");
    const scrollToLine = vi.fn();
    render(<SourceSectionRail markdown={md} scroller={makeScroller()} lineTop={(l) => l * 20} scrollToLine={scrollToLine} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["One", "Two", "Three"]);
    fireEvent.click(screen.getByRole("button", { name: "Three" }));
    expect(scrollToLine).toHaveBeenCalledWith(9);
  });
});
