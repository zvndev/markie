// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { extractHtmlText } from "./html";
import { DocumentImportError, resolveDocumentImportLimits } from "./types";
const bytes = (text: string) => new TextEncoder().encode(text);
const html = (text: string) => extractHtmlText(bytes(text), resolveDocumentImportLimits());

describe("standards-based inert HTML text-copy extraction", () => {
  it("extracts paragraph/heading/inline text and native character references in order", () => {
    expect(html("<h1>Title</h1><p>Alpha <strong>bold</strong> tail</p><p>Next &amp; &#x1F600; &NotEqualTilde;</p>").text).toBe("Title\nAlpha bold tail\nNext & 😀 ≂̸");
  });
  it("flattens table cells and explicit breaks while preserving preformatted text", () => {
    expect(html("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table><pre>  x\n y</pre><p>a<br>b</p>").text).toBe("A\tB\nC\tD\n  x\n y\na\nb");
  });
  it("does not execute scripts, custom elements, event handlers, forms or insert live nodes", () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const constructor = vi.fn();
    if (!customElements.get("import-probe")) customElements.define("import-probe", class extends HTMLElement { constructor() { super(); constructor(); } });
    const before = document.body.innerHTML;
    const result = html('<script>globalThis.__importExecuted=true</script><import-probe>safe custom text</import-probe><form><p>private form</p></form><img src="https://invalid.example/image" onerror="globalThis.__importExecuted=true"><iframe src="https://invalid.example/frame">private frame</iframe><p>visible</p>');
    expect(result.text).toBe("safe custom text\nvisible"); expect((globalThis as { __importExecuted?: boolean }).__importExecuted).toBeUndefined();
    expect(constructor).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(document.body.innerHTML).toBe(before); fetcher.mockRestore();
  });
  it("omits explicit hidden/metadata/foreign/closed content and states CSS visibility limits", () => {
    const result = html('<html><head><title>private title</title><style>.hidden{display:none}</style></head><body><p hidden>hidden</p><p aria-hidden="true">aria</p><p style="display:none">css</p><p style="visibility:hidden">visibility</p><svg><text>foreign secret</text></svg><dialog>closed</dialog><details><summary>Summary</summary>closed body</details><p>Visible</p></body></html>');
    expect(result.text).toBe("Summary\nVisible"); expect(result.warnings.join(" ")).toContain("stylesheet class rules"); expect(result.warnings.join(" ")).toContain("omitted");
  });
  it("reads BOM UTF-16 and rejects invalid or unlabelled legacy encoding", () => {
    const source = "<p>世界</p>", utf16 = new Uint8Array(2 + source.length * 2); utf16.set([255, 254]); const view = new DataView(utf16.buffer);
    for (let i = 0; i < source.length; i++) view.setUint16(2 + i * 2, source.charCodeAt(i), true);
    expect(extractHtmlText(utf16, resolveDocumentImportLimits()).text).toBe("世界");
    expect(() => extractHtmlText(new Uint8Array([0xff]), resolveDocumentImportLimits())).toThrow(DocumentImportError);
  });
  it("budgets visible and omitted/template nodes, depth, comments and output", () => {
    for (const [source, limits] of [["<p><span>text</span></p>", { maxNodes: 2 }], ["<p><span>text</span></p>", { maxDepth: 2 }], ["<template><p>hidden</p></template>", { maxNodes: 2 }], ["<!--a--><!--b--><!--c-->", { maxNodes: 2 }], ["<p>1234</p>", { maxTextCodeUnits: 3 }]] as const) expect(() => extractHtmlText(bytes(source), resolveDocumentImportLimits(limits))).toThrow(DocumentImportError);
  });
  it("keeps raw script and literal less-than characters from bypassing node preflight", () => {
    expect(html('<script>var less = "<";</script><p>Visible &lt; 3</p>').text).toBe("Visible < 3");
    expect(() => extractHtmlText(bytes('<p>literal < 3</p>' + "<i>x</i>".repeat(30)), resolveDocumentImportLimits({ maxNodes: 10 }))).toThrow(DocumentImportError);
    expect(() => html("<!--unterminated")).toThrow(DocumentImportError);
  });
});
