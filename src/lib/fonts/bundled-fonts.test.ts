// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledFontLicenseUrl, bundledFontUrl, fontDataUrl, inlineFontFaceRules, installBundledFonts } from "./bundled-fonts";
import { BUNDLED_FAMILIES, bundledFamily } from "./registry";
import { CODE_FONT_CHANGED_EVENT, loadCodeFont, saveCodeFont, startCodeFont } from "./code-font";
import { bundledFamiliesInHtml, exportFontCss, exportFontRules } from "./export-fonts";
import { familiesFrom } from "./local-fonts";
import { MARKIE_DARK, applyTheme } from "../theme";

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById("markie-bundled-fonts")?.remove();
  localStorage.clear();
});

describe("bundled fonts in a build", () => {
  it("has a URL from this build for every file the registry names", () => {
    for (const family of BUNDLED_FAMILIES) {
      for (const file of family.files) {
        const url = bundledFontUrl(file.file);
        expect(url, file.file).toBeTruthy();
        expect(url).not.toMatch(/^https?:\/\//);
      }
    }
    // The license text of every family is in the build too.
    for (const family of BUNDLED_FAMILIES) expect(bundledFontLicenseUrl(family.licenseFile), family.id).toBeTruthy();
    expect(bundledFontUrl("inter/Nope.woff2")).toBeUndefined();
    expect(bundledFontUrl("../../package.json")).toBeUndefined();
  });

  it("declares every face once", () => {
    installBundledFonts();
    installBundledFonts();
    const styles = document.querySelectorAll("#markie-bundled-fonts");
    expect(styles).toHaveLength(1);
    const css = styles[0].textContent!;
    expect(css.match(/@font-face/g)).toHaveLength(BUNDLED_FAMILIES.reduce((sum, family) => sum + family.files.length, 0));
    expect(css).toContain("font-family:'Atkinson Hyperlegible Next'");
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("writes a family's files into a stylesheet for an export", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(url); return new Response(new Uint8Array([1, 2, 3])); }));
    const css = await inlineFontFaceRules([bundledFamily("lora")!]);
    expect(fetched).toHaveLength(2);
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain(`src:url("data:font/woff2;base64,AQID") format("woff2")`);
    expect(fontDataUrl(new Uint8Array([104, 105]))).toBe("data:font/woff2;base64,aGk=");
  });

  it("leaves out a file that cannot be read rather than failing the export", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await inlineFontFaceRules([bundledFamily("quicksand")!])).toBe("");
  });
});

describe("the code font", () => {
  it("paints a monospace choice, remembers it, and clears back to the default", () => {
    startCodeFont();
    const heard = vi.fn();
    window.addEventListener(CODE_FONT_CHANGED_EVENT, heard);
    expect(saveCodeFont("jetbrains-mono")).toBe("jetbrains-mono");
    expect(document.documentElement.dataset.docCodeFont).toBe("jetbrains-mono");
    expect(document.documentElement.style.getPropertyValue("--doc-code-family")).toMatch(/^'JetBrains Mono', ui-monospace/);
    expect(loadCodeFont()).toBe("jetbrains-mono");
    expect(heard).toHaveBeenCalledOnce();
    // Not a monospace face, and not an id at all: both mean the default.
    expect(saveCodeFont("lora")).toBe("");
    expect(document.documentElement.dataset.docCodeFont).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--doc-code-family")).toBe("");
    localStorage.setItem("markie.fonts.v1", JSON.stringify({ codeFont: "x'; } * { color: red" }));
    expect(loadCodeFont()).toBe("");
    window.removeEventListener(CODE_FONT_CHANGED_EVENT, heard);
  });

  it("follows a code font carried by the tokens being painted, and goes back after", () => {
    startCodeFont();
    saveCodeFont("fira-code");
    applyTheme({ ...MARKIE_DARK.tokens, codeFont: "source-code" } as typeof MARKIE_DARK.tokens);
    expect(document.documentElement.dataset.docCodeFont).toBe("source-code");
    applyTheme({ ...MARKIE_DARK.tokens, codeFont: "inter'; } body {" } as typeof MARKIE_DARK.tokens);
    expect(document.documentElement.dataset.docCodeFont).toBe("fira-code");
    applyTheme(MARKIE_DARK.tokens);
    expect(document.documentElement.dataset.docCodeFont).toBe("fira-code");
    saveCodeFont("");
  });
});

describe("fonts an export carries", () => {
  it("adds nothing for the default look", async () => {
    expect(exportFontRules({ bodyFont: "system", headingFont: "body", codeFont: "" })).toBe("");
    expect(await exportFontCss("<p>Hello</p>", MARKIE_DARK.tokens, "")).toBe("");
  });

  it("sets body, headings and code in the theme's faces, with literal fallbacks", () => {
    const css = exportFontRules({ bodyFont: "atkinson", headingFont: "fraunces", codeFont: "jetbrains-mono" });
    expect(css).toContain("body,.markdown-body{font-family:'Atkinson Hyperlegible Next', system-ui");
    expect(css).toContain(".markdown-body :is(h1,h2,h3,h4,h5,h6){font-family:'Fraunces', Georgia");
    expect(css).toContain(".markdown-body :is(code,pre,kbd,samp),.markdown-body pre code{font-family:'JetBrains Mono', ui-monospace");
    // A system face keeps working in a file that has none of the app's variables.
    expect(exportFontRules({ bodyFont: "georgia", headingFont: "system", codeFont: "mono" })).not.toContain("var(");
  });

  it("puts the files for every bundled face in use inside the stylesheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([9]))));
    const css = await exportFontCss(`<p><span style="font-family: 'Caveat', cursive">note</span></p>`, { ...MARKIE_DARK.tokens, bodyFont: "lora", headingFont: "inter" }, "fira-code");
    for (const family of ["Lora", "Inter", "Fira Code", "Caveat"]) expect(css).toContain(`@font-face{font-family:'${family}'`);
    expect(css).not.toContain("@font-face{font-family:'Nunito'");
    expect(css).not.toMatch(/url\((?!"data:)/);
  });

  it("finds bundled families named by a document's own inline styles only", () => {
    expect(bundledFamiliesInHtml(`<span style="font-family: 'Inter', sans-serif">a</span>`).map((family) => family.id)).toEqual(["inter"]);
    expect(bundledFamiliesInHtml("<p>I like the Inter typeface</p>")).toEqual([]);
  });
});

describe("a listing of installed fonts", () => {
  it("keeps one entry per family, skips private system faces and anything it would not store", () => {
    const families = familiesFrom([{ family: "Futura" }, { family: "Futura" }, { family: ".SF NS Mono" }, { family: "Menlo" }, { family: "Bad'; } Name" }, { family: 7 }, {}]);
    expect(families).toEqual([
      { family: "Bad'; } Name", kind: "sans", id: null },
      { family: "Futura", kind: "sans", id: "local:inter:Futura" },
      { family: "Menlo", kind: "mono", id: "local:jetbrains-mono:Menlo" },
    ]);
  });
});
