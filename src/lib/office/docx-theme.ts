/** Original display-only ECMA-376 theme subset. No resource loading or export mutations.
 * Word HSL transforms (MS-OI29500 §2.1.72), with our deterministic channel rounding:
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/8229a077-7fc8-4fba-96cc-c77b6a4fc768
 * Font slot cascade (MS-OI29500 §2.1.88); language-dependent selection stays unresolved:
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/aef3c9a6-5d6c-434b-90b7-85e761fd8e62
 * Color mapping: ECMA-376 Part 1 §§17.18.97,17.18.103. Stored sysClr lastClr is a
 * deterministic fallback, not a query of the current operating system's colors. */
import type { DocxPartsState } from "./docx-parts";
import { decodeDocxXml } from "./docx-encoding";
import { WORD_NAMESPACES, isWord } from "./docx-edit";
import { parseXml, xmlAttribute, type XmlElement } from "./xml";

const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const R = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
const DRAWING = ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"];
const wordValue = (node: XmlElement | undefined, name = "val") => node && xmlAttribute(node, name, node.namespace);
const uniqueChild = (node: XmlElement | undefined, name: string, namespaces: readonly string[]) => {
  const matches = node?.children.filter((child) => child.localName === name && namespaces.includes(child.namespace));
  return matches?.length === 1 ? matches[0] : undefined;
};
const wordChild = (node: XmlElement | undefined, name: string) => uniqueChild(node, name, WORD_NAMESPACES);
const drawingChild = (node: XmlElement | undefined, name: string) => uniqueChild(node, name, node ? [node.namespace] : DRAWING);
const RGB = /^[\da-f]{6}$/i;
const SYSTEM_COLORS = new Set("scrollBar background activeCaption inactiveCaption menu window windowFrame menuText windowText captionText activeBorder inactiveBorder appWorkspace highlight highlightText btnFace btnShadow grayText btnText inactiveCaptionText btnHighlight 3dDkShadow 3dLight infoText infoBk hotLight gradientActiveCaption gradientInactiveCaption menuHighlight menuBar".split(" "));

/** Unlike editing-part lookup, display dependencies must be unique, internal,
 * safely addressed and declared with the exact expected content type. */
function dependency(state: DocxPartsState, kind: "theme" | "settings", read: (name: string) => XmlElement | undefined): { root?: XmlElement; absent: boolean } {
  try {
    const slash = state.mainPart.lastIndexOf("/");
    const relationships = read(`${state.mainPart.slice(0, slash + 1)}_rels/${state.mainPart.slice(slash + 1)}.rels`);
    if (!relationships) return { absent: true };
    if (relationships.localName !== "Relationships" || relationships.namespace !== REL) return { absent: false };
    const matches = relationships.children.filter((node) => node.localName === "Relationship" && node.namespace === REL && R.some((namespace) => xmlAttribute(node, "Type") === `${namespace}/${kind}`));
    if (!matches.length) return { absent: true };
    if (matches.length !== 1) return { absent: false };
    const relationship = matches[0], id = xmlAttribute(relationship, "Id"), target = xmlAttribute(relationship, "Target");
    if (!id || relationships.children.filter((node) => xmlAttribute(node, "Id") === id).length !== 1
      || ![undefined, "Internal"].includes(xmlAttribute(relationship, "TargetMode"))
      || !target || /[\\%?#\s:]/.test(target)) return { absent: false };
    const segments = target.startsWith("/") ? [] : state.mainPart.split("/").slice(0, -1);
    for (const segment of target.replace(/^\//, "").split("/")) {
      if (!segment) return { absent: false };
      if (segment === ".") continue;
      if (segment === "..") { if (!segments.length) return { absent: false }; segments.pop(); }
      else segments.push(segment);
    }
    const name = segments.join("/"), manifest = read("[Content_Types].xml");
    if (!manifest) return { absent: false };
    if (manifest.localName !== "Types" || manifest.namespace !== TYPES) return { absent: false };
    const overrides = manifest.children.filter((node) => node.namespace === TYPES && node.localName === "Override" && xmlAttribute(node, "PartName") === `/${name}`);
    const defaults = manifest.children.filter((node) => node.namespace === TYPES && node.localName === "Default" && xmlAttribute(node, "Extension")?.toLowerCase() === name.split(".").pop()?.toLowerCase());
    const declaration = overrides.length ? overrides : defaults;
    const expected = kind === "theme" ? "application/vnd.openxmlformats-officedocument.theme+xml" : "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
    if (declaration.length !== 1 || xmlAttribute(declaration[0], "ContentType") !== expected) return { absent: false };
    const root = read(name);
    return root?.localName === kind && (kind === "theme" ? DRAWING : WORD_NAMESPACES).includes(root.namespace) ? { root, absent: false } : { absent: false };
  } catch { return { absent: false }; }
}

const mappingKeys: Readonly<Record<string, string>> = {
  dark1: "t1", text1: "t1", dark2: "t2", text2: "t2", light1: "bg1", background1: "bg1", light2: "bg2", background2: "bg2",
  accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hyperlink: "hyperlink", followedHyperlink: "followedHyperlink",
};
const defaultMapping: Readonly<Record<string, string>> = { t1: "dark1", t2: "dark2", bg1: "light1", bg2: "light2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hyperlink: "hyperlink", followedHyperlink: "followedHyperlink" };
const drawingSlots: Readonly<Record<string, string>> = { dark1: "dk1", dark2: "dk2", light1: "lt1", light2: "lt2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hyperlink: "hlink", followedHyperlink: "folHlink" };

function transformColor(rgb: string, tint: string | undefined, shade: string | undefined): string | undefined {
  const amount = tint ?? shade;
  if (amount === undefined) return rgb;
  if (!/^[\da-f]{2}$/i.test(amount)) return undefined;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(rgb.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const factor = parseInt(amount, 16) / 255, next = lightness * factor + (tint !== undefined ? 1 - factor : 0);
  const chroma = (1 - Math.abs(2 * next - 1)) * saturation, x = chroma * (1 - Math.abs(hue % 2 - 1)), m = next - chroma / 2;
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  // Our deterministic display rounding; the specification does not define
  // Word's complete integer quantization algorithm.
  return channels.map((channel) => Math.round(Math.max(0, Math.min(1, channel + m)) * 255).toString(16).padStart(2, "0")).join("");
}

type FontAuthority = { literal?: string; theme?: string };
export function docxThemeResolver(state: DocxPartsState) {
  const parsed = new Map<string, XmlElement | undefined>();
  const read = (name: string): XmlElement | undefined => {
    if (parsed.has(name)) return parsed.get(name);
    const bytes = state.deletedParts?.has(name) ? undefined : state.partOverrides.get(name) ?? state.entries.find((part) => part.name === name)?.data;
    const root = bytes ? parseXml(decodeDocxXml(bytes).text) : undefined;
    parsed.set(name, root);
    return root;
  };
  const theme = dependency(state, "theme", read), settings = dependency(state, "settings", read);
  const elements = drawingChild(theme.root, "themeElements"), colors = drawingChild(elements, "clrScheme"), fonts = drawingChild(elements, "fontScheme");
  const mappings = settings.root?.children.filter((node) => isWord(node, "clrSchemeMapping")) ?? [];
  const languages = settings.root?.children.filter((node) => isWord(node, "themeFontLang")) ?? [];
  const settingsKnown = settings.absent || !!settings.root;
  const latinThemeKnown = settingsKnown && languages.length <= 1 && wordValue(languages[0]) === undefined;
  // Validate fixed theme slots once. Supplemental-font/unknown-node lists may
  // be large, but must never be rescanned for each displayed run or keystroke.
  const latinFonts = new Map(["major", "minor"].map((kind) => {
    const family = drawingChild(fonts, `${kind}Font`), latin = drawingChild(family, "latin");
    const typeface = latin && !latin.children.length ? xmlAttribute(latin, "typeface") : undefined;
    return [kind, typeface?.trim() ? typeface : undefined] as const;
  }));
  const palette = new Map(Object.values(drawingSlots).map((slot) => {
    const selected = drawingChild(colors, slot);
    let rgb: string | undefined;
    if (selected?.children.length === 1) {
      const value = selected.children[0];
      const candidate = xmlAttribute(value, value.localName === "sysClr" ? "lastClr" : "val");
      if (value.namespace === colors?.namespace && !value.children.length && ["srgbClr", "sysClr"].includes(value.localName)
        && candidate && RGB.test(candidate) && (value.localName !== "sysClr" || SYSTEM_COLORS.has(xmlAttribute(value, "val") ?? ""))) rgb = candidate.toLowerCase();
    }
    return [slot, rgb] as const;
  }));
  const mappedColors = new Map(Object.entries(mappingKeys).map(([token, key]) => {
    const mapped = wordValue(mappings[0], key) ?? defaultMapping[key];
    const slot = Object.hasOwn(drawingSlots, mapped) ? drawingSlots[mapped] : undefined;
    return [token, settingsKnown && mappings.length <= 1 && slot ? palette.get(slot) : undefined] as const;
  }));
  const color = (node: XmlElement): string | undefined => {
    const token = wordValue(node, "themeColor");
    if (token === undefined) return wordValue(node);
    const rgb = mappedColors.get(token);
    if (!rgb) return undefined;
    return transformColor(rgb, wordValue(node, "themeTint"), wordValue(node, "themeShade"));
  };
  const font = (authority: FontAuthority | undefined, guarded: boolean): string | undefined => {
    // Script/slot ambiguity applies equally to literal and theme authority.
    // A supplied theme language only limits theme lookup, not Latin literals.
    if (!authority || guarded) return undefined;
    if (authority.theme === undefined) return authority.literal || undefined;
    if (!latinThemeKnown || !/^(major|minor)(Ascii|HAnsi)$/.test(authority.theme)) return undefined;
    return latinFonts.get(authority.theme.startsWith("major") ? "major" : "minor");
  };
  return {
    run(layers: readonly (XmlElement | undefined)[], text: string): { fontFamily?: string; color?: string } {
      const slots: Partial<Record<"ascii" | "hAnsi", FontAuthority>> = {};
      let effectiveColor: string | undefined, hasColor = false, cs = false, rtl = false, hint: string | undefined, ambiguousFont = false;
      for (const layer of layers) {
        const fontNodes = layer?.children.filter((node) => isWord(node, "rFonts")) ?? [];
        if (fontNodes.length > 1) ambiguousFont = true;
        const fontNode = wordChild(layer, "rFonts");
        for (const slot of ["ascii", "hAnsi"] as const) {
          const literal = wordValue(fontNode, slot), theme = wordValue(fontNode, `${slot}Theme`);
          if (literal !== undefined || theme !== undefined) slots[slot] = theme !== undefined ? { theme } : { literal };
        }
        hint = wordValue(fontNode, "hint") ?? hint;
        for (const name of ["cs", "rtl"] as const) {
          const node = wordChild(layer, name);
          if (node) { const on = !["false", "0", "off"].includes(wordValue(node) ?? "true"); if (name === "cs") cs = on; else rtl = on; }
        }
        const colorNodes = layer?.children.filter((node) => isWord(node, "color")) ?? [];
        if (colorNodes.length) { hasColor = true; effectiveColor = colorNodes.length === 1 ? color(colorNodes[0]) : undefined; }
      }
      const unsupportedScript = /[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]/u.test(text);
      const guarded = cs || rtl || (hint !== undefined && hint !== "default") || unsupportedScript || ambiguousFont;
      const ascii = slots.ascii, hAnsi = slots.hAnsi;
      const selected = /[^\x00-\x7f]/.test(text) && !unsupportedScript ? hAnsi : ascii;
      let fontFamily = ambiguousFont ? undefined : font(selected, guarded);
      if (/[^\x00-\x7f]/.test(text) && /[\x00-\x7f]/.test(text) && !unsupportedScript && font(ascii, guarded) !== font(hAnsi, guarded)) fontFamily = undefined;
      return { fontFamily, ...(hasColor ? { color: effectiveColor } : {}) };
    },
  };
}
