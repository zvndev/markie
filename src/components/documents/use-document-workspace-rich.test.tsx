import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentWorkspace } from "./use-document-workspace";
import { createMemoryDocumentLibrary } from "@/lib/document-library";
import { classifyDocumentFormat } from "@/lib/document-formats";
import { applyRichOperations, createRichDocument, exportRichDocument, openRichDocument, replaceRichText } from "@/lib/office/rich-document";

afterEach(cleanup);
describe("native rich sessions in the existing workspace", () => {
  it.each(["rtf", "odt"] as const)("opens %s directly, saves its real bytes and recovers its original type", async (format) => {
    const library = createMemoryDocumentLibrary();
    const source = await exportRichDocument(await createRichDocument(format, "Original"));
    const saveDocument = vi.fn(async (document: { bytes: Uint8Array }) => { expect(document.bytes.length).toBeGreaterThan(0); return { method: "download" as const, name: `letter.${format}` }; });
    const shareDocument = vi.fn(async () => "Shared");
    const hook = renderHook(() => useDocumentWorkspace({ library, saveDocument, shareDocument }));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    let accepted = false;
    await act(async () => { accepted = await hook.result.current.importPayload({ name: `letter.${format}`, bytes: source, text: null, format: classifyDocumentFormat(`letter.${format}`) }); });
    expect(accepted).toBe(true); expect(hook.result.current.conversion).toBeNull();
    const session = hook.result.current.session!;
    expect(session.office?.format).toBe(format); expect(session.name).toBe(`letter.${format}`);
    const office = applyRichOperations(replaceRichText(session.office!, [{ runId: session.office!.paragraphs[0].runs[0].id, text: "Changed" }]), [{ type: "format-run", runId: session.office!.paragraphs[0].runs[0].id, style: { italic: true } }]);
    act(() => hook.result.current.changeOffice(office));
    await act(async () => { await hook.result.current.recoverNow(); });
    expect(hook.result.current.session?.record?.format).toBe(format);
    await act(async () => { await hook.result.current.saveFile(true); });
    expect(saveDocument).toHaveBeenCalledOnce();
    const reopened = await openRichDocument(format, saveDocument.mock.calls[0][0].bytes);
    expect(reopened.text).toBe("Changed"); expect(reopened.paragraphs[0].runs[0].style.italic).toBe(true);
    await act(async () => { await hook.result.current.share(); });
    expect(shareDocument).not.toHaveBeenCalled(); expect(hook.result.current.error).toContain("Cloud sharing for RTF and ODT is not supported");
    expect(source).toEqual(await exportRichDocument(await createRichDocument(format, "Original")));
    hook.unmount(); library.close();
  });
  it("leaves malformed RTF and ODT unopened without replacing the active text session", async () => {
    const library = createMemoryDocumentLibrary();
    const hook = renderHook(() => useDocumentWorkspace({ library }));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(async () => { await hook.result.current.create("text"); });
    act(() => hook.result.current.changeText("Keep me"));
    for (const name of ["bad.rtf", "bad.odt"]) {
      await act(async () => { expect(await hook.result.current.importPayload({ name, bytes: new TextEncoder().encode("invalid"), text: null, format: classifyDocumentFormat(name) })).toBe(false); });
      expect(hook.result.current.session?.text).toBe("Keep me"); expect(hook.result.current.session?.format).toBe("text"); expect(hook.result.current.conversion).toBeNull();
    }
    hook.unmount(); library.close();
  });
});
