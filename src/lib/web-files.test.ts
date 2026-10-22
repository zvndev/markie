// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadWebDocument,
  pickWebDocument,
  readWebDocument,
  safeWebFileName,
  saveWebDocument,
  supportsWebFileSystemAccess,
  type WebFileHandle,
} from "./web-files";

function file(name: string, data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

function handle(name = "draft.txt") {
  const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
  const result: WebFileHandle = { name, getFile: async () => file(name, "hello"), createWritable: vi.fn().mockResolvedValue(stream) };
  return { result, stream };
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:download") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("browser document reading", () => {
  it("returns bytes and exact text metadata for plain text", async () => {
    const payload = await readWebDocument(file("draft.txt", "# literal text\r\n"));
    expect(payload.format.kind).toBe("text");
    expect(payload.text).toMatchObject({ text: "# literal text\r\n", newline: "crlf" });
    expect(Array.from(payload.bytes)).toEqual(Array.from(new TextEncoder().encode("# literal text\r\n")));
  });

  it("keeps DOCX and unsupported HTML as bytes, never decodes as Markdown", async () => {
    const docx = await readWebDocument(file("draft.docx", new Uint8Array([0x50, 0x4b, 3, 4])));
    expect(docx.format.kind).toBe("docx");
    expect(docx.text).toBeNull();
    const html = await readWebDocument(file("draft.html", "<script>alert(1)</script>"));
    expect(html.format.editing).toBe("unsupported");
    expect(html.text).toBeNull();
  });

  it("rejects binaries renamed as text", async () => {
    await expect(readWebDocument(file("draft.txt", new Uint8Array([0x50, 0x4b, 3, 4])))).rejects.toThrow();
  });

  it("bounds reads before allocating file data and checks actual bytes too", async () => {
    const oversized = { name: "large.txt", size: 20, arrayBuffer: vi.fn() };
    await expect(readWebDocument(oversized, { maxBytes: 10 })).rejects.toThrow(/large/i);
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    await expect(readWebDocument({ ...file("large.txt", "12345"), size: 1 }, { maxBytes: 4 })).rejects.toThrow(/large/i);
  });
});

describe("browser open picker", () => {
  it("feature-detects secure native pickers and returns their file handle", async () => {
    const { result } = handle();
    const picker = vi.fn().mockResolvedValue([result]);
    vi.stubGlobal("showOpenFilePicker", picker);
    expect(supportsWebFileSystemAccess().open).toBe(true);
    const payload = await pickWebDocument();
    expect(payload?.handle).toBe(result);
    expect(payload?.text?.text).toBe("hello");
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
  });

  it("lifts the type filter only for callers that ask for any file", async () => {
    const { result } = handle();
    const picker = vi.fn().mockResolvedValue([result]);
    vi.stubGlobal("showOpenFilePicker", picker);
    await pickWebDocument({ anyFile: true });
    expect(picker).toHaveBeenLastCalledWith({ multiple: false });
    await pickWebDocument();
    expect(picker.mock.lastCall![0].types).toHaveLength(1);
  });

  it("returns null on native cancellation, but surfaces permissions errors", async () => {
    vi.stubGlobal("showOpenFilePicker", vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")));
    await expect(pickWebDocument()).resolves.toBeNull();
    vi.stubGlobal("showOpenFilePicker", vi.fn().mockRejectedValue(new DOMException("Denied", "SecurityError")));
    await expect(pickWebDocument()).rejects.toThrow("Denied");
  });

  it("removes the fallback input when the browser reports cancellation", async () => {
    const promise = pickWebDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain(".docx");
    input.dispatchEvent(new Event("cancel"));
    await expect(promise).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("cleans fallback picker listeners/input on selection", async () => {
    const promise = pickWebDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file("notes.log", "log\n")] });
    input.dispatchEvent(new Event("change"));
    expect((await promise)?.text?.text).toBe("log\n");
    expect(input.isConnected).toBe(false);
  });

  it("handles cancellation in older browsers on focus without racing a change event", async () => {
    vi.useFakeTimers();
    const promise = pickWebDocument();
    window.dispatchEvent(new Event("focus"));
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("allows an unmounted UI to cancel and clean up the fallback picker", async () => {
    const controller = new AbortController();
    const promise = pickWebDocument({ signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("does not call native pickers in an insecure context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const picker = vi.fn();
    vi.stubGlobal("showOpenFilePicker", picker);
    const promise = pickWebDocument();
    document.querySelector('input[type="file"]')!.dispatchEvent(new Event("cancel"));
    await promise;
    expect(picker).not.toHaveBeenCalled();
  });
});

describe("browser saving", () => {
  const bytes = new Uint8Array([0x61, 0x0d, 0x0a, 0x62]);

  it("saves bytes directly and closes the stream before reporting success", async () => {
    const { result, stream } = handle();
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockResolvedValue(result));
    const receipt = await saveWebDocument({ name: "draft.txt", bytes });
    expect(receipt).toEqual({ method: "file-system", name: "draft.txt", handle: result });
    expect(stream.write).toHaveBeenCalledWith(bytes);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.abort).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reuses an explicitly supplied handle and never falls back on a failed write", async () => {
    const { result, stream } = handle();
    stream.write.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await expect(saveWebDocument({ name: "draft.txt", bytes, handle: result })).rejects.toThrow("Denied");
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("surfaces failed close and aborts the incomplete stream", async () => {
    const { result, stream } = handle();
    stream.close.mockRejectedValue(new Error("Disk full"));
    await expect(saveWebDocument({ name: "draft.txt", bytes, handle: result })).rejects.toThrow("Disk full");
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it("does not report success or export after the native save picker is cancelled", async () => {
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")));
    await expect(saveWebDocument({ name: "draft.txt", bytes })).resolves.toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not silently write TXT bytes into a selected DOCX path", async () => {
    const { result } = handle("different.docx");
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockResolvedValue(result));
    await expect(saveWebDocument({ name: "draft.txt", bytes })).rejects.toThrow(/format/i);
    expect(result.createWritable).not.toHaveBeenCalled();
  });

  it("snapshots bytes before the user returns from the native picker", async () => {
    const data = new Uint8Array([1, 2]);
    const { result, stream } = handle();
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockResolvedValue(result));
    const promise = saveWebDocument({ name: "draft.txt", bytes: data });
    data[0] = 9;
    await promise;
    expect(stream.write.mock.calls[0][0]).toEqual(new Uint8Array([1, 2]));
  });

  it("downloads without claiming a confirmed filesystem save, then revokes the Blob URL", async () => {
    vi.useFakeTimers();
    const click = vi.mocked(HTMLAnchorElement.prototype.click);
    const receipt = await saveWebDocument({ name: "../draft.txt", bytes });
    expect(receipt).toEqual({ method: "download", name: "draft.txt" });
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download]")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("cleans the anchor and URL even if launching the download fails", () => {
    vi.useFakeTimers();
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => { throw new Error("Download blocked"); });
    expect(() => downloadWebDocument({ name: "draft.txt", bytes })).toThrow("Download blocked");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it.each([
    ["C:\\folder\\draft.txt", "draft.txt"],
    ["../report.docx", "report.docx"],
    ["bad\u202etxt.exe.txt", "badtxt.exe.txt"],
    ["CON.txt", "_CON.txt"],
    ["   ", "untitled.txt"],
  ])("sanitizes %j to %j", (name, expected) => {
    expect(safeWebFileName(name)).toBe(expected);
  });
});
