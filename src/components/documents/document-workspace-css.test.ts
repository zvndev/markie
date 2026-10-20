import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The on-screen Word canvas must follow the app theme. It used to end the
// stylesheet with a forced white "paper" (#fff / #18181b), so DOCX, RTF, and
// ODT documents stayed light in dark mode while everything around them went
// dark. Printed output is a different surface: docx-print keeps real white
// paper on purpose, and this guard keeps the two from being conflated again.
const css = readFileSync(join(process.cwd(), "src/components/documents/document-workspace.css"), "utf8");
const printSource = readFileSync(join(process.cwd(), "src/lib/office/docx-print.ts"), "utf8");

describe("document workspace screen theme", () => {
  it("paints the word canvas from theme tokens, never a forced light palette", () => {
    expect(css).toMatch(/\.docs-word-paper,\.docs-word-continuous\s*\{\s*background:var\(--background\);\s*color:var\(--foreground\)/);
    expect(css).not.toMatch(/\.docs-word-(?:paper|continuous)[^{]*\{\s*background:#fff/);
    expect(css).not.toContain("color:#18181b");
    expect(css).not.toContain("caret-color:#18181b");
  });

  it("lets native document controls and page-break markers follow the theme tone", () => {
    expect(css).toMatch(/:root\[data-theme-tone="dark"\] \.docs-workspace[^{]*\{\s*color-scheme:dark/);
    expect(css).toMatch(/:root\[data-theme-tone="light"\] \.docs-workspace[^{]*\{\s*color-scheme:light/);
    const marker = css.slice(css.indexOf(".docs-page-break-marker {"), css.indexOf(".docs-revisions {"));
    expect(marker).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("keeps printed pages on white paper regardless of the screen theme", () => {
    expect(printSource).toContain("background:#fff;color:#000;color-scheme:light");
  });
});
