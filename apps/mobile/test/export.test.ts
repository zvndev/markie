// @vitest-environment jsdom
// Export: what each kind of document offers, the names files leave with, the
// HTML they are built from, the page the native printer is given, and the
// cleanup around the share sheet (src/lib/export.ts).
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { getPDFStylesSync } from "@/lib/pdf-styles";
import { createDocx, exportDocx, openDocx } from "@/lib/office/docx";
import {
  ANDROID_REMOVE_AFTER_MS,
  LIVE_DOC_TOO_LONG_NOTE,
  OFFICE_NO_PDF_NOTE,
  OFFICE_PDF_NOTE,
  OLD_WORD_NOTE,
  PAGE_BACKGROUND,
  STILL_COPY_NOTE,
  buildExportHtml,
  docExportSource,
  exportFileName,
  exportOffer,
  inlinePictures,
  platformExportSource,
  printJobFor,
  runExport,
  sourceFileName,
  type ExportDevice,
  type ExportSource,
} from "../src/lib/export";
import { SHARE_FOLDER } from "../src/lib/native";
import { ExportSection } from "../src/components/share-sheet";

// The compiler runs in a worker on a device; here it runs in place.
vi.mock("@/lib/darkmown/compiler-worker-client", async () => {
  const { compileDarkmown } = await import("@/lib/darkmown/compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const markdown = (text: string, name = "Notes.md", loadAsset?: ExportSource["loadAsset"]): ExportSource => docExportSource({ name, format: "markdown", content: text }, loadAsset);
const text = (content: string, name = "log.txt"): ExportSource => docExportSource({ name, format: "text", content });
const liveDoc = (content: string, name = "Plan.wd"): ExportSource => docExportSource({ name, format: "darkmown", content });
const COUNTER = `# Counter\n\n:state count = 0\n\nCount: { count }.\n\n:button "Add one" -> count++\n`;
const ids = (source: ExportSource) => exportOffer(source).options.map((option) => option.id);

async function wordSource(name = "Letter.docx", body = "Dear reader,\nThis is a letter.") {
  const bytes = await exportDocx(await createDocx(body));
  return platformExportSource(name, bytes, { document: await openDocx(bytes) });
}

/** A device that records what it was asked to do. */
function fakeDevice(platform: ExportDevice["platform"], { share = true, fail = "" }: { share?: boolean; fail?: "write" | "print" | "share" | "" } = {}) {
  const calls: string[] = [];
  const files = new Map<string, string | Uint8Array>();
  const timers: { work: () => void; ms: number }[] = [];
  const device: ExportDevice = {
    platform,
    async write(path, data) {
      calls.push(`write ${path}`);
      if (fail === "write") throw new Error("disk full");
      files.set(path, data);
      return `file:///cache/shared/${path}`;
    },
    async print(job, path) {
      calls.push(`print ${path}`);
      if (fail === "print") throw new Error("The PDF took too long and was stopped.");
      files.set(path, job.html);
      return `file:///cache/shared/${path}`;
    },
    async share(uri) {
      calls.push(`share ${uri}`);
      if (fail === "share") throw new Error("Error sharing item");
      return share;
    },
    async remove(folder) {
      calls.push(`remove ${folder}`);
      for (const path of Array.from(files.keys())) if (path.startsWith(`${folder}/`)) files.delete(path);
    },
    download(name, data, mimeType) { calls.push(`download ${name} ${mimeType} ${typeof data === "string" ? data.length : data.byteLength}`); },
    printWindow(html) { calls.push(`printWindow ${html.length}`); },
    later(work, ms) { timers.push({ work, ms }); },
  };
  return { device, calls, files, timers };
}

describe("what each kind of document offers", () => {
  it("offers Markdown and text the file, HTML, and PDF in light and dark", () => {
    expect(ids(markdown("# Hi"))).toEqual(["file", "html", "pdf", "pdf-dark"]);
    expect(ids(text("a,b\n1,2", "data.csv"))).toEqual(["file", "html", "pdf", "pdf-dark"]);
    expect(exportOffer(markdown("# Hi")).note).toBeNull();
  });

  it("offers a Live Doc its source, and HTML and PDF as a still copy that says so", () => {
    const offer = exportOffer(liveDoc(COUNTER));
    expect(offer.options.map((option) => option.id)).toEqual(["file", "html", "pdf", "pdf-dark"]);
    expect(offer.note).toBe(STILL_COPY_NOTE);
  });

  it("offers a Live Doc too long for a still copy its source only", () => {
    const offer = exportOffer(liveDoc("x".repeat(200_001)));
    expect(offer.options.map((option) => option.id)).toEqual(["file"]);
    expect(offer.note).toBe(LIVE_DOC_TOO_LONG_NOTE);
  });

  it("offers a Word file the original, and a PDF when the desktop's print view supports it", async () => {
    const source = await wordSource();
    expect(ids(source)).toEqual(["file", "pdf"]);
    expect(exportOffer(source).note).toBe(OFFICE_PDF_NOTE);
    expect(exportOffer(source).options.map((option) => option.fileName)).toEqual(["Letter.docx", "Letter.pdf"]);
  });

  it("offers a Word file the print view can't lay out the original only, and says why", async () => {
    const printable = await wordSource();
    if (printable.body.kind !== "office") throw new Error("expected a Word file");
    const source: ExportSource = { ...printable, body: { ...printable.body, printable: false } };
    expect(ids(source)).toEqual(["file"]);
    expect(exportOffer(source).note).toBe(OFFICE_NO_PDF_NOTE);
  });

  it("offers an old .doc the original only", async () => {
    const source = await platformExportSource("Old.doc", new Uint8Array([1, 2, 3]), null);
    expect(ids(source)).toEqual(["file"]);
    expect(exportOffer(source).note).toBe(OLD_WORD_NOTE);
  });

  it("reads a text file from the document platform as its own kind, and keeps its bytes", async () => {
    const bytes = new TextEncoder().encode("﻿# Stored\r\n");
    const md = await platformExportSource("Stored.md", bytes, { text: "# Stored\r\n" });
    expect(md.body.kind).toBe("markdown");
    expect(md.bytes).toBe(bytes);
    expect((await platformExportSource("data.json", bytes, { text: "{}" })).body.kind).toBe("text");
    expect((await platformExportSource("Plan.wd", bytes, { text: COUNTER })).body.kind).toBe("darkmown");
  });

  it("no plain no-reason line uses an em dash", () => {
    for (const line of [STILL_COPY_NOTE, LIVE_DOC_TOO_LONG_NOTE, OFFICE_PDF_NOTE, OFFICE_NO_PDF_NOTE, OLD_WORD_NOTE]) expect(line).not.toContain("—");
  });
});

describe("file names", () => {
  it("keeps the document's own name and extension for the copy", () => {
    expect(sourceFileName(markdown("", "Meeting notes.md"))).toBe("Meeting notes.md");
    expect(sourceFileName(text("", "data.csv"))).toBe("data.csv");
    expect(sourceFileName(liveDoc("", "Plan.wd"))).toBe("Plan.wd");
    expect(sourceFileName(markdown("", "v1.2 plan.markdown"))).toBe("v1.2 plan.markdown");
  });

  it("gives a name with no extension its kind's", () => {
    expect(sourceFileName(markdown("", "Untitled"))).toBe("Untitled.md");
    expect(sourceFileName(text("", "notes"))).toBe("notes.txt");
    expect(sourceFileName(liveDoc("", "Plan"))).toBe("Plan.wd");
  });

  it("swaps the extension for HTML and PDF", () => {
    expect(exportFileName(markdown("", "Meeting notes.md"), "pdf")).toBe("Meeting notes.pdf");
    expect(exportFileName(text("", "data.csv"), "html")).toBe("data.html");
    expect(exportFileName(markdown("", "v1.2 plan.md"), "html")).toBe("v1.2 plan.html");
  });

  it("never writes a path, a hidden file or an empty name", () => {
    expect(sourceFileName(markdown("", "../../etc/passwd.md"))).toBe("etc passwd.md");
    expect(sourceFileName(markdown("", "a/b\\c:d.md"))).toBe("a b c d.md");
    expect(sourceFileName(markdown("", ".env"))).toBe("env.md");
    expect(sourceFileName(markdown("", "   "))).toBe("Document.md");
    expect(exportFileName(markdown("", ".md"), "pdf")).toBe("md.pdf");
    expect(sourceFileName(markdown("", `${"x".repeat(400)}.md`))).toHaveLength(123);
    expect(sourceFileName(markdown("", "tab\tand\u0000null.md"))).toBe("tab and null.md");
  });
});

describe("the HTML an export writes", () => {
  it("is the desktop's export page: its stylesheet, its fit script, one self-contained file", async () => {
    const html = await buildExportHtml(markdown("# Title\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"), "light");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<article class="markdown-body">');
    expect(html).toContain("<strong>bold</strong>");
    // The desktop's light theme, and its page rule.
    expect(html).toContain("body { background: #fff; color: #1a1a2e; }");
    expect(html).toContain("size: A4;");
    expect(html).toContain('document.querySelector("article.markdown-body")');
    expect(html).toContain("<title>Notes</title>");
    // Nothing fetched from anywhere: no stylesheet link, no script file.
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    // The phone's own table scroller is for the screen, not for a file.
    expect(html).not.toContain("m-table-scroll");
  });

  it("has a dark theme", async () => {
    const html = await buildExportHtml(markdown("# Title"), "dark");
    expect(html).toContain("body { background: #09090b; color: #fafafa; }");
  });

  it("paints the paper the stylesheets paint, so the native printer fills the same colour", () => {
    expect(getPDFStylesSync("light")).toContain(`body { background: #fff;`);
    expect(PAGE_BACKGROUND.markdown.light).toBe("#ffffff");
    expect(getPDFStylesSync("dark")).toContain(`body { background: ${PAGE_BACKGROUND.markdown.dark};`);
    const still = read("../../../src/lib/darkmown/preview.ts");
    expect(still).toContain(`background:light-dark(#fff,${PAGE_BACKGROUND.darkmown.dark})`);
  });

  it("holds front matter aside, as the reading view does", async () => {
    const html = await buildExportHtml(markdown("---\ntitle: Secret plan\ntags: [a]\n---\n\n# Body\n"), "light");
    expect(html).toContain("Body</h1>");
    expect(html).not.toContain("Secret plan");
  });

  it("carries nothing a document wrote that could run", async () => {
    const html = await buildExportHtml(markdown('<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">\n\n[x](javascript:alert(3))\n\n<style>body{display:none}</style>'), "light");
    const article = html.slice(html.indexOf('<article class="markdown-body">'));
    expect(article).not.toMatch(/<script/i);
    expect(article).not.toMatch(/onerror/i);
    expect(article).not.toMatch(/javascript:/i);
    expect(article).not.toMatch(/<style/i);
  });

  it("escapes the document's name in the title", async () => {
    const html = await buildExportHtml(markdown("# x", "</title><script>alert(1)</script> Q&A 'notes'.md"), "light");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Q&amp;A &#39;notes&#39;</title>");
  });

  it("folds the document's own pictures in, and names one it couldn't fetch", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const asked: string[] = [];
    const loadAsset = async (ref: string) => {
      asked.push(ref);
      return ref === "shots/a b.png" ? new Blob([png], { type: "image/png" }) : null;
    };
    const html = await buildExportHtml(markdown("![one](shots/a%20b.png)\n\n![again](shots/a%20b.png)\n\n![gone](missing.png)\n\n![web](https://example.com/p.png)\n", "Notes.md", loadAsset), "light");
    expect(asked).toEqual(["shots/a b.png", "missing.png"]);
    expect(html.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(2);
    expect(html).toContain('<span class="markie-picture-missing">Picture not available: gone</span>');
    // A picture on the web keeps its address.
    expect(html).toContain('src="https://example.com/p.png"');
    expect(html).not.toContain('src="missing.png"');
  });

  it("still exports when no picture can be fetched, as for a document opened offline", async () => {
    const offline = async () => { throw new Error("The network connection was lost."); };
    const source = markdown("# Kept on the phone\n\n![chart](charts/a.png)\n\nStill here.\n", "Kept.md", offline);
    const html = await buildExportHtml(source, "light");
    expect(html).toContain("Still here.");
    expect(html).toContain('<span class="markie-picture-missing">Picture not available: chart</span>');
    // The file and HTML rows touch nothing but the device.
    const { device, calls } = fakeDevice("ios");
    expect(await runExport(source, "file", device)).toBe("shared");
    expect(await runExport(source, "html", device)).toBe("shared");
    expect(calls.filter((call) => call.startsWith("write "))).toHaveLength(2);
  });

  it("never folds in something that isn't a picture", async () => {
    const html = await inlinePictures('<img src="a.png" alt="a">', async () => new Blob(["<html>"], { type: "text/html" }));
    expect(html).toBe('<span class="markie-picture-missing">Picture not available: a</span>');
  });

  it("writes a text file as text, not as Markdown", async () => {
    const html = await buildExportHtml(text("# not a heading\n<b>not bold</b> & more\n  indented", "log.txt"), "light");
    expect(html).toContain('<pre class="markie-text"># not a heading\n&lt;b&gt;not bold&lt;/b&gt; &amp; more\n  indented</pre>');
    expect(html).not.toMatch(/<h1/);
    expect(html).toContain("pre.markie-text");
  });

  it("writes a Live Doc as the scriptless still preview, in either tone", async () => {
    const light = await buildExportHtml(liveDoc(COUNTER), "light");
    expect(light).toContain("script-src &#39;none&#39;");
    expect(light).not.toMatch(/<script/i);
    expect(light).toContain("color-scheme:light");
    expect(light).toMatch(/<button[^>]*disabled/);
    expect(await buildExportHtml(liveDoc(COUNTER), "dark")).toContain("color-scheme:dark");
  });

  it("writes a Word file as the desktop's print view, on the file's own page", async () => {
    const html = await buildExportHtml(await wordSource(), "light");
    expect(html).toMatch(/@page\{size:[\d.]+pt [\d.]+pt;margin:/);
    expect(html).toContain("Dear reader,");
    expect(html).toContain("<title>Letter</title>");
  });
});

describe("the page the printer is given", () => {
  it("is the desktop's page as it is on Android: no margins, the page insets itself", async () => {
    const source = markdown("# Title");
    const html = await buildExportHtml(source, "dark");
    const job = printJobFor(source, html, "dark", "android");
    expect(job.html).toBe(html);
    expect(job.margins).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(job.page.width).toBeCloseTo(595.28);
    expect(job.page.height).toBeCloseTo(841.89);
    expect(job.background).toBe("#09090b");
  });

  it("keeps the same inset as real margins on iOS, and takes the page's own padding off", async () => {
    const source = markdown("# Title");
    const html = await buildExportHtml(source, "light");
    const job = printJobFor(source, html, "light", "ios");
    // 2cm and 2.2cm, the desktop stylesheet's `padding: 2cm 2.2cm`.
    expect(job.margins.top).toBeCloseTo(56.69, 1);
    expect(job.margins.left).toBeCloseTo(62.36, 1);
    expect(getPDFStylesSync("light")).toContain("padding: 2cm 2.2cm;");
    expect(job.html).toContain("padding: 0 !important");
    expect(job.background).toBe("#ffffff");
    // Added to the head, never to the document.
    expect(job.html.indexOf("padding: 0 !important")).toBeLessThan(job.html.indexOf("</head>"));
  });

  it("gives a Live Doc's still copy the desktop's paper", async () => {
    const source = liveDoc(COUNTER);
    const html = await buildExportHtml(source, "dark");
    const android = printJobFor(source, html, "dark", "android");
    expect(android.html).toContain("padding: 2cm 2.2cm !important");
    expect(android.html).toContain("box-decoration-break: clone");
    expect(android.background).toBe("#18181b");
    expect(printJobFor(source, html, "dark", "ios").margins.top).toBeCloseTo(56.69, 1);
  });

  it("prints a Word file on its own page size and margins, on white", async () => {
    const source = await wordSource();
    if (source.body.kind !== "office" || !source.body.document) throw new Error("expected a Word file");
    const layout = source.body.document.pageLayout;
    for (const platform of ["ios", "android"] as const) {
      const job = printJobFor(source, "<html></html>", "light", platform);
      expect(job.page).toEqual({ width: layout.widthPoints, height: layout.heightPoints });
      expect(job.margins).toEqual({ top: layout.marginTopPoints, right: layout.marginRightPoints, bottom: layout.marginBottomPoints, left: layout.marginLeftPoints });
      expect(job.background).toBe("#ffffff");
      expect(job.html).toBe("<html></html>");
    }
  });
});

describe("making an export", () => {
  it("writes the document's own text under its own name, shares it, then removes it (iOS)", async () => {
    const { device, calls, files } = fakeDevice("ios");
    expect(await runExport(markdown("# Hi\n", "Meeting notes.md"), "file", device)).toBe("shared");
    expect(calls).toHaveLength(3);
    const folder = /^write (export-[a-z0-9-]+)\/Meeting notes\.md$/.exec(calls[0])![1];
    expect(calls[1]).toBe(`share file:///cache/shared/${folder}/Meeting notes.md`);
    expect(calls[2]).toBe(`remove ${folder}`);
    expect(files.size).toBe(0);
  });

  it("sends a stored file's own bytes, untouched", async () => {
    const { device, files } = fakeDevice("android");
    const source = await wordSource();
    await runExport(source, "file", device);
    expect(Array.from(files.values())[0]).toBe(source.bytes);
  });

  it("removes the file at once when the person backs out, on both platforms", async () => {
    for (const platform of ["ios", "android"] as const) {
      const { device, calls, files, timers } = fakeDevice(platform, { share: false });
      expect(await runExport(markdown("# Hi"), "html", device)).toBe("canceled");
      expect(calls.at(-1)).toMatch(/^remove export-/);
      expect(files.size).toBe(0);
      expect(timers).toHaveLength(0);
    }
  });

  it("leaves a shared file on Android long enough to be read, then removes it", async () => {
    const { device, calls, files, timers } = fakeDevice("android");
    expect(await runExport(markdown("# Hi"), "file", device)).toBe("shared");
    expect(calls.some((call) => call.startsWith("remove"))).toBe(false);
    expect(files.size).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(ANDROID_REMOVE_AFTER_MS);
    timers[0].work();
    await Promise.resolve();
    expect(files.size).toBe(0);
  });

  it("removes what it wrote when the share sheet fails", async () => {
    const { device, calls, files } = fakeDevice("ios", { fail: "share" });
    await expect(runExport(markdown("# Hi"), "file", device)).rejects.toThrow("Error sharing item");
    expect(calls.at(-1)).toMatch(/^remove export-/);
    expect(files.size).toBe(0);
  });

  it("writes nothing when the document can't be built", async () => {
    const { device, calls } = fakeDevice("ios");
    // Over the still preview's limit, asked for anyway.
    await expect(runExport(liveDoc("x".repeat(200_001)), "html", device)).rejects.toThrow();
    await expect(runExport(await platformExportSource("Old.doc", new Uint8Array([1]), null), "pdf", device)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("prints a PDF through the native printer under the PDF's name, light or dark", async () => {
    const { device, calls, files } = fakeDevice("android");
    await runExport(markdown("# Hi", "Notes.md"), "pdf-dark", device);
    expect(calls[0]).toMatch(/^print export-[a-z0-9-]+\/Notes\.pdf$/);
    expect(String(Array.from(files.values())[0])).toContain("body { background: #09090b;");
    const light = fakeDevice("ios");
    await runExport(markdown("# Hi", "Notes.md"), "pdf", light.device);
    expect(light.calls[0]).toMatch(/^print export-[a-z0-9-]+\/Notes\.pdf$/);
    expect(light.calls.at(-1)).toMatch(/^remove /);
  });

  it("gives each export a folder of its own", async () => {
    const { device, calls } = fakeDevice("ios");
    await runExport(markdown("# Hi"), "file", device);
    await runExport(markdown("# Hi"), "file", device);
    const folders = calls.filter((call) => call.startsWith("write ")).map((call) => call.split(" ")[1].split("/")[0]);
    expect(new Set(folders).size).toBe(2);
  });

  it("falls back to a download, and a print window for PDF, in a desktop browser", async () => {
    const { device, calls } = fakeDevice("web");
    expect(await runExport(markdown("# Hi\n", "Notes.md"), "file", device)).toBe("saved");
    expect(await runExport(markdown("# Hi\n", "Notes.md"), "html", device)).toBe("saved");
    expect(await runExport(markdown("# Hi\n", "Notes.md"), "pdf", device)).toBe("saved");
    expect(calls[0]).toBe("download Notes.md text/markdown 5");
    expect(calls[1]).toMatch(/^download Notes\.html text\/html \d+$/);
    expect(calls[2]).toMatch(/^printWindow \d+$/);
    expect(calls).toHaveLength(3);
  });
});

describe("where exported files live", () => {
  it("is the one cache folder the Android FileProvider may hand out", () => {
    const paths = read("../android/app/src/main/res/xml/file_paths.xml");
    expect(paths).toContain(`<cache-path name="shared" path="${SHARE_FOLDER}/" />`);
    expect(paths.match(/<[a-z-]+-path\b/g)).toHaveLength(1);
  });

  it("registers the PDF plugin on both platforms under the name the page calls", () => {
    expect(read("../src/lib/native.ts")).toContain('registerPlugin<MarkiePdfPlugin>("MarkiePdf")');
    expect(read("../ios/App/App/MarkiePdfPlugin.swift")).toContain('jsName = "MarkiePdf"');
    expect(read("../ios/App/App/MarkieBridgeViewController.swift")).toContain("registerPluginInstance(MarkiePdfPlugin())");
    expect(read("../android/app/src/main/java/com/zvn/markie/mobile/MarkiePdfPlugin.java")).toContain('@CapacitorPlugin(name = "MarkiePdf")');
    expect(read("../android/app/src/main/java/com/zvn/markie/mobile/MainActivity.java")).toContain("registerPlugin(MarkiePdfPlugin.class)");
  });
});

describe("the export rows in the share sheet", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  async function mount(source: ExportSource, device: ExportDevice) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(ExportSection, { source, device })); });
    return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
  }

  it("lists what the document offers, with the name each file leaves with", async () => {
    const { host, unmount } = await mount(markdown("# Hi", "Notes.md"), fakeDevice("ios").device);
    const rows = Array.from(host.querySelectorAll("button[data-export]"));
    expect(rows.map((row) => row.getAttribute("data-export"))).toEqual(["file", "html", "pdf", "pdf-dark"]);
    expect(rows.map((row) => row.textContent)).toEqual(["Copy of the fileNotes.md", "HTMLNotes.html", "PDFNotes.pdf", "PDF, darkNotes.pdf"]);
    expect(host.querySelector("[data-export-note]")).toBeNull();
    await unmount();
  });

  it("says a Live Doc's HTML and PDF are a still copy", async () => {
    const { host, unmount } = await mount(liveDoc(COUNTER), fakeDevice("ios").device);
    expect(host.querySelector("[data-export-note]")?.textContent).toBe(STILL_COPY_NOTE);
    await unmount();
  });

  it("runs the export a row names, and shows a failure in plain words", async () => {
    const good = fakeDevice("ios");
    const first = await mount(markdown("# Hi", "Notes.md"), good.device);
    await act(async () => { first.host.querySelector<HTMLButtonElement>('button[data-export="file"]')!.click(); });
    expect(good.calls[0]).toMatch(/^write export-[a-z0-9-]+\/Notes\.md$/);
    expect(first.host.querySelector('[role="alert"]')).toBeNull();
    await first.unmount();

    const bad = fakeDevice("ios", { fail: "print" });
    const second = await mount(markdown("# Hi", "Notes.md"), bad.device);
    await act(async () => { second.host.querySelector<HTMLButtonElement>('button[data-export="pdf"]')!.click(); });
    expect(second.host.querySelector('[role="alert"]')?.textContent).toBe("The PDF took too long and was stopped.");
    await second.unmount();
  });
});
