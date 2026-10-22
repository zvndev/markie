import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentWorkspace } from "./use-document-workspace";
import { createMemoryDocumentLibrary } from "@/lib/document-library";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument } from "@/lib/document-formats";

afterEach(cleanup);
describe("Darkmown local source sessions", () => {
  it("imports literal .wd, saves and recovers its source without uploading it", async () => {
    const library = createMemoryDocumentLibrary();
    const source = ':state count = 0\r\n\r\nCount: { count }.\r\n\r\n:button "Add one" -> count++\r\n';
    const bytes = encodeTextDocument(source, { encoding: "utf-16le", bom: true });
    const saveDocument = vi.fn(async () => ({ method: "download" as const, name: "Counter.wd" }));
    const shareDocument = vi.fn(async () => "Shared");
    const hook = renderHook(() => useDocumentWorkspace({ library, saveDocument, shareDocument }));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(async () => {
      expect(await hook.result.current.importPayload({ name: "Counter.wd", bytes, text: decodeTextDocument(bytes), format: classifyDocumentFormat("Counter.wd") })).toBe(true);
    });
    expect(hook.result.current.session).toMatchObject({ format: "darkmown", office: null, text: source });
    expect(hook.result.current.conversion).toBeNull();
    await act(async () => { await hook.result.current.saveFile(true); });
    expect(saveDocument).toHaveBeenCalledOnce();
    expect((saveDocument.mock.calls[0] as unknown as [{ bytes: Uint8Array }])[0].bytes).toEqual(bytes);
    act(() => hook.result.current.changeText(source.replace("count = 0", "count = 5")));
    await act(async () => { await hook.result.current.recoverNow(); });
    const record = hook.result.current.session!.record!;
    expect(record.format).toBe("darkmown");
    await act(async () => { await hook.result.current.open(record); });
    expect(hook.result.current.session?.text).toContain("count = 5");
    await act(async () => { await hook.result.current.share(); });
    expect(shareDocument).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("Darkmown cloud sharing is not supported yet");
    hook.unmount(); library.close();
  });
});
