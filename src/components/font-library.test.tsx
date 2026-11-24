// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allFontChoices, CodeFontPicker, FontLibraryControls, FontPicker, LocalFontsPanel } from "./font-library";
import { LIBRARY_FAMILIES, findTypeface } from "@/lib/fonts/registry";
import { loadCodeFont } from "@/lib/fonts/code-font";
import { forgetLocalFonts } from "@/lib/fonts/local-fonts";
import { DOC_FONTS, fontStack, normalizeAppearance } from "@/lib/doc-appearance";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
  localStorage.clear();
  forgetLocalFonts();
  delete document.documentElement.dataset.docCodeFont;
});

describe("the font pickers", () => {
  it("shows every choice in its own face, under group headings", async () => {
    const user = userEvent.setup(), onChange = vi.fn();
    render(<FontPicker label="Body font" value="system" choices={allFontChoices()} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Body font: System" }));
    const menu = screen.getByRole("menu", { name: "Body font" });
    for (const group of ["System", "Sans serif", "Easy to read", "Rounded", "Serif", "With personality", "Monospace"]) {
      expect(within(menu).getByRole("group", { name: group })).toBeInTheDocument();
    }
    for (const family of LIBRARY_FAMILIES) {
      const item = within(menu).getByRole("menuitemradio", { name: family.family });
      // Drawn in itself: the label's own font is the family's stack.
      expect(item.querySelector("span")!.style.fontFamily.replace(/"/g, "'")).toBe(family.stack);
    }
    expect(within(within(menu).getByRole("group", { name: "Easy to read" })).getByRole("menuitemradio", { name: "Atkinson Hyperlegible Next" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitemradio", { name: "Literata" }));
    expect(onChange).toHaveBeenCalledWith("literata");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers only monospace faces for code and remembers the choice", async () => {
    const user = userEvent.setup();
    render(<CodeFontPicker />);
    await user.click(screen.getByRole("button", { name: "Code font: Default" }));
    const names = screen.getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-label"));
    expect(names).toEqual(["Default", "Monospace", "JetBrains Mono", "Fira Code", "Source Code Pro", "Atkinson Hyperlegible Mono"]);
    await user.click(screen.getByRole("menuitemradio", { name: "Fira Code" }));
    expect(loadCodeFont()).toBe("fira-code");
    expect(document.documentElement.dataset.docCodeFont).toBe("fira-code");
    expect(screen.getByRole("button", { name: "Code font: Fira Code" })).toBeInTheDocument();
  });

  it("offers nothing from this computer where the browser cannot list fonts", () => {
    const view = render(<LocalFontsPanel onUse={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("lists this computer's fonts only when asked, and marks a choice as local", async () => {
    const user = userEvent.setup(), onBody = vi.fn(), onHeading = vi.fn();
    const query = vi.fn(async () => [{ family: "Futura" }, { family: "Futura" }, { family: "Menlo" }, { family: ".Private UI" }, { family: "Bad'Name" }]);
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = query;
    render(<FontLibraryControls onBodyFont={onBody} onHeadingFont={onHeading} />);
    expect(query).not.toHaveBeenCalled();
    expect(screen.getByText(/Shared links and other people see a bundled font instead/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show fonts on this computer" }));
    const list = await screen.findByRole("list", { name: "Fonts on this computer" });
    expect(within(list).getAllByRole("listitem").map((item) => item.querySelector("span")!.textContent)).toEqual(["Futura", "Menlo"]);
    await user.click(screen.getByRole("button", { name: "Use Futura for body" }));
    expect(onBody).toHaveBeenCalledWith("local:inter:Futura");
    expect(findTypeface("local:inter:Futura")).toMatchObject({ localOnly: true, label: "Futura (only on this computer)" });
    expect(screen.getByText("Futura is only on this computer. A shared link or another person sees Inter instead.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use Menlo for headings" }));
    expect(onHeading).toHaveBeenCalledWith("local:jetbrains-mono:Menlo");
    // A monospace font can be the code font too.
    await user.click(screen.getByRole("button", { name: "Use Menlo for code" }));
    expect(loadCodeFont()).toBe("local:jetbrains-mono:Menlo");
    expect(screen.getByRole("button", { name: "Code font: Menlo" })).toBeInTheDocument();
  });

  it("says so when the person refuses the listing", async () => {
    const user = userEvent.setup();
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    render(<LocalFontsPanel onUse={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Show fonts on this computer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Markie was not allowed to list this computer's fonts.");
  });
});

describe("the per-document font menu", () => {
  it("keeps every id it always had and adds the bundled library after them", () => {
    expect(DOC_FONTS.slice(0, 7).map((font) => font.id)).toEqual(["system", "sans", "charter", "georgia", "iowan", "helvetica", "mono"]);
    expect(fontStack("charter")).toBe("Charter, Georgia, 'Times New Roman', serif");
    expect(DOC_FONTS.slice(7).map((font) => font.id)).toEqual(LIBRARY_FAMILIES.map((family) => family.id));
    expect(DOC_FONTS.find((font) => font.id === "atkinson")).toMatchObject({ label: "Atkinson Hyperlegible Next", group: "Easy to read" });
    expect(normalizeAppearance({ fontFamily: "lexend" }).fontFamily).toBe("lexend");
    expect(normalizeAppearance({ fontFamily: "local:inter:Futura" }).fontFamily).toBe("system");
    expect(new Set(DOC_FONTS.map((font) => font.id)).size).toBe(DOC_FONTS.length);
  });
});
