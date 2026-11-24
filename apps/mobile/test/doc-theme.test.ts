// A theme pinned to a shared document comes from another account. These
// check what of it reaches the reading screen: its type always, its colours
// only in the phone's own tone, and nothing that is not a plain colour.
import { describe, expect, it } from "vitest";
import { MARKIE_DARK, MARKIE_LIGHT } from "@/lib/theme";
import { docThemeStyle, plainColor } from "../src/lib/doc-theme";
import { createApiClient } from "../src/lib/api";
import type { HttpRequest, HttpResponse } from "../src/lib/http";

describe("a pinned theme's colours", () => {
  it("accepts hex and colour functions over plain numbers", () => {
    for (const ok of ["#fff", "#1c1c1eff", "#09090B", "rgb(10, 20, 30)", "rgba(10 20 30 / 50%)", "hsl(210deg 40% 96%)", "oklch(0.7 0.1 240)"]) expect(plainColor(ok)).toBe(ok);
  });

  it("refuses anything that could fetch, reference or run", () => {
    for (const bad of ["url(https://evil.example/x.png)", "var(--background)", "red; background: url(x)", "linear-gradient(#fff, #000)", "rgb(1,2,3) url(x)", "expression(alert(1))", "", "  ", 7, null, "#12", "x".repeat(80)]) expect(plainColor(bad)).toBeNull();
  });
});

describe("a pinned theme on the reading screen", () => {
  it("is nothing when there is none, or when it is not a token set", () => {
    for (const none of [null, undefined, "dark", 4, []]) expect(docThemeStyle(none, "light")).toBeNull();
  });

  it("paints the owner's colours when they are the phone's own tone", () => {
    const sepia = { ...MARKIE_LIGHT.tokens, background: "#f6f1e3", foreground: "#2b2418", link: "#7a4b12" };
    const style = docThemeStyle(sepia, "light")!;
    expect(style.colors).toBe(true);
    expect(style.vars["--background"]).toBe("#f6f1e3");
    expect(style.vars["--foreground"]).toBe("#2b2418");
    expect(style.vars["--blue"]).toBe("#7a4b12");
    expect(style.vars["--doc-rule"]).toBeTruthy();
  });

  it("keeps the phone's own colours when the theme is the other tone, and still takes its type", () => {
    const dark = { ...MARKIE_DARK.tokens, bodyFont: "charter", lineHeight: 1.9, paragraphGap: 1.1, fontSize: 20 };
    const style = docThemeStyle(dark, "light")!;
    expect(style.colors).toBe(false);
    expect(style.vars["--background"]).toBeUndefined();
    expect(style.vars["--doc-font-family"]).toContain("Charter");
    expect(style.vars["--doc-line-height"]).toBe("1.9");
    expect(style.vars["--doc-paragraph-gap"]).toBe("1.1em");
    expect(style.vars["--m-doc-theme-scale"]).toBe("1.25");
    // The same theme on a phone in dark mode is painted in full.
    expect(docThemeStyle(dark, "dark")!.colors).toBe(true);
  });

  it("drops every colour when one of them is not a plain colour, and never a font it does not know", () => {
    const hostile = { ...MARKIE_LIGHT.tokens, surface: "url(https://evil.example/pixel)", bodyFont: "'x'; background: url(//evil.example)", fontSize: 4000, lineHeight: 99 };
    const style = docThemeStyle(hostile, "light")!;
    expect(style.colors).toBe(false);
    expect(JSON.stringify(style.vars)).not.toContain("evil.example");
    // An unknown face is the default face, and numbers are held in range.
    expect(Number(style.vars["--m-doc-theme-scale"])).toBeLessThanOrEqual(1.35);
    expect(Number(style.vars["--doc-line-height"])).toBeLessThan(4);
  });

  it("holds the size to what a phone column can take", () => {
    expect(docThemeStyle({ ...MARKIE_LIGHT.tokens, fontSize: 11 }, "light")!.vars["--m-doc-theme-scale"]).toBe("0.9");
    expect(docThemeStyle({ ...MARKIE_LIGHT.tokens, fontSize: 32 }, "light")!.vars["--m-doc-theme-scale"]).toBe("1.35");
    expect(docThemeStyle({ ...MARKIE_LIGHT.tokens, fontSize: 16 }, "light")!.vars["--m-doc-theme-scale"]).toBe("1");
  });
});

describe("reading the pinned theme from the server", () => {
  const client = (answer: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) => {
    const seen: HttpRequest[] = [];
    const api = createApiClient({ origin: "https://api.markiedocs.com", getToken: () => "t".repeat(32), transport: async (request) => { seen.push(request); return answer(request); } });
    return { api, seen };
  };

  it("asks the document's own theme route with the session", async () => {
    const { api, seen } = client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: { background: "#fff" } }) }));
    expect(await api.docTheme("doc-1")).toEqual({ background: "#fff" });
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://api.markiedocs.com/api/docs/doc-1/theme");
    expect(seen[0].headers?.authorization).toMatch(/^Bearer /);
  });

  it("answers null, never an error, for no theme, an older server, a refusal or no network", async () => {
    expect(await client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: null }) })).api.docTheme("doc-1")).toBeNull();
    expect(await client(() => ({ status: 404, headers: {}, text: "Not Found" })).api.docTheme("doc-1")).toBeNull();
    expect(await client(() => ({ status: 403, headers: {}, text: JSON.stringify({ error: "forbidden" }) })).api.docTheme("doc-1")).toBeNull();
    expect(await client(() => ({ status: 500, headers: {}, text: "" })).api.docTheme("doc-1")).toBeNull();
    expect(await client(() => { throw new Error("offline"); }).api.docTheme("doc-1")).toBeNull();
    expect(await client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: "dark" }) })).api.docTheme("doc-1")).toBeNull();
  });
});

// The phone bundles the same font files as the desktop (src/assets/fonts,
// declared by installBundledFonts in main.tsx), so a pinned look set in one
// paints in it here too.
describe("a pinned look set in a bundled or a local font", () => {
  it("paints a bundled face by its registry id", () => {
    const style = docThemeStyle({ bodyFont: "atkinson", headingFont: "fraunces" }, "light");
    expect(style?.vars["--doc-font-family"]).toMatch(/^'Atkinson Hyperlegible Next', system-ui/);
    expect(style?.vars["--doc-heading-family"]).toMatch(/^'Fraunces', Georgia/);
  });

  it("shows the bundled fallback for a font only the owner's computer has", () => {
    const style = docThemeStyle({ bodyFont: "local:source-serif:Hoefler Text" }, "light");
    expect(style?.vars["--doc-font-family"]).toMatch(/^'Hoefler Text', 'Source Serif 4', Georgia/);
  });

  it("ignores a font id that is not one", () => {
    for (const bodyFont of ["local:inter:x'; } body { display:none", "local:nope:Futura", "'; background: url(//evil.example)"]) {
      const style = docThemeStyle({ bodyFont }, "light");
      expect(style?.vars["--doc-font-family"] ?? "").not.toMatch(/evil|display|nope/);
    }
  });
});
