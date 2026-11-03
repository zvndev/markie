import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentExport } from "./use-export";

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const inputs = (onError = vi.fn()) => ({
  previewHTML: async () => "",
  currentMarkdown: () => "# Title\n\nBody",
  docPath: () => null,
  fileName: "Plan.md",
  onError,
});

describe("useDocumentExport exportAs", () => {
  it("downloads the converted bytes in a browser, named after the document", async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { created.push(blob as Blob); return "blob:x"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    const onError = vi.fn();
    const { result } = renderHook(() => useDocumentExport(inputs(onError)));
    await act(async () => { await result.current.exportAs("rtf"); });
    expect(clicks).toEqual(["Plan.rtf"]);
    expect(created[0].type).toBe("application/rtf");
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(created[0]); });
    expect(text).toMatch(/^\{\\rtf1/);
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("hands the bytes to main's save sheet on the desktop", async () => {
    const exportDocument = vi.fn(async () => ({ success: true, path: "/tmp/Plan.txt" }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { exportDocument };
    const { result } = renderHook(() => useDocumentExport(inputs()));
    await act(async () => { await result.current.exportAs("txt"); });
    expect(exportDocument).toHaveBeenCalledOnce();
    const arg = (exportDocument.mock.calls[0] as unknown[])[0] as { format: string; defaultName: string; data: Uint8Array };
    expect(arg).toMatchObject({ format: "txt", defaultName: "Plan.txt" });
    expect(new TextDecoder().decode(arg.data)).toBe("Title\n\nBody\n");
  });
});
