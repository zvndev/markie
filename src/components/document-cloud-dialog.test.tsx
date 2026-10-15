import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

const state = vi.hoisted(() => ({ token: "test-session", base: "https://markie.test", download: vi.fn(), auth: { user: { id: "user", email: "user@example.test", name: "Test" } as { id: string; email: string; name: string } | null, status: "in" }, listeners: new Set<() => void>() }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => state.token, getServerURL: () => state.base, authClient: {}, authFailureCode: () => "" }));
vi.mock("@/lib/auth-store", () => ({ useAuth: () => state.auth, authStore: { getSnapshot: () => state.auth, subscribe: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } } }));
vi.mock("./sign-in", () => ({ SignInForm: () => <p>Sign in</p> }));
vi.mock("@/lib/web-files", () => ({ downloadWebDocument: state.download }));
import { DocumentCloudDialog } from "./document-cloud-dialog";

beforeEach(() => {
  state.token = "test-session"; state.base = "https://markie.test"; state.download.mockReset();
  state.auth = { user: { id: "user", email: "user@example.test", name: "Test" }, status: "in" };
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe("explicit ordinary cloud sharing", () => {
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
    const snapshot = { schemaVersion: 2, id: "cloud-a", name: "private-a.txt", role: "owner", version: 1, format: "text", encoding: "base64", data: btoa(String.fromCharCode(...bytes)), sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
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
      return { schemaVersion: 2, id, name: `${id}.txt`, role: "owner", version: 1, format: "text", encoding: "base64", data: btoa(String.fromCharCode(...bytes)), sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") };
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
