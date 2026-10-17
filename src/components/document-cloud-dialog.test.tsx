import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

const state = vi.hoisted(() => ({ token: "test-session", base: "https://markie.test", confirmed: true, download: vi.fn(), auth: { user: { id: "user", email: "user@example.test", name: "Test" } as { id: string; email: string; name: string } | null, status: "in" }, listeners: new Set<() => void>() }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => state.token, getServerURL: () => state.base, getConfirmedAuthIdentity: () => state.confirmed && state.auth.status === "in" && state.auth.user ? { userId: state.auth.user.id, serverURL: state.base } : null, authClient: {}, authFailureCode: () => "" }));
vi.mock("@/lib/auth-store", () => ({ useAuth: () => state.auth, authStore: { getSnapshot: () => state.auth, subscribe: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } } }));
vi.mock("./sign-in", () => ({ SignInForm: () => <p>Sign in</p> }));
vi.mock("@/lib/web-files", () => ({ downloadWebDocument: state.download }));
import { DocumentCloudDialog } from "./document-cloud-dialog";
import { DocumentCloudClient } from "@/lib/document-cloud";
import { createDocx, exportDocx } from "@/lib/office/docx";

async function snapshot(name = "cloud.txt", role = "owner", bytes: Uint8Array = new TextEncoder().encode("Synthetic cloud body")) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return { schemaVersion: 2, id: "cloud-id", name, role, version: 1, format: name.endsWith("docx") ? "docx" : name.endsWith("md") ? "markdown" : "text", createdAt: 1, updatedAt: 2, byteLength: bytes.length, encoding: "base64", data: btoa(String.fromCharCode(...bytes)), sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

beforeEach(() => {
  state.token = "test-session"; state.base = "https://markie.test"; state.confirmed = true; state.download.mockReset();
  state.auth = { user: { id: "user", email: "user@example.test", name: "Test" }, status: "in" };
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("explicit ordinary cloud sharing", () => {
  it("does not issue a seedless request for a stale unconfirmed signed-in account", async () => {
    state.confirmed = false; const request = vi.fn(); vi.stubGlobal("fetch", request);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("confirm your account on this server");
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download a local copy instead" })).toBeDisabled();
  });
  it("keeps permission-denied loading distinct from an empty cloud document", async () => {
    const request = vi.fn(async () => Response.json({ error: "denied" }, { status: 403 })); vi.stubGlobal("fetch", request);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("do not have permission");
    expect(screen.queryByRole("textbox", { name: "Cloud document text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create a cloud copy" })).toBeNull();
  });
  it.each(["format", "missing-role"])("does not open an editable seedless snapshot with invalid %s metadata", async (invalid) => {
    const document = { ...await snapshot(), ...(invalid === "format" ? { format: "docx" } : { role: undefined }) };
    const request = vi.fn(async () => Response.json({ document })); vi.stubGlobal("fetch", request);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/metadata|permissions/);
    expect(screen.queryByRole("textbox", { name: "Cloud document text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save this snapshot to cloud" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download a local copy instead" })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["cloud.txt", "cloud.md", "cloud.docx"])("opens %s by Cloud ID without a seed local document or upload", async (name) => {
    const bytes = name.endsWith("docx") ? await exportDocx(await createDocx("Synthetic cloud Word")) : undefined;
    const document = await snapshot(name, "owner", bytes);
    const request = vi.fn(async () => Response.json({ document })); vi.stubGlobal("fetch", request);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    if (name.endsWith("docx")) {
      expect(await screen.findByRole("button", { name: "Document commands" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Bold" })).toBeVisible();
    } else expect(await screen.findByDisplayValue("Synthetic cloud body")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create a cloud copy" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(["https://markie.test/api/document-platform/documents/cloud-id", expect.objectContaining({ method: "GET" })]);
    expect(state.download).not.toHaveBeenCalled();
  });

  it("keeps viewer text read-only and refuses write shortcuts", async () => {
    const document = await snapshot("cloud.txt", "viewer"), request = vi.fn(async () => Response.json({ document })); vi.stubGlobal("fetch", request);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    const editor = await screen.findByDisplayValue("Synthetic cloud body"); expect(editor).toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "Rejected viewer edit" } });
    expect(editor).toHaveValue("Synthetic cloud body");
    expect(screen.getByRole("button", { name: "Save this snapshot to cloud" })).toBeDisabled();
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves the losing edited buffer, version and close guard after a 409", async () => {
    const document = await snapshot();
    const request = vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT" ? Response.json({ serverVersion: 2 }, { status: 409 }) : Response.json({ document })); vi.stubGlobal("fetch", request);
    const close = vi.fn(), guard = vi.fn(); vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={close} onCloseGuard={guard} />);
    const editor = await screen.findByDisplayValue("Synthetic cloud body");
    fireEvent.change(editor, { target: { value: "Synthetic losing edits retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this snapshot to cloud" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("newer cloud version");
    expect(editor).toHaveValue("Synthetic losing edits retained");
    expect(JSON.parse(String(request.mock.calls[1][1].body))).toMatchObject({ baseVersion: 1, data: btoa("Synthetic losing edits retained") });
    expect(guard.mock.calls.at(-1)?.[0]()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download edited copy" }));
    await waitFor(() => expect(state.download).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(state.download.mock.calls[0][0].bytes)).toBe("Synthetic losing edits retained");
    expect(request.mock.calls.map((call) => call[1].method)).toEqual(["GET", "PUT"]);
  });

  it.each(["id", "version", "bytes", "digest", "name", "role"])("keeps edited seedless bytes and base version after a mismatched %s save acknowledgment", async (mismatch) => {
    const document = await snapshot(); let corruptAcknowledgment = true;
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== "PUT") return Response.json({ document });
      const body = JSON.parse(String(init.body));
      const acknowledged = { ...body, id: document.id, version: body.baseVersion + 1, role: "owner" };
      if (corruptAcknowledgment) {
        if (mismatch === "id") acknowledged.id = "other-id";
        if (mismatch === "version") acknowledged.version = body.baseVersion;
        if (mismatch === "bytes") { acknowledged.data = document.data; acknowledged.sha256 = document.sha256; }
        if (mismatch === "digest") acknowledged.sha256 = "0".repeat(64);
        if (mismatch === "name") acknowledged.name = "other.txt";
        if (mismatch === "role") acknowledged.role = "viewer";
      }
      return Response.json({ document: acknowledged });
    });
    vi.stubGlobal("fetch", request); vi.spyOn(window, "confirm").mockReturnValue(false);
    const close = vi.fn(), guard = vi.fn();
    render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={close} onCloseGuard={guard} />);
    const editor = await screen.findByDisplayValue("Synthetic cloud body");
    fireEvent.change(editor, { target: { value: "Synthetic submitted edits" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this snapshot to cloud" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/acknowledgment|integrity/);
    expect(editor).toHaveValue("Synthetic submitted edits");
    expect(screen.getByText("Cloud edits are not saved yet.")).toBeVisible();
    expect(screen.getByText(/Cloud version 1\./)).toBeVisible();
    expect(guard.mock.calls.at(-1)?.[0]()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download edited copy" }));
    await waitFor(() => expect(state.download).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(state.download.mock.calls[0][0].bytes)).toBe("Synthetic submitted edits");

    corruptAcknowledgment = false;
    fireEvent.click(screen.getByRole("button", { name: "Save this snapshot to cloud" }));
    await screen.findByText("Cloud copy saved. It is separate from your local recovery copy.");
    expect(JSON.parse(String(request.mock.calls[2][1].body))).toMatchObject({ baseVersion: 1, data: btoa("Synthetic submitted edits") });
    expect(request.mock.calls[2][0]).toMatch(/\/documents\/cloud-id$/);
    expect(screen.getByText(/Cloud version 2\./)).toBeVisible();
    expect(screen.getByText("No unsaved cloud edits.")).toBeVisible();
    expect(editor).toHaveValue("Synthetic submitted edits");
    expect(guard.mock.calls.at(-1)?.[0]()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(close).toHaveBeenCalledWith("Cloud copy saved.");
  });

  it("aborts seedless loading and rejects a late response before decoding on unmount", async () => {
    let finish!: (response: Response) => void; let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise<Response>((resolve) => { finish = resolve; }); }));
    const decode = vi.spyOn(DocumentCloudClient.prototype, "decode"), document = await snapshot();
    const view = render(<DocumentCloudDialog cloudDocumentId="cloud-id" onClose={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount(); expect(signal?.aborted).toBe(true);
    finish(Response.json({ document }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decode).not.toHaveBeenCalled(); decode.mockRestore();
  });
  it("does not upload on open or cancel, and can export without uploading", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const close = vi.fn();
    render(<DocumentCloudDialog file={{ name: "copy.txt", bytes: new TextEncoder().encode("private local copy") }} onClose={close} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download a local copy instead" }));
    await waitFor(() => expect(state.download).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledWith(null);
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps keyboard focus inside the Cloud modal", () => {
    render(<DocumentCloudDialog file={{ name: "copy.txt", bytes: new Uint8Array() }} onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close" }), download = screen.getByRole("button", { name: "Download a local copy instead" });
    close.focus(); fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(download).toHaveFocus();
    fireEvent.keyDown(download, { key: "Tab" }); expect(close).toHaveFocus();
  });

  it("only creates a cloud copy after its explicit publish action", async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ document: { ...body, id: "document-id", role: "owner", version: 1 } });
    });
    vi.stubGlobal("fetch", request);
    const close = vi.fn();
    render(<DocumentCloudDialog file={{ name: "copy.txt", bytes: new TextEncoder().encode("local copy") }} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a cloud copy" }));
    await screen.findByText("Cloud copy saved. It is separate from your local recovery copy.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Add access" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledWith("Cloud copy saved.");
  });

  it("keeps the local copy and does not claim a link when the server is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    render(<DocumentCloudDialog file={{ name: "copy.txt", bytes: new Uint8Array() }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a cloud copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not provide");
    expect(screen.queryByRole("textbox", { name: "Read-only download link" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download a local copy instead" })).toBeEnabled();
  });

  it("rejects a late successful response after the account changed", async () => {
    let respond: ((response: Response) => void) | undefined;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Promise<Response>((resolve) => { respond = resolve; });
    }));
    render(<DocumentCloudDialog file={{ name: "copy.txt", bytes: new Uint8Array() }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a cloud copy" }));
    await waitFor(() => expect(respond).toBeTypeOf("function"));
    state.token = "different-account";
    respond!(Response.json({ document: { ...requestBody, id: "doc", role: "owner", version: 1 } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("account or document changed");
    expect(screen.queryByRole("button", { name: "Create 24-hour read-only link" })).toBeNull();
  });

  it("clears a loaded private copy as soon as sign-out starts, even while the token remains", async () => {
    const bytes = new TextEncoder().encode("synthetic account-A cloud body");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const snapshot = { schemaVersion: 2, id: "cloud-a", name: "private-a.txt", role: "owner", version: 1, format: "text", createdAt: 1, updatedAt: 2, byteLength: bytes.length, encoding: "base64", data: btoa(String.fromCharCode(...bytes)), sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/documents") ? { documents: [snapshot] } : { document: snapshot })));
    const file = { name: "local.txt", bytes: new TextEncoder().encode("separate local body") };
    const view = render(<DocumentCloudDialog file={file} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse cloud documents" }));
    fireEvent.click(await screen.findByRole("button", { name: /private-a.txt · owner/ }));
    const cloudEditor = await screen.findByDisplayValue("synthetic account-A cloud body");
    fireEvent.change(cloudEditor, { target: { value: "Synthetic unsaved cloud edits" } });
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload); expect(dirtyUnload.defaultPrevented).toBe(true);
    state.auth = { user: null, status: "out" };
    view.rerender(<DocumentCloudDialog file={file} onClose={() => {}} />);
    expect(state.token).toBe("test-session");
    expect(screen.queryByDisplayValue("synthetic account-A cloud body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download edited copy" })).toBeNull();
    const clearedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clearedUnload); expect(clearedUnload.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Download a local copy instead" }));
    await waitFor(() => expect(state.download).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(state.download.mock.calls[0][0].bytes)).toBe("separate local body");
  });

  it("starts a fresh editor session on every successful cloud load, including the same version", async () => {
    const snapshots = await Promise.all(["a", "b"].map(async (id) => {
      const bytes = new TextEncoder().encode(`Synthetic ${id} body`);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return { schemaVersion: 2, id, name: `${id}.txt`, role: "owner", version: 1, format: "text", createdAt: 1, updatedAt: 2, byteLength: bytes.length, encoding: "base64", data: btoa(String.fromCharCode(...bytes)), sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/documents") ? { documents: snapshots } : { document: snapshots.find((item) => url.endsWith(`/${item.id}`)) })));
    render(<DocumentCloudDialog file={{ name: "local.txt", bytes: new Uint8Array() }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse cloud documents" }));
    fireEvent.click(await screen.findByRole("button", { name: /a.txt · owner/ }));
    const first = await screen.findByDisplayValue("Synthetic a body");
    fireEvent.click(screen.getByRole("button", { name: /b.txt · owner/ }));
    const second = await screen.findByDisplayValue("Synthetic b body");
    expect(second).not.toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "Open current cloud version for editing" }));
    await waitFor(() => expect(screen.getByDisplayValue("Synthetic b body")).not.toBe(second));
  });
});
