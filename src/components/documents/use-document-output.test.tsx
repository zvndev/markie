import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, editOfficeDocument } from "@/lib/document-session";
import { applyDocxOperations, replaceDocxText, exportDocx } from "@/lib/office/docx";
import { useDocumentOutput } from "./use-document-output";
import { getSafeAPI } from "@/lib/electron";
import { exportRichDocument, openRichDocument, replaceRichText } from "@/lib/office/rich-document";
import { COMMENT_OUTPUT_CONFIRMATION } from "@/lib/document-output-policy";

vi.mock("@/lib/electron", () => ({ getSafeAPI: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function setup() {
  let session = await createDocumentSession("docx");
  const captureSession = () => session;
  let blocked = false;
  const exportPDF = vi.fn<(args: unknown) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>>(async () => ({ success: true, path: "/synthetic/out.pdf" }));
  vi.mocked(getSafeAPI).mockReturnValue({ exportPDF } as unknown as NonNullable<ReturnType<typeof getSafeAPI>>);
  const inputs = () => ({ session, captureSession, isBlocked: () => blocked });
  const hook = renderHook(() => useDocumentOutput(inputs()));
  return { hook, exportPDF, current: () => session, replace: (next: typeof session) => { session = next; }, block: () => { blocked = true; } };
}
describe("supported Word output capture", () => {
  it("discloses actual comment omission before native output and leaves cancellation source-neutral", async () => {
    const test = await setup(), original = test.current();
    test.replace(editOfficeDocument(original, applyDocxOperations(original.office!, [{ type: "add-comment", paragraphId: original.office!.paragraphs[0].id, text: "Review note", author: "Reader" }])));
    const snapshot = test.current(), bytes = await exportDocx(snapshot.office!);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(confirm).toHaveBeenCalledWith(COMMENT_OUTPUT_CONFIRMATION); expect(test.exportPDF).not.toHaveBeenCalled();
    expect(test.current()).toBe(snapshot); expect(await exportDocx(snapshot.office!)).toEqual(bytes);
    expect(test.hook.result.current.busy).toBe(false); expect(test.hook.result.current.notice).toBeUndefined();
    confirm.mockReturnValue(true);
    await act(async () => { await test.hook.result.current.execute("document-export-pdf"); });
    expect(test.exportPDF).toHaveBeenCalledOnce();
    expect((test.exportPDF.mock.calls[0][0] as { html: string }).html).not.toContain("Review note");
  });
  it("rechecks access after the comment-output confirmation", async () => {
    const test = await setup(), original = test.current();
    test.replace(editOfficeDocument(original, applyDocxOperations(original.office!, [{ type: "add-comment", paragraphId: original.office!.paragraphs[0].id, text: "Review note", author: "Reader" }])));
    vi.spyOn(window, "confirm").mockImplementation(() => { test.block(); return true; });
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(test.exportPDF).not.toHaveBeenCalled(); expect(test.hook.result.current.busy).toBe(false);
  });
  it.each(["rtf", "odt"] as const)("prints the supported %s model without converting or saving the source", async (format) => {
    const initial = await createDocumentSession(format);
    const rich = replaceRichText(initial.office!, [{ runId: initial.office!.paragraphs[0].runs[0].id, text: `Unsaved ${format.toUpperCase()} words` }]);
    const session = editOfficeDocument(initial, rich), before = await exportRichDocument(rich);
    const exportPDF = vi.fn<(args: unknown) => Promise<{ success: boolean; path: string }>>(async () => ({ success: true, path: "/synthetic/out.pdf" }));
    vi.mocked(getSafeAPI).mockReturnValue({ exportPDF } as unknown as NonNullable<ReturnType<typeof getSafeAPI>>);
    const hook = renderHook(() => useDocumentOutput({ session, captureSession: () => session, isBlocked: () => false }));
    expect(hook.result.current.eligible).toBe(true);
    await act(async () => { await hook.result.current.execute("document-print"); await hook.result.current.execute("document-export-pdf"); });
    expect(exportPDF).toHaveBeenCalledTimes(2);
    expect(exportPDF.mock.calls[0][0]).toMatchObject({ html: expect.stringContaining(`Unsaved ${format.toUpperCase()} words`), mode: "print" });
    expect(await exportRichDocument(rich)).toEqual(before);
    expect((await openRichDocument(format, before)).format).toBe(format);
    expect(session.generation).toBe(1); expect(session.persistedGeneration).toBe(-1);
    expect(hook.result.current.error).toBeUndefined();
    expect(hook.result.current.notice).toContain("source file was not changed");
  });
  it.each(["rtf", "odt"] as const)("does not print unsupported or blocked %s content", async (format) => {
    const original = await createDocumentSession(format);
    const session = { ...original, office: { ...original.office!, canEdit: false } }, exportPDF = vi.fn();
    vi.mocked(getSafeAPI).mockReturnValue({ exportPDF } as unknown as NonNullable<ReturnType<typeof getSafeAPI>>);
    const hook = renderHook(() => useDocumentOutput({ session, captureSession: () => session, isBlocked: () => false }));
    expect(hook.result.current.eligible).toBe(false);
    await act(async () => { await hook.result.current.execute("document-print"); });
    expect(exportPDF).not.toHaveBeenCalled();
  });
  it("captures the latest synchronous model, preserves bytes and generations, and omits file paths", async () => {
    const test = await setup(), first = test.current();
    const office = replaceDocxText(first.office!, [{ runId: first.office!.paragraphs[0].runs[0].id, text: "Latest unsaved words" }]);
    test.replace(editOfficeDocument(first, office));
    const before = test.current(), bytes = await exportDocx(before.office!);
    await act(async () => { await test.hook.result.current.execute("document-export-pdf"); });
    expect(test.exportPDF).toHaveBeenCalledOnce();
    expect(test.exportPDF.mock.calls[0][0]).toMatchObject({ html: expect.stringContaining("Latest unsaved words") });
    expect(test.exportPDF.mock.calls[0][0]).not.toHaveProperty("docPath");
    expect(test.exportPDF.mock.calls[0][0]).not.toHaveProperty("mode");
    expect(test.current()).toBe(before); expect(await exportDocx(before.office!)).toEqual(bytes);
    expect(test.hook.result.current.notice).toContain("Word file was not changed");
  });
  it("uses native print mode and refuses simultaneous output synchronously", async () => {
    const test = await setup(), pending = deferred<{ success: boolean }>();
    test.exportPDF.mockReturnValue(pending.promise);
    let first!: Promise<void>;
    act(() => { first = test.hook.result.current.execute("document-print"); void test.hook.result.current.execute("document-export-pdf"); });
    expect(test.exportPDF).toHaveBeenCalledOnce(); expect(test.exportPDF.mock.calls[0][0]).toMatchObject({ mode: "print" });
    expect(test.hook.result.current.busy).toBe(true); expect(test.hook.result.current.isBusy()).toBe(true);
    await act(async () => { pending.resolve({ success: true }); await first; });
    expect(test.hook.result.current.busy).toBe(false);
  });
  it("re-gates blocked, unknown, unsupported and pending-revision commands", async () => {
    const test = await setup(); test.block();
    await act(async () => { await test.hook.result.current.execute("document-print"); await test.hook.result.current.execute("unknown"); });
    expect(test.exportPDF).not.toHaveBeenCalled();
    const next = await setup(), session = next.current();
    next.replace({ ...session, office: { ...session.office!, canEdit: false } });
    await act(async () => { await next.hook.result.current.execute("document-print"); });
    expect(next.exportPDF).not.toHaveBeenCalled();
    const revisions = await setup(), original = revisions.current();
    revisions.replace(editOfficeDocument(original, applyDocxOperations(original.office!, [{ type: "track-paragraph-text", paragraphId: original.office!.paragraphs[0].id, text: "Pending text", author: "Writer" }])));
    await act(async () => { await revisions.hook.result.current.execute("document-print"); });
    expect(revisions.exportPDF).not.toHaveBeenCalled();
  });
  it("reports native resolved failures but not canceled sheets", async () => {
    const test = await setup(); test.exportPDF.mockResolvedValueOnce({ success: false, error: "Printer unavailable" }).mockResolvedValueOnce({ success: false, canceled: true });
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(test.hook.result.current.error).toBe("Printer unavailable");
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(test.hook.result.current.error).toBeUndefined(); expect(test.hook.result.current.notice).toBeUndefined();
  });
  it("does not report stale results on another session or after unmount", async () => {
    const test = await setup(), pending = deferred<{ success: boolean; error: string }>();
    test.exportPDF.mockReturnValue(pending.promise);
    let job!: Promise<void>; act(() => { job = test.hook.result.current.execute("document-print"); });
    test.replace(await createDocumentSession("docx")); test.hook.rerender();
    await act(async () => { pending.resolve({ success: false, error: "Old document failed" }); await job; });
    expect(test.hook.result.current.error).toBeUndefined();
    test.hook.unmount(); await test.hook.result.current.execute("document-print"); expect(test.exportPDF).toHaveBeenCalledOnce();
  });
  it("reports popup denial without claiming an export", async () => {
    const test = await setup(); vi.mocked(getSafeAPI).mockReturnValue(null); vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => { await test.hook.result.current.execute("document-export-pdf"); });
    expect(test.hook.result.current.error).toContain("Allow a print window"); expect(test.hook.result.current.notice).toBeUndefined();
  });
  it("closes its browser popup on printing, error and changed access", async () => {
    const test = await setup(); vi.mocked(getSafeAPI).mockReturnValue(null);
    const popup = { opener: window, document: { write: vi.fn(), close: vi.fn(), images: [], fonts: { ready: Promise.resolve() } }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(popup.opener).toBeNull(); expect(popup.print).toHaveBeenCalledOnce(); expect(popup.close).toHaveBeenCalledOnce();
    popup.print.mockImplementation(() => { throw new Error("Print refused"); });
    await act(async () => { await test.hook.result.current.execute("document-print"); });
    expect(popup.close).toHaveBeenCalledTimes(2); expect(test.hook.result.current.error).toBe("Print refused");
  });
  it("waits for raster decoding, closes on unmount and never prints afterward", async () => {
    const test = await setup(), decoded = deferred<void>(); vi.mocked(getSafeAPI).mockReturnValue(null);
    const popup = { opener: window, document: { write: vi.fn(), close: vi.fn(), images: [{ decode: vi.fn(() => decoded.promise) }], fonts: { ready: Promise.resolve() } }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    let job!: Promise<void>; act(() => { job = test.hook.result.current.execute("document-print"); });
    expect(popup.print).not.toHaveBeenCalled(); test.hook.unmount(); expect(popup.close).toHaveBeenCalledOnce();
    await act(async () => { decoded.resolve(); await job; });
    expect(popup.print).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalledOnce();
  });
});
