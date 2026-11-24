// @vitest-environment jsdom
// The Markdown style section of Settings and the editor behind it: presets
// first, an element's details behind its row, an edit that is "(edited)"
// until it is saved under a name.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushCloudThemes = vi.fn();
vi.mock("@/lib/theme-sync", () => ({ pushCloudThemes: () => pushCloudThemes() }));
vi.mock("@/lib/markdown-html", () => ({ renderMarkdownHTML: () => "<h1>Sample</h1><h2>Section</h2><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>" }));

const { MarkdownStyleSection } = await import("./markdown-style-settings");
const { applyMarkdownStyle, markdownStyleCss } = await import("@/lib/markdown-style");
const { loadMarkdownStyleStore } = await import("@/lib/markdown-style-store");

beforeEach(() => {
  localStorage.clear();
  pushCloudThemes.mockReset();
});
afterEach(() => {
  cleanup();
  applyMarkdownStyle(null);
});

const painted = () => document.querySelector("style#markie-markdown-style")?.textContent ?? "";
const card = (name: string) => screen.getByRole("radio", { name });

describe("the Markdown style section", () => {
  it("offers the six presets with Spacious in use, and paints nothing for it", () => {
    render(<MarkdownStyleSection />);
    for (const name of ["Spacious", "Compact", "Classic", "Technical", "Editorial", "Minimal"]) expect(card(name)).toBeTruthy();
    expect(card("Spacious").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("In use: Spacious")).toBeTruthy();
    expect(painted()).toBe("");
  });

  it("draws each card in its own style, out of reach of the app's", () => {
    render(<MarkdownStyleSection />);
    const scope = card("Technical").querySelector("[data-md-style]")!;
    const css = scope.querySelector("style")!.textContent!;
    expect(css).toContain(`[data-md-style="${scope.getAttribute("data-md-style")}"] .markdown-body`);
    expect(card("Spacious").querySelector("style")).toBeNull();
  });

  it("switches style on a click, saves it and sends it to the account", () => {
    render(<MarkdownStyleSection />);
    fireEvent.click(card("Compact"));
    expect(card("Compact").getAttribute("aria-checked")).toBe("true");
    expect(painted()).toBe(markdownStyleCss({ base: "compact" }));
    expect(loadMarkdownStyleStore().activeId).toBe("compact");
    expect(pushCloudThemes).toHaveBeenCalledTimes(1);
  });

  it("duplicates a preset into a profile that can be renamed and deleted", () => {
    render(<MarkdownStyleSection />);
    fireEvent.click(card("Classic"));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(card("Classic copy"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for this style"), { target: { value: "Essays" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByText("In use: Essays")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("radio", { name: "Essays" })).toBeNull();
    // The preset it was built on takes over.
    expect(card("Classic").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("the style editor", () => {
  const open = async () => {
    render(<MarkdownStyleSection />);
    fireEvent.click(screen.getByRole("button", { name: "Customize…" }));
    const editor = within(screen.getByRole("dialog", { name: "Markdown style" }));
    await editor.findByRole("heading", { name: "Sample" });
    return editor;
  };

  it("previews a sample document and keeps each element's details behind its row", async () => {
    const editor = await open();
    for (const label of ["Typefaces", "Headings", "Paragraphs and spacing", "Bulleted lists", "Numbered lists", "List layout", "Task lists", "Tables", "Blockquotes", "Code", "Dividers", "Images", "Links"]) {
      expect(editor.getByRole("button", { name: new RegExp(`^${label}`) }).getAttribute("aria-expanded")).toBe("false");
    }
    expect(editor.queryByRole("radiogroup", { name: "Borders" })).toBeNull();
    fireEvent.click(editor.getByRole("button", { name: /^Tables/ }));
    expect(editor.getByRole("radiogroup", { name: "Borders" })).toBeTruthy();
  });

  it("turns a changed element into an unsaved edit, drawn at once, and resets it to the preset", async () => {
    const editor = await open();
    fireEvent.click(editor.getByRole("button", { name: /^Tables/ }));
    fireEvent.click(within(editor.getByRole("radiogroup", { name: "Borders" })).getByRole("radio", { name: "Zebra" }));
    expect(editor.getByText("Spacious (edited). Not saved yet.")).toBeTruthy();
    expect(painted()).toContain("tr:nth-child(even)");
    // The preview is drawn from its own scoped copy of the same rules.
    expect(document.querySelector("[data-markdown-style-preview] style")?.textContent).toContain("tr:nth-child(even)");
    fireEvent.click(editor.getByRole("button", { name: "Reset to Spacious" }));
    expect(document.querySelector("[data-markdown-style-name]")?.textContent).toBe("Spacious");
    expect(painted()).toBe("");
  });

  it("moves a number with its slider, inside its range", async () => {
    const editor = await open();
    fireEvent.click(editor.getByRole("button", { name: /^Images/ }));
    const slider = editor.getByLabelText("Corner radius") as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("24");
    fireEvent.change(slider, { target: { value: "16" } });
    expect(painted()).toContain("border-radius: 16px");
  });

  it("saves the edit under a name, as a profile that is then in use", async () => {
    const editor = await open();
    fireEvent.click(editor.getByRole("radio", { name: "Technical" }));
    fireEvent.click(editor.getByRole("button", { name: /^Links/ }));
    fireEvent.click(editor.getByRole("radio", { name: "Dotted" }));
    fireEvent.click(editor.getByRole("button", { name: "Save as new style…" }));
    fireEvent.change(editor.getByLabelText("Name for the new style"), { target: { value: "Runbooks" } });
    fireEvent.click(editor.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(loadMarkdownStyleStore().activeId).not.toBe("technical"));
    const store = loadMarkdownStyleStore();
    expect(store.profiles).toEqual([{ id: store.activeId, name: "Runbooks", style: { base: "technical", name: "Runbooks", choices: { linkStyle: "dotted" } } }]);
    expect(store.draft).toBeUndefined();
    // A later edit can be written back into it.
    fireEvent.click(editor.getByRole("radio", { name: "Underlined" }));
    fireEvent.click(editor.getByRole("button", { name: "Save to Runbooks" }));
    expect(loadMarkdownStyleStore().profiles[0].style).toEqual({ base: "technical", name: "Runbooks" });
  });

  it("offers typefaces through the font picker, and paints a chosen face with the theme", async () => {
    const editor = await open();
    fireEvent.click(editor.getByRole("button", { name: /^Typefaces/ }));
    // Spacious leaves every face to the template.
    fireEvent.click(editor.getByRole("button", { name: "Text: Template's font" }));
    fireEvent.click(editor.getByRole("menuitemradio", { name: /Literata/ }));
    expect(document.documentElement.style.getPropertyValue("--doc-font-family")).toMatch(/^'Literata', Georgia/);
    expect(loadMarkdownStyleStore().draft).toEqual({ base: "spacious", choices: { bodyFont: "literata" } });
    // A code face is offered from the monospace faces only.
    fireEvent.click(editor.getByRole("button", { name: "Code: Template's font" }));
    expect(editor.queryByRole("menuitemradio", { name: /Literata/ })).toBeNull();
    fireEvent.click(editor.getByRole("menuitemradio", { name: /JetBrains Mono/ }));
    expect(loadMarkdownStyleStore().draft?.choices).toEqual({ bodyFont: "literata", codeFont: "jetbrains-mono" });
    fireEvent.click(editor.getByRole("button", { name: "Reset to Spacious" }));
    expect(document.documentElement.style.getPropertyValue("--doc-font-family")).toBe("var(--font-geist-sans)");
  });

  it("brings a preset's own typefaces with it, and says when the person's own choice stands instead", async () => {
    const { loadThemeStore, saveThemeStore, setTypography } = await import("@/lib/theme");
    const editor = await open();
    fireEvent.click(editor.getByRole("radio", { name: "Editorial" }));
    expect(document.documentElement.style.getPropertyValue("--doc-font-family")).toMatch(/^'Source Serif 4'/);
    expect(document.documentElement.style.getPropertyValue("--doc-heading-family")).toMatch(/^'Playfair Display'/);
    fireEvent.click(editor.getByRole("button", { name: /^Typefaces/ }));
    expect(document.querySelector("[data-markdown-style-own-fonts]")).toBeNull();
    cleanup();
    // A font chosen in Typography is the person's own, and wins.
    saveThemeStore(setTypography(loadThemeStore(), { bodyFont: "lora" }));
    const again = await open();
    fireEvent.click(again.getByRole("radio", { name: "Technical" }));
    expect(document.documentElement.style.getPropertyValue("--doc-font-family")).toMatch(/^'Lora'/);
    fireEvent.click(again.getByRole("button", { name: /^Typefaces/ }));
    expect(document.querySelector("[data-markdown-style-own-fonts]")?.textContent).toContain("the text font");
  });

  it("closes on Escape without closing what is behind it", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    await open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Markdown style" })).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });
});
