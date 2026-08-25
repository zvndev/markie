import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import realFs from "node:fs";
import realOs from "node:os";
import path from "node:path";

const load = createRequire(import.meta.url);
const { createPdfExporter, ensureExtension } = load("./export-pdf.js");

// A stand-in for Electron's BrowserWindow that records what a real export
// would have done to it — loaded, printed, destroyed — so the lifecycle can be
// asserted without the binary.
interface FakeOptions {
  loadFile?: () => Promise<void>;
  printToPDF?: () => Promise<Buffer>;
  executeJavaScript?: () => Promise<unknown>;
  destroyedAfterLoad?: boolean;
  print?: () =>
    | { success: boolean; failureReason?: string }
    | Promise<{ success: boolean; failureReason?: string }>;
}

let created: FakeWindow[];

class FakeWindow {
  destroyed = false;
  loaded: string[] = [];
  // What the temp file held at load time — it is deleted before the export
  // returns, so it can only be read here.
  loadedContent: string[] = [];
  printed = 0;
  systemPrints: unknown[] = [];
  scripts: string[] = [];
  windowOpenHandler: (() => { action: string }) | null = null;
  listeners: Record<string, Array<(event: { preventDefault: () => void }) => void>> = {};
  webContents: {
    isDestroyed: () => boolean;
    executeJavaScript: (src: string) => Promise<unknown>;
    printToPDF: () => Promise<Buffer>;
    print: (
      options: unknown,
      cb: (success: boolean, failureReason?: string) => void
    ) => void;
    setWindowOpenHandler: (fn: () => { action: string }) => void;
    on: (event: string, fn: (event: { preventDefault: () => void }) => void) => void;
  };

  constructor(private opts: FakeOptions = {}) {
    created.push(this);
    this.webContents = {
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: (fn) => {
        this.windowOpenHandler = fn;
      },
      on: (event, fn) => {
        (this.listeners[event] ||= []).push(fn);
      },
      executeJavaScript: async (src: string) => {
        this.scripts.push(src);
        return this.opts.executeJavaScript ? this.opts.executeJavaScript() : true;
      },
      print: (options, cb) => {
        this.systemPrints.push(options);
        const res = this.opts.print ? this.opts.print() : { success: true };
        // A real sheet answers whenever the person does — allow a fake that
        // takes its time.
        Promise.resolve(res).then((r) => cb(r.success, r.failureReason));
      },
      printToPDF: async () => {
        this.printed++;
        return this.opts.printToPDF
          ? this.opts.printToPDF()
          : Buffer.from("%PDF-1.7 fake");
      },
    };
  }

  async loadFile(file: string) {
    this.loaded.push(file);
    try {
      this.loadedContent.push(realFs.readFileSync(file, "utf-8"));
    } catch {
      // a missing file is its own test failure downstream
    }
    if (this.opts.loadFile) await this.opts.loadFile();
    if (this.opts.destroyedAfterLoad) this.destroyed = true;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }
}

function makeExporter(opts: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const errors: unknown[] = [];
  const exporter = createPdfExporter({
    BrowserWindow: function (this: unknown) {
      return new FakeWindow(opts);
    } as unknown as new () => FakeWindow,
    fs: realFs,
    os: realOs,
    path,
    onError: (err: unknown) => errors.push(err),
    ...extra,
  });
  return { exporter, errors };
}

let outDir: string;

beforeEach(() => {
  created = [];
  outDir = realFs.mkdtempSync(path.join(realOs.tmpdir(), "markie-pdf-out-"));
});

describe("ensureExtension", () => {
  it("adds the extension when the user typed none", () => {
    expect(ensureExtension("/tmp/notes", ".pdf")).toBe("/tmp/notes.pdf");
  });

  it("leaves an existing extension alone, case-insensitively", () => {
    expect(ensureExtension("/tmp/notes.PDF", ".pdf")).toBe("/tmp/notes.PDF");
    expect(ensureExtension("/tmp/notes.pdf", ".pdf")).toBe("/tmp/notes.pdf");
  });

  it("does not invent a path out of nothing", () => {
    expect(ensureExtension("", ".pdf")).toBe("");
  });
});

describe("createPdfExporter", () => {
  it("writes the PDF and reports the path", async () => {
    const { exporter } = makeExporter();
    const target = path.join(outDir, "doc.pdf");

    const res = await exporter.exportPdf({ html: "<h1>hi</h1>", filePath: target });

    expect(res).toEqual({ success: true, path: target });
    expect(realFs.readFileSync(target, "utf-8")).toContain("%PDF");
  });

  it("renders from a temp file, never a data: URL, and removes it afterwards", async () => {
    const { exporter } = makeExporter();
    await exporter.exportPdf({ html: "<h1>hi</h1>", filePath: path.join(outDir, "d.pdf") });

    const win = created[0];
    expect(win.loaded).toHaveLength(1);
    const tmp = win.loaded[0];
    expect(tmp.startsWith("data:")).toBe(false);
    expect(tmp.endsWith(".html")).toBe(true);
    expect(realFs.existsSync(tmp)).toBe(false);
  });

  it("writes the temp HTML into a private directory, then removes the directory", async () => {
    const { exporter } = makeExporter();
    await exporter.exportPdf({ html: "<h1>hi</h1>", filePath: path.join(outDir, "d.pdf") });

    const tmp = created[0].loaded[0];
    const dir = path.dirname(tmp);
    expect(path.basename(dir).startsWith("markie-export-")).toBe(true);
    expect(path.basename(tmp)).toBe("doc.html");
    // The whole directory goes, not just the file inside it.
    expect(realFs.existsSync(dir)).toBe(false);
  });

  it("refuses to open windows or navigate away from the document it prints", async () => {
    const { exporter } = makeExporter();
    await exporter.exportPdf({ html: "<h1>hi</h1>", filePath: path.join(outDir, "d.pdf") });

    const win = created[0];
    expect(win.windowOpenHandler?.()).toEqual({ action: "deny" });

    let prevented = false;
    const handlers = win.listeners["will-navigate"] ?? [];
    expect(handlers).toHaveLength(1);
    handlers[0]({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });

  it("waits for fonts and two frames instead of a fixed sleep", async () => {
    const { exporter } = makeExporter();
    await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });

    const script = created[0].scripts.join("\n");
    expect(script).toContain("document.fonts");
    expect(script).toContain("requestAnimationFrame");
  });

  it("normalises the extension the dialog handed back", async () => {
    const { exporter } = makeExporter();
    const res = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "notes") });
    expect(res.path).toBe(path.join(outDir, "notes.pdf"));
    expect(realFs.existsSync(res.path)).toBe(true);
  });

  it("destroys the hidden window and deletes the temp file when printing throws", async () => {
    const { exporter, errors } = makeExporter({
      printToPDF: () => Promise.reject(new Error("Error: print failed")),
    });

    const res = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });

    expect(res.success).toBe(false);
    expect(res.error).toBe("print failed");
    expect(created[0].isDestroyed()).toBe(true);
    expect(realFs.existsSync(created[0].loaded[0])).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("does not print into a window that died during load", async () => {
    const { exporter } = makeExporter({ destroyedAfterLoad: true });

    const res = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });

    expect(res.success).toBe(false);
    expect(res.error).toContain("closed");
    expect(created[0].printed).toBe(0);
  });

  it("gives up after the timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const { exporter } = makeExporter(
        { loadFile: () => new Promise(() => {}) },
        { timeoutMs: 30_000 }
      );
      const pending = exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });
      await vi.advanceTimersByTimeAsync(30_001);
      const res = await pending;

      expect(res.success).toBe(false);
      expect(res.error).toContain("too long");
      expect(created[0].isDestroyed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a second export while one is in flight, then frees up", async () => {
    let release: () => void = () => {};
    let gated = true;
    const { exporter } = makeExporter({
      loadFile: () =>
        gated
          ? new Promise<void>((resolve) => {
              gated = false;
              release = resolve;
            })
          : Promise.resolve(),
    });

    const first = exporter.exportPdf({ html: "x", filePath: path.join(outDir, "a.pdf") });
    expect(exporter.isBusy()).toBe(true);

    const second = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "b.pdf") });
    expect(second.success).toBe(false);
    expect(second.error).toContain("already exporting");
    expect(created).toHaveLength(1);

    release();
    await first;
    expect(exporter.isBusy()).toBe(false);

    const third = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "c.pdf") });
    expect(third.success).toBe(true);
  });

  it("clears the in-flight guard even when the export fails", async () => {
    const { exporter } = makeExporter({ printToPDF: () => Promise.reject(new Error("no")) });
    await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });
    expect(exporter.isBusy()).toBe(false);
  });

  it("answers rather than throwing when no destination was chosen", async () => {
    const { exporter } = makeExporter();
    const res = await exporter.exportPdf({ html: "x" });
    expect(res).toEqual({ success: false, error: "No destination was chosen." });
    expect(created).toHaveLength(0);
  });

  it("reports an unwritable destination as a readable error", async () => {
    const { exporter } = makeExporter();
    const res = await exporter.exportPdf({
      html: "x",
      filePath: path.join(outDir, "missing-dir", "d.pdf"),
    });
    expect(res.success).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error.startsWith("Error:")).toBe(false);
    expect(created[0].isDestroyed()).toBe(true);
  });

  describe("images from the document folder", () => {
    it("inlines them before the temp file is written", async () => {
      const seen: Array<[string, string]> = [];
      const { exporter } = makeExporter(
        {},
        {
          inlineImages: (html: string, dir: string) => {
            seen.push([html, dir]);
            return "<h1>inlined</h1>";
          },
        }
      );

      await exporter.exportPdf({
        html: "<h1>hi</h1>",
        filePath: path.join(outDir, "d.pdf"),
        docPath: path.join(outDir, "notes.md"),
      });

      expect(seen).toEqual([["<h1>hi</h1>", outDir]]);
      // The window rendered the rewritten HTML, not the original.
      expect(created[0].loaded).toHaveLength(1);
      expect(created[0].loadedContent).toEqual(["<h1>inlined</h1>"]);
    });

    it("leaves the HTML alone when no docPath is given", async () => {
      let called = 0;
      const { exporter } = makeExporter(
        {},
        {
          inlineImages: () => {
            called++;
            return "";
          },
        }
      );
      const res = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });
      expect(res.success).toBe(true);
      expect(called).toBe(0);
    });

    it("still exports when inlining throws", async () => {
      const { exporter, errors } = makeExporter(
        {},
        {
          inlineImages: () => {
            throw new Error("bad image");
          },
        }
      );
      const res = await exporter.exportPdf({
        html: "x",
        filePath: path.join(outDir, "d.pdf"),
        docPath: path.join(outDir, "notes.md"),
      });
      expect(res.success).toBe(true);
      expect(errors).toHaveLength(1);
    });
  });

  describe("mode: print", () => {
    it("opens the system print dialog instead of writing a file", async () => {
      const { exporter } = makeExporter();
      const res = await exporter.exportPdf({ html: "<h1>hi</h1>", mode: "print" });

      expect(res).toEqual({ success: true, printed: true });
      expect(created[0].printed).toBe(0);
      expect(created[0].systemPrints).toEqual([{ silent: false }]);
    });

    it("gives the person at the print sheet longer than the render deadline", async () => {
      const { exporter } = makeExporter(
        {
          print: () =>
            new Promise((resolve) => setTimeout(() => resolve({ success: true }), 120)),
        },
        { timeoutMs: 20 }
      );
      // Layout is bounded by timeoutMs; the open sheet must not be.
      const res = await exporter.exportPdf({ html: "x", mode: "print" });
      expect(res).toEqual({ success: true, printed: true });
    });

    it("needs no destination, and cleans up the temp directory afterwards", async () => {
      const { exporter } = makeExporter();
      await exporter.exportPdf({ html: "x", mode: "print" });

      const tmp = created[0].loaded[0];
      expect(path.basename(tmp)).toBe("doc.html");
      expect(realFs.existsSync(path.dirname(tmp))).toBe(false);
      expect(created[0].isDestroyed()).toBe(true);
    });

    it("waits for readiness the same way the PDF export does", async () => {
      const { exporter } = makeExporter();
      await exporter.exportPdf({ html: "x", mode: "print" });
      const script = created[0].scripts.join("\n");
      expect(script).toContain("document.fonts");
    });

    it("inlines document images too", async () => {
      const seen: string[] = [];
      const { exporter } = makeExporter(
        {},
        {
          inlineImages: (html: string, dir: string) => {
            seen.push(dir);
            return html;
          },
        }
      );
      await exporter.exportPdf({
        html: "x",
        mode: "print",
        docPath: path.join(outDir, "notes.md"),
      });
      expect(seen).toEqual([outDir]);
    });

    it("treats a dismissed print sheet as a cancellation, not a failure", async () => {
      const { exporter, errors } = makeExporter({
        print: () => ({ success: false, failureReason: "cancelled" }),
      });
      const res = await exporter.exportPdf({ html: "x", mode: "print" });
      expect(res).toEqual({ success: false, canceled: true });
      expect(errors).toHaveLength(0);
    });

    it("reports a real print failure", async () => {
      const { exporter, errors } = makeExporter({
        print: () => ({ success: false, failureReason: "Printer not found" }),
      });
      const res = await exporter.exportPdf({ html: "x", mode: "print" });
      expect(res.success).toBe(false);
      expect(res.error).toBe("Printer not found");
      expect(created[0].isDestroyed()).toBe(true);
      expect(errors).toHaveLength(1);
    });

    it("shares the in-flight guard with the PDF export", async () => {
      let release: () => void = () => {};
      const { exporter } = makeExporter({
        loadFile: () => new Promise<void>((resolve) => { release = resolve; }),
      });
      const first = exporter.exportPdf({ html: "x", mode: "print" });
      const second = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });
      expect(second.success).toBe(false);
      expect(second.error).toContain("already exporting");
      release();
      await first;
      expect(exporter.isBusy()).toBe(false);
    });
  });

  it("accepts the mode and docPath as a second options argument", async () => {
    const { exporter } = makeExporter();
    const res = await exporter.exportPdf({ html: "x" }, { mode: "print" });
    expect(res).toEqual({ success: true, printed: true });
  });

  it("survives a page whose readiness probe throws", async () => {
    const { exporter } = makeExporter({
      executeJavaScript: () => Promise.reject(new Error("no javascript")),
    });
    const res = await exporter.exportPdf({ html: "x", filePath: path.join(outDir, "d.pdf") });
    expect(res.success).toBe(true);
  });
});
