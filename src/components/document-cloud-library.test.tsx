import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY as query } from "@/lib/library-document-query";

const state = vi.hoisted(() => ({ token: "a-token", base: "https://markie.test", confirmed: true, auth: { user: { id: "a", email: "a@example.test" } as { id: string; email: string } | null, status: "in" } }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => state.token, getServerURL: () => state.base, getConfirmedAuthIdentity: () => state.confirmed && state.auth.user ? { userId: state.auth.user.id, serverURL: state.base } : null }));
vi.mock("@/lib/auth-store", () => ({ useAuth: () => state.auth, authStore: { getSnapshot: () => state.auth } }));
import { DocumentCloudLibrary } from "./document-cloud-library";
const rows = [
  { schemaVersion: 2, id: "word", name: "Zebra.docx", format: "docx", version: 2, sha256: "0".repeat(64), byteLength: 100, createdAt: 1, updatedAt: 2, role: "viewer" },
  { schemaVersion: 2, id: "text", name: "Alpha.txt", format: "text", version: 1, sha256: "0".repeat(64), byteLength: 10, createdAt: 1, updatedAt: 3, role: "editor" },
  { schemaVersion: 2, id: "markdown", name: "Beta.md", format: "markdown", version: 1, sha256: "0".repeat(64), byteLength: 10, createdAt: 1, updatedAt: 4, role: "owner" },
];
beforeEach(() => { state.token = "a-token"; state.base = "https://markie.test"; state.confirmed = true; state.auth = { user: { id: "a", email: "a@example.test" }, status: "in" }; });
afterEach(() => vi.unstubAllGlobals());

describe("ordinary Cloud sidebar snapshots", () => {
  it("lists mixed metadata, shares filters/sort, opens exact IDs and never fetches content on filters", async () => {
    const request = vi.fn(async () => Response.json({ documents: rows })); vi.stubGlobal("fetch", request);
    const onOpen = vi.fn(), view = render(<DocumentCloudLibrary query={query} onOpen={onOpen} />);
    await screen.findByRole("button", { name: /Zebra.docx/ });
    expect(screen.getByText("3 of 3 snapshots")).toBeVisible();
    view.rerender(<DocumentCloudLibrary query={{ ...query, sort: "name" }} onOpen={onOpen} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([expect.stringContaining("Alpha"), expect.stringContaining("Beta"), expect.stringContaining("Zebra")]);
    view.rerender(<DocumentCloudLibrary query={{ ...query, format: "docx", search: "zebra" }} onOpen={onOpen} />);
    expect(screen.getByText("1 of 3 snapshots")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Zebra.docx/ })); expect(onOpen).toHaveBeenCalledWith("word");
    view.rerender(<DocumentCloudLibrary query={{ ...query, search: "unfetched body" }} onOpen={onOpen} />);
    expect(screen.getByText("No snapshots match these filters.")).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(["https://markie.test/api/document-platform/documents", expect.objectContaining({ method: "GET" })]);
  });
  it("hides old rows immediately on account/server changes and rejects late results", async () => {
    const pending: { resolve: (response: Response) => void; signal?: AbortSignal | null }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve) => pending.push({ resolve, signal: init.signal }))));
    const view = render(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0].resolve(Response.json({ documents: rows })));
    await screen.findByText("Zebra.docx");
    state.auth = { user: { id: "b", email: "b@example.test" }, status: "in" }; state.token = "b-token";
    view.rerender(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    expect(screen.queryByText("Zebra.docx")).toBeNull(); expect(pending[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(pending).toHaveLength(2));
    state.base = "https://other.test";
    view.rerender(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    await act(async () => pending[1].resolve(Response.json({ documents: rows })));
    expect(screen.queryByText("Zebra.docx")).toBeNull(); expect(pending[1].signal?.aborted).toBe(true);
    view.unmount(); expect(pending.at(-1)?.signal?.aborted).toBe(true);
  });
  it("does not request while checking/signed out, and distinguishes empty, missing-service and offline", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request); state.auth = { user: null, status: "checking" };
    const view = render(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    expect(screen.getByText("Checking account…")).toBeVisible(); expect(request).not.toHaveBeenCalled();
    state.auth = { user: null, status: "out" }; view.rerender(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    expect(screen.getByText("Sign in to browse document snapshots.")).toBeVisible(); expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ documents: [] })).mockResolvedValueOnce(new Response("missing", { status: 404 })).mockRejectedValueOnce(new TypeError("fetch failed"));
    state.auth = { user: { id: "a", email: "a@example.test" }, status: "in" }; view.rerender(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    await screen.findByText(/No document snapshots yet/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh cloud document snapshots" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not provide"); expect(screen.queryByText(/No document snapshots yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh cloud document snapshots" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be reached");
  });
  it("does not trust an old signed-in store after the server or token loses confirmation", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request); state.confirmed = false;
    render(<DocumentCloudLibrary query={query} onOpen={vi.fn()} />);
    expect(screen.getByText("Sign in again to confirm your account on this server.")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });
});
