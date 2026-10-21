import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_APP_FORMATS, PENDING_DEFAULT_FORMATS, MARKIE_BUNDLE_ID, parseStatus, setScript, statusScript } from "./default-apps.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const builder = require("../electron-builder.config.cjs");

describe("default apps", () => {
  it("offers document formats, not data files or logs", () => {
    const offered = DEFAULT_APP_FORMATS.map((format: { id: string }) => format.id);
    expect(offered).toEqual(["markdown", "text", "darkmown", "docx", "rtf", "odt"]);
    for (const id of ["csv", "json", "yaml", "xml"]) expect(offered).not.toContain(id);
    expect(DEFAULT_APP_FORMATS.flatMap((format: { extensions: string[] }) => format.extensions)).not.toContain(".log");
    expect(PENDING_DEFAULT_FORMATS).toEqual([]);
  });

  it("notes the read-only caveat on every office format, and reports it", () => {
    for (const id of ["docx", "rtf", "odt"]) expect(DEFAULT_APP_FORMATS.find((format: { id: string }) => format.id === id)?.note).toMatch(/read-only/);
    const docx = parseStatus("").find((format: { id: string }) => format.id === "docx");
    expect(docx).toMatchObject({ note: expect.stringMatching(/read-only/), isDefault: false });
    expect(parseStatus("").find((format: { id: string }) => format.id === "markdown")).not.toHaveProperty("note");
  });

  it("reports a format as Markie's only when every one of its types is", () => {
    const stdout = [
      `net.daringfireball.markdown\t${MARKIE_BUNDLE_ID}`,
      `public.plain-text\t${MARKIE_BUNDLE_ID.toUpperCase()}`,
      `public.rtf\t${MARKIE_BUNDLE_ID}`,
      "org.openxmlformats.wordprocessingml.document\tcom.microsoft.Word",
    ].join("\n");
    const status = Object.fromEntries(parseStatus(stdout).map((format: { id: string; isDefault: boolean }) => [format.id, format.isDefault]));
    expect(status).toMatchObject({ markdown: true, text: true, rtf: true, docx: false, odt: false });
  });

  it("only interpolates well-formed type identifiers into Swift", () => {
    const script = setScript(["public.json", "x\"); exit(0); (\""]);
    expect(script).toContain('"public.json"');
    expect(script).not.toContain("exit(0); (");
    expect(statusScript(["public.xml"])).toContain("LSCopyDefaultRoleHandlerForContentType");
  });

  it("declares every offered content type in the packaged app", () => {
    const claimed = new Set(builder.mac.extendInfo.CFBundleDocumentTypes.flatMap((type: { LSItemContentTypes: string[] }) => type.LSItemContentTypes));
    for (const format of DEFAULT_APP_FORMATS) for (const uti of format.utis) expect(claimed, uti).toContain(uti);
  });

  it("never claims a text or office type ahead of the user's own editor", () => {
    const ranks = Object.fromEntries(builder.mac.extendInfo.CFBundleDocumentTypes.flatMap((type: { LSItemContentTypes: string[]; LSHandlerRank: string }) => type.LSItemContentTypes.map((uti) => [uti, type.LSHandlerRank])));
    for (const uti of ["public.plain-text", "public.json", "public.yaml", "public.xml", "public.comma-separated-values-text", "org.openxmlformats.wordprocessingml.document", "public.rtf", "org.oasis-open.opendocument.text"]) expect(ranks[uti]).toBe("Alternate");
  });

  it("keeps the desktop preview from claiming document types", () => {
    const source = readFileSync(new URL("../electron-builder.preview.cjs", import.meta.url), "utf8");
    expect(source).toMatch(/extendInfo: _types, \.\.\.mac/);
    expect(source).toContain("mac: { ...mac,");
  });
});
