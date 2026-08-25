import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// There is no CSS parser in the test stack, and print rules are invisible until
// someone actually prints — the previous set hid four elements by class names
// no component has carried for months. This is a text-level guard against that
// drift: it asserts the selectors match what the DOM really exposes, and that
// the print palette is still forced.
const css = readFileSync(join(process.cwd(), "src/app/print.css"), "utf8");

describe("print.css", () => {
  it("scopes everything to @media print", () => {
    expect(css).toContain("@media print");
  });

  // Each of these is the attribute or id the component actually renders. If a
  // component renames its hook, this fails instead of the printout.
  it.each([
    ["[data-markie-find-bar]", "src/components/find-bar.tsx"],
    ["[data-markie-format-rail]", "src/components/format-rail.tsx"],
    ["[data-markie-share-banner]", "src/components/share-banner.tsx"],
    ["[data-markie-update-strip]", "src/components/share-banner.tsx"],
    ["#markie-command-palette-list", "src/components/command-palette.tsx"],
  ])("hides %s, which %s renders", (selector, source) => {
    expect(css).toContain(selector);
    const hook = selector.replace(/^[[#]/, "").replace(/]$/, "");
    expect(readFileSync(join(process.cwd(), source), "utf8")).toContain(hook);
  });

  it("forces a print palette onto the theme tokens", () => {
    for (const token of [
      "--foreground:",
      "--background:",
      "--surface:",
      "--surface-2:",
      "--border:",
      "--muted:",
    ]) {
      expect(css).toContain(`${token} #`);
    }
    // dark-theme tokens must win over a user theme set on :root at runtime
    expect(css).toMatch(/--foreground:\s*#000\s*!important/);
  });

  it("keeps code and table fills on paper", () => {
    expect(css).toContain("print-color-adjust: exact");
    expect(css).toContain(".markdown-body pre");
    expect(css).toContain(".markdown-body table");
  });
});
