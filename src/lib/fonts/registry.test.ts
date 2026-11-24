import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_FONT_FILES } from "./bundled-files.generated";
import {
  BUNDLED_FAMILIES,
  LIBRARY_FAMILIES,
  SYSTEM_TYPEFACES,
  TYPEFACE_LIST,
  adoptLocalTypeface,
  adoptLocalTypefacesIn,
  bundledFamiliesUsed,
  bundledFamily,
  bundledFamilyNamed,
  cssFamilyName,
  findTypeface,
  fontFaceRules,
  localFontKind,
  localTypefaceId,
  officeFontStack,
  parseLocalTypefaceId,
  substituteFor,
} from "./registry";
import { cleanCodeFont, codeFontStack } from "./code-font";
import { HEADING_SAME_AS_BODY, TYPEFACES, THEME_TEMPLATES, typefaceStack, typographyOf, typographyVars } from "../theme";
import sources from "../../../scripts/fonts/sources.json";

const FONTS_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));

// The nine faces as theme.ts held them before the registry existed, copied
// here by hand. A theme pinned to a document years ago names these ids, and it
// has to paint exactly what it painted then.
const BEFORE_THE_REGISTRY = [
  { id: "system", label: "System", stack: "var(--font-geist-sans)", kind: "sans" },
  { id: "humanist", label: "Avenir", stack: "'Avenir Next', Avenir, 'Segoe UI Variable Text', 'Segoe UI', 'Helvetica Neue', sans-serif", kind: "sans" },
  { id: "helvetica", label: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", kind: "sans" },
  { id: "optima", label: "Optima", stack: "Optima, Candara, 'Avenir Next', 'Segoe UI', sans-serif", kind: "sans" },
  { id: "charter", label: "Charter", stack: "Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif", kind: "serif" },
  { id: "iowan", label: "Iowan", stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", kind: "serif" },
  { id: "newyork", label: "New York", stack: "ui-serif, 'New York', 'Iowan Old Style', Charter, Georgia, serif", kind: "serif" },
  { id: "georgia", label: "Georgia", stack: "Georgia, Charter, 'Times New Roman', serif", kind: "serif" },
  { id: "mono", label: "Monospace", stack: "var(--font-geist-mono)", kind: "mono" },
] as const;

describe("registry integrity", () => {
  it("has metadata for every built family and a built family for every entry", () => {
    const built = BUNDLED_FONT_FILES.map((family) => family.id).sort();
    expect(BUNDLED_FAMILIES.map((family) => family.id).sort()).toEqual(built);
    expect(sources.families.map((family) => family.id).sort()).toEqual(built);
    expect(new Set(built).size).toBe(built.length);
  });

  it("offers a library of 15 to 20 families covering every kind", () => {
    expect(LIBRARY_FAMILIES.length).toBeGreaterThanOrEqual(15);
    expect(LIBRARY_FAMILIES.length).toBeLessThanOrEqual(20);
    const groups = new Set(LIBRARY_FAMILIES.map((family) => family.group));
    for (const group of ["sans", "serif", "mono", "rounded", "readable", "display"]) expect(groups.has(group as never)).toBe(true);
    expect(bundledFamily("atkinson")?.family).toBe("Atkinson Hyperlegible Next");
  });

  it("resolves every id to one typeface with a usable stack", () => {
    const ids = TYPEFACE_LIST.map((face) => face.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const face of TYPEFACE_LIST) {
      expect(findTypeface(face.id)).toBe(face);
      expect(typefaceStack(face.id)).toBe(face.stack);
      expect(face.stack.length).toBeGreaterThan(0);
      expect(face.stack).not.toMatch(/[;{}<>]|url\(|expression|@import/i);
    }
    for (const family of LIBRARY_FAMILIES) {
      const face = findTypeface(family.id)!;
      expect(face).toMatchObject({ label: family.family, kind: family.kind, bundled: true });
      // The bundled face comes first, then literal system fallbacks.
      expect(face.stack.startsWith(`${cssFamilyName(family.family)}, `)).toBe(true);
      expect(face.stack).not.toContain("var(");
    }
    // Stand-ins for Office fonts are never offered as a choice.
    for (const family of BUNDLED_FAMILIES.filter((item) => item.role === "substitute")) expect(findTypeface(family.id)).toBeUndefined();
  });

  it("ships every file it names, byte for byte, and nothing else", () => {
    const named = new Set<string>();
    for (const family of BUNDLED_FAMILIES) {
      expect(family.files.length).toBeGreaterThan(0);
      for (const file of family.files) {
        named.add(file.file);
        expect(file.file).toMatch(new RegExp(`^${family.id}/[A-Za-z0-9-]+\\.woff2$`));
        const bytes = readFileSync(`${FONTS_DIR}${file.file}`);
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
        expect(bytes.length).toBe(file.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
        expect(file.weight).toMatch(/^\d{3,4}( \d{3,4})?$/);
        expect(["normal", "italic"]).toContain(file.style);
      }
      expect(family.files.some((file) => file.style === "normal")).toBe(true);
    }
    const onDisk = readdirSync(FONTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readdirSync(`${FONTS_DIR}${entry.name}`).filter((name) => name.endsWith(".woff2")).map((name) => `${entry.name}/${name}`));
    expect(onDisk.sort()).toEqual([...named].sort());
  });

  it("ships each family's own license text, and only open licenses", () => {
    for (const family of BUNDLED_FAMILIES) {
      expect(["OFL-1.1", "Apache-2.0"]).toContain(family.license);
      expect(family.licenseFile).toBe(`${family.id}/LICENSE.txt`);
      expect(existsSync(`${FONTS_DIR}${family.licenseFile}`)).toBe(true);
      const text = readFileSync(`${FONTS_DIR}${family.licenseFile}`, "utf8");
      expect(text.length).toBeGreaterThan(2000);
      if (family.license === "OFL-1.1") {
        expect(text).toMatch(/SIL Open Font License, Version 1\.1/);
        expect(text).toMatch(/Copyright/);
      } else {
        expect(text).toMatch(/Apache License\s+Version 2\.0/);
      }
    }
  });

  it("records an official source and a version for every family", () => {
    expect(sources.repo).toBe("https://github.com/google/fonts");
    expect(sources.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const family of BUNDLED_FAMILIES) {
      expect(family.source).toMatch(new RegExp(`^https://github\\.com/google/fonts/tree/${sources.commit}/(ofl|apache)/[a-z0-9]+$`));
      // An OFL family sits under ofl/, an Apache one under apache/.
      expect(family.source.includes("/apache/")).toBe(family.license === "Apache-2.0");
      expect(family.version).toMatch(/^\d+\.\d+/);
      if (family.licenseSource) expect(family.licenseSource).toMatch(/^https:\/\/raw\.githubusercontent\.com\/googlefonts\/[a-z0-9-]+\/[0-9a-f]{40}\/OFL\.txt$/);
    }
  });

  it("writes one @font-face per file, and leaves out a file it has no URL for", () => {
    const css = fontFaceRules((file) => `/assets/${file}`);
    const total = BUNDLED_FAMILIES.reduce((sum, family) => sum + family.files.length, 0);
    expect(css.match(/@font-face/g)).toHaveLength(total);
    expect(css).toContain(`@font-face{font-family:'Inter';font-style:italic;font-weight:100 900;font-display:swap;src:url("/assets/inter/Inter-Italic.woff2") format("woff2")}`);
    expect(css).toContain(`font-family:'Carlito';font-style:normal;font-weight:700;`);
    expect(css).not.toMatch(/https?:\/\//);
    expect(fontFaceRules(() => undefined)).toBe("");
    expect(fontFaceRules((file) => (file.startsWith("lora/") ? "x" : undefined)).match(/@font-face/g)).toHaveLength(2);
  });
});

describe("themes saved before the registry", () => {
  it("keeps the nine original faces first, unchanged", () => {
    expect(SYSTEM_TYPEFACES.map(({ id, label, stack, kind }) => ({ id, label, stack, kind }))).toEqual(BEFORE_THE_REGISTRY);
    expect(TYPEFACES.slice(0, 9).map(({ id, label, stack, kind }) => ({ id, label, stack, kind }))).toEqual(BEFORE_THE_REGISTRY);
    for (const face of BEFORE_THE_REGISTRY) expect(typefaceStack(face.id)).toBe(face.stack);
    // The default any missing or unknown id falls back to.
    expect(typefaceStack(undefined)).toBe("var(--font-geist-sans)");
    expect(typefaceStack("no-such-face")).toBe("var(--font-geist-sans)");
  });

  it("paints an old pinned theme exactly as it did", () => {
    // Tokens as an owner pinned them before any font was bundled.
    expect(typographyVars({ bodyFont: "charter", headingFont: "iowan", lineHeight: 1.8, paragraphGap: 1, fontSize: 17, contentWidth: 720 })).toEqual({
      "--theme-font-family": "Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif",
      "--doc-font-family": "Charter, 'Bitstream Charter', Georgia, 'Times New Roman', serif",
      "--doc-heading-family": "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
      "--doc-line-height": "1.8",
      "--doc-paragraph-gap": "1em",
      "--theme-font-size": "17px",
      "--doc-font-size": "17px",
      "--doc-width": "720px",
    });
    // And one with no typography at all: the Markie default.
    expect(typographyVars({})).toMatchObject({ "--doc-font-family": "var(--font-geist-sans)", "--doc-heading-family": "" });
    expect(typographyOf({ bodyFont: "mono", headingFont: HEADING_SAME_AS_BODY })).toMatchObject({ bodyFont: "mono", headingFont: "body" });
  });

  it("leaves every built-in template on a face from the original nine", () => {
    const original = new Set<string>(BEFORE_THE_REGISTRY.map((face) => face.id));
    for (const template of THEME_TEMPLATES) {
      expect(original.has(template.typography.bodyFont)).toBe(true);
      expect(template.typography.headingFont === HEADING_SAME_AS_BODY || original.has(template.typography.headingFont)).toBe(true);
    }
  });

  it("accepts a bundled face in a theme", () => {
    expect(typographyOf({ bodyFont: "atkinson", headingFont: "fraunces" })).toMatchObject({ bodyFont: "atkinson", headingFont: "fraunces" });
    expect(typographyVars({ bodyFont: "lora" })["--doc-font-family"]).toBe("'Lora', Georgia, 'Times New Roman', serif");
  });
});

describe("fonts in Word, RTF and OpenDocument files", () => {
  it("puts the real font first and the stand-in after it, so the stand-in is used only when the font is missing", () => {
    expect(officeFontStack("Calibri")).toBe("'Calibri', 'Carlito'");
    expect(officeFontStack("Cambria")).toBe("'Cambria', 'Caladea'");
    expect(officeFontStack("Arial")).toBe("'Arial', 'Arimo'");
    expect(officeFontStack("Times New Roman")).toBe("'Times New Roman', 'Tinos'");
    expect(officeFontStack("Courier New")).toBe("'Courier New', 'Cousine'");
    expect(officeFontStack("Georgia")).toBe("'Georgia', 'Gelasio'");
    expect(officeFontStack(" calibri ")).toBe("'calibri', 'Carlito'");
    // In every stack the name in the document is ahead of anything bundled.
    for (const family of BUNDLED_FAMILIES) {
      for (const name of family.standsInFor ?? []) {
        const stack = officeFontStack(name).split(", ");
        expect(stack).toEqual([cssFamilyName(name), cssFamilyName(family.family)]);
      }
    }
  });

  it("adds nothing for a font it has no stand-in for", () => {
    expect(officeFontStack("Aptos")).toBe("'Aptos'");
    expect(officeFontStack("Calibri Light")).toBe("'Calibri Light'");
    expect(substituteFor("Comic Sans MS")).toBeUndefined();
    expect(officeFontStack(undefined)).toBe("");
    expect(officeFontStack("   ")).toBe("");
  });

  it("puts a document's own embedded copy ahead of everything", () => {
    expect(officeFontStack("Calibri", "Markie Embedded 3 1")).toBe("'Markie Embedded 3 1', 'Calibri', 'Carlito'");
  });

  it("stands in only with metric-compatible families, each of which is bundled", () => {
    const pairs = Object.fromEntries(BUNDLED_FAMILIES.flatMap((family) => (family.standsInFor ?? []).map((name) => [name, family.family])));
    expect(pairs).toMatchObject({ calibri: "Carlito", cambria: "Caladea", arial: "Arimo", helvetica: "Arimo", "times new roman": "Tinos", "courier new": "Cousine", georgia: "Gelasio" });
    expect(bundledFamiliesUsed([], ["Calibri", "Inter", "Nothing Known"]).map((family) => family.id)).toEqual(["inter", "carlito"]);
  });

  it("keeps a hostile font name inside one quoted string", () => {
    for (const name of ["Arial'; } body { display: none", "x\"); background: url(//evil.example/a)", "a\\'b", "</style><script>alert(1)</script>", "Evil, 'Second Family'"]) {
      const stack = officeFontStack(name);
      expect(stack).toMatch(/^'[A-Za-z0-9 \\]*'$/);
      expect(stack.slice(1, -1)).not.toMatch(/['";{}<>(),]/);
    }
    expect(officeFontStack("line\nbreak")).toBe("");
    expect(officeFontStack("x".repeat(201))).toBe("");
  });
});

describe("hostile and unknown font ids", () => {
  const before = TYPEFACE_LIST.length;
  const hostile = [
    "x; background: url(//evil.example)",
    "inter'; } * { display: none",
    "local:inter:Foo'; } body {",
    "local:inter:Foo\"); background: url(x)",
    "local:inter:a\nb",
    "local:inter:../../etc/passwd",
    "local:inter:Foo, Bar",
    "local:inter:",
    "local:inter: Padded ",
    "local:inter:Two  Spaces",
    "local:no-such-face:Futura",
    "local:Futura",
    "local::Futura",
    `local:inter:${"A".repeat(70)}`,
    "local:inter:<script>",
    "LOCAL:inter:Futura",
    "__proto__",
    "constructor",
    "",
  ];

  it("rejects every one, as a theme font and as a local font", () => {
    for (const id of hostile) {
      expect(parseLocalTypefaceId(id)).toBeNull();
      expect(adoptLocalTypeface(id)).toBeNull();
      expect(findTypeface(id)).toBeUndefined();
      const type = typographyOf({ bodyFont: id, headingFont: id });
      expect(type.bodyFont).toBe("system");
      expect(type.headingFont).toBe(HEADING_SAME_AS_BODY);
      expect(typographyVars({ bodyFont: id })["--doc-font-family"]).toBe("var(--font-geist-sans)");
      expect(cleanCodeFont(id)).toBe("");
      expect(codeFontStack(id)).toBe("");
    }
    for (const id of [null, 7, {}, [], undefined]) {
      expect(adoptLocalTypeface(id)).toBeNull();
      expect(cleanCodeFont(id)).toBe("");
    }
    adoptLocalTypefacesIn({ custom: [{ tokens: { bodyFont: hostile[2], headingFont: hostile[5] } }], typography: { bodyFont: hostile[10] } });
    expect(TYPEFACE_LIST.length).toBe(before);
  });

  it("will not let a bundled or system id be re-adopted as local", () => {
    expect(adoptLocalTypeface("inter")).toBeNull();
    expect(adoptLocalTypeface("system")).toBeNull();
    expect(TYPEFACE_LIST.length).toBe(before);
  });

  it("only takes a monospace face as the code font", () => {
    expect(cleanCodeFont("jetbrains-mono")).toBe("jetbrains-mono");
    expect(cleanCodeFont("mono")).toBe("mono");
    expect(cleanCodeFont("inter")).toBe("");
    expect(cleanCodeFont("lora")).toBe("");
    expect(codeFontStack("fira-code")).toMatch(/^'Fira Code', ui-monospace/);
  });
});

describe("fonts on this computer", () => {
  it("stores a local font as an id that names its bundled fallback", () => {
    expect(localTypefaceId("Futura")).toBe("local:inter:Futura");
    expect(localTypefaceId("Hoefler Text")).toBe("local:source-serif:Hoefler Text");
    expect(localTypefaceId("Menlo")).toBe("local:jetbrains-mono:Menlo");
    // A font with a metric-compatible stand-in falls back to that stand-in.
    expect(localTypefaceId("Calibri")).toBe("local:carlito:Calibri");
    expect(localTypefaceId("  Gill   Sans  ")).toBe("local:inter:Gill Sans");
    expect(localTypefaceId("Bad'Name")).toBeNull();
    expect(localTypefaceId(".SF NS")).toBeNull();
    expect(localFontKind("PT Sans")).toBe("sans");
    expect(localFontKind("PT Serif")).toBe("serif");
    expect(localFontKind("PT Mono")).toBe("mono");
  });

  it("paints the local font first and the bundled face wherever it is missing", () => {
    const id = localTypefaceId("Futura")!;
    expect(typographyOf({ bodyFont: id }).bodyFont).toBe("system");
    const face = adoptLocalTypeface(id)!;
    expect(face).toMatchObject({ id, kind: "sans", group: "local", localOnly: true, label: "Futura (only on this computer)" });
    expect(face.stack).toBe(`'Futura', ${bundledFamily("inter")!.stack}`);
    expect(adoptLocalTypeface(id)).toBe(face);
    expect(typographyOf({ bodyFont: id }).bodyFont).toBe(id);
    expect(typographyVars({ bodyFont: id })["--doc-font-family"]).toBe(face.stack);
    // The export and the hosted page need the fallback's files.
    expect(bundledFamiliesUsed([id]).map((family) => family.id)).toEqual(["inter"]);
  });

  it("adopts the local fonts inside a theme store from another computer", () => {
    const body = localTypefaceId("Avenir Next Condensed")!, heading = localTypefaceId("Didot")!;
    adoptLocalTypefacesIn({ activeId: "markie-dark", custom: [{ id: "c1", tokens: { bodyFont: body } }], typography: { headingFont: heading } });
    expect(typographyOf({ bodyFont: body, headingFont: heading })).toMatchObject({ bodyFont: body, headingFont: heading });
    expect(typefaceStack(heading)).toBe(`'Didot', ${bundledFamily("source-serif")!.stack}`);
  });

  it("finds a bundled family by its name, whatever the case", () => {
    expect(bundledFamilyNamed("jetbrains mono")?.id).toBe("jetbrains-mono");
    expect(bundledFamilyNamed("Nope")).toBeUndefined();
  });
});
