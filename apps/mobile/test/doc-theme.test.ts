// A theme pinned to a shared document comes from another account. These
// check what of it reaches the reading screen: its type always, its colours
// only in the phone's own tone, and nothing that is not a plain colour.
import { describe, expect, it } from "vitest";
import { MARKIE_DARK, MARKIE_LIGHT } from "@/lib/theme";
import { DOC_STYLE_SCOPE, docStyleCss, docThemeStyle, plainColor } from "../src/lib/doc-theme";
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

describe("a pinned Markdown style on the reading screen", () => {
  it("writes nothing for no style, for Spacious, or for something that is not a style", () => {
    for (const none of [null, undefined, "compact", 4, [], {}, { base: "spacious" }, { base: "from-the-future" }]) expect(docStyleCss(none)).toBe("");
  });

  it("writes the style's rules for the themed article only", () => {
    const css = docStyleCss({ base: "technical" });
    expect(css).toContain(`${DOC_STYLE_SCOPE} thead th`);
    for (const line of css.split("\n")) expect(line.startsWith(DOC_STYLE_SCOPE)).toBe(true);
  });

  it("draws only listed choices and numbers in range, whatever the server sent", () => {
    const attack = "} body { display: none } .x { background: url(https://evil.example/x)";
    const css = docStyleCss({
      base: "compact",
      choices: { tableStyle: "zebra", linkStyle: attack, bulletStyle: attack, futureChoice: "futureOption" },
      numbers: { imageRadius: 1e9, blockGap: attack, leading: Number.NaN },
      css: attack,
    });
    expect(css).toContain("tr:nth-child(even)");
    expect(css).toContain("border-radius: 24px");
    expect(css).not.toContain("evil");
    expect(css).not.toContain("display: none");
    expect(css).not.toContain("NaN");
  });
});

describe("reading the pinned look from the server", () => {
  const client = (answer: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) => {
    const seen: HttpRequest[] = [];
    const api = createApiClient({ origin: "https://api.markiedocs.com", getToken: () => "t".repeat(32), transport: async (request) => { seen.push(request); return answer(request); } });
    return { api, seen };
  };
  const TOKEN = "b".repeat(64);

  it("reads a member's look with the session, tokens and style together", async () => {
    const { api, seen } = client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: { background: "#fff" }, style: { base: "classic" } }) }));
    expect(await api.docLook("doc-1")).toEqual({ tokens: { background: "#fff" }, style: { base: "classic" } });
    expect(seen[0].url).toBe("https://api.markiedocs.com/api/docs/doc-1/theme");
    expect(seen[0].headers?.authorization).toMatch(/^Bearer /);
  });

  it("reads a server that predates styles as a look with no style", async () => {
    const { api } = client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: { background: "#fff" } }) }));
    expect(await api.docLook("doc-1")).toEqual({ tokens: { background: "#fff" }, style: null });
  });

  it("reads a public link's look with the link alone, never the session", async () => {
    const { api, seen } = client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: { background: "#fff" }, style: { base: "minimal" } }) }));
    expect(await api.publicLook(TOKEN)).toEqual({ tokens: { background: "#fff" }, style: { base: "minimal" } });
    expect(seen[0].url).toBe(`https://api.markiedocs.com/s/${TOKEN}/theme`);
    expect(seen[0].headers?.authorization).toBeUndefined();
  });

  it("answers null, never an error, for nothing pinned, an older server, a refusal or no network", async () => {
    for (const read of [(api: ReturnType<typeof client>["api"]) => api.docLook("doc-1"), (api: ReturnType<typeof client>["api"]) => api.publicLook(TOKEN)]) {
      expect(await read(client(() => ({ status: 200, headers: {}, text: JSON.stringify({ tokens: null, style: null }) })).api)).toBeNull();
      expect(await read(client(() => ({ status: 404, headers: {}, text: "Not Found" })).api)).toBeNull();
      expect(await read(client(() => ({ status: 403, headers: {}, text: "{}" })).api)).toBeNull();
      expect(await read(client(() => ({ status: 200, headers: {}, text: "# not json" })).api)).toBeNull();
      expect(await read(client(() => { throw new Error("offline"); }).api)).toBeNull();
    }
    expect(await client(() => ({ status: 200, headers: {}, text: "{}" })).api.publicLook("short")).toBeNull();
  });
});
