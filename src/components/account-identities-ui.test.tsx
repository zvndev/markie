import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ token: "session-a", server: "https://account.example.test", signOut: vi.fn(async () => {}) }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => state.token, getServerURL: () => state.server, getConfirmedAuthIdentity: () => ({ userId: "user-a", serverURL: state.server }) }));
vi.mock("@/lib/auth-store", () => ({ authStore: { getSnapshot: () => ({ status: "in", user: { id: "user-a" } }), subscribe: () => () => {}, signOut: state.signOut } }));
import { LinkedIdentities } from "./linked-identities";
import { CloudAreaPicker } from "./cloud-area-picker";
import { installBridge } from "@/test/mock-bridge";
const primary = { id: "primary", email: "primary@example.test", primary: true, verifiedAt: 1 }, alias = { id: "alias", email: "alias@example.test", primary: false, verifiedAt: 2 };
beforeEach(() => { state.token = "session-a"; state.server = "https://account.example.test"; state.signOut.mockClear(); installBridge(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("linked identities and area controls", () => {
  it("requires primary confirmation and new-email verification before linking", async () => {
    const request = vi.fn(async (url: string) => Response.json(url.endsWith("/identities") ? { identities: [primary] } : url.endsWith("step-up/verify") ? { proofId: "proof" } : url.endsWith("email/verify") ? { identity: alias } : { challengeId: "challenge", expiresInSeconds: 300 })); vi.stubGlobal("fetch", request);
    render(<LinkedIdentities accountId="user-a" />); expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    await screen.findByText("primary@example.test · Primary"); expect(screen.queryByRole("button", { name: "Unlink primary@example.test" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link another email" })); fireEvent.change(await screen.findByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm primary email" }));
    fireEvent.change(await screen.findByLabelText("New sign-in email"), { target: { value: "alias@example.test" } }); fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    fireEvent.change(await screen.findByLabelText("New email verification code"), { target: { value: "654321" } }); fireEvent.click(screen.getByRole("button", { name: "Verify and link email" }));
    expect(await screen.findByText("alias@example.test · Verified")).toBeInTheDocument();
    expect(request.mock.calls.some(([url]) => url.endsWith("/email/start"))).toBe(true); expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
  });
  it("does not apply a delayed identity list after same-UID token replacement", async () => {
    let finish!: (response: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    const old = finish; act(() => { state.token = "session-b"; window.dispatchEvent(new Event("markie:account-session-change")); });
    await act(async () => old(Response.json({ identities: [primary, alias] })));
    expect(screen.queryByText("alias@example.test · Verified")).toBeNull();
  });
  it("loads area metadata deliberately and returns a chosen destination without document mutation", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ areas: [{ id: "personal", label: "Personal" }, { id: "work", label: "Work" }], placements: [] })); vi.stubGlobal("fetch", request); const choose = vi.fn();
    render(<CloudAreaPicker label="Upload destination" defaultLabel="Default cloud" value="" onChange={choose} />); expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Upload destination: Default cloud" }));
    fireEvent.click(await screen.findByRole("button", { name: "Work" })); expect(choose).toHaveBeenLastCalledWith("work"); expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][0]).toBe("https://account.example.test/api/account/cloud-areas");
  });
  it("uses explicit Google linking only when advertised and polls the same account without switching session", async () => {
    const browserUrl = `https://account.example.test/account/link-google#intent.${"s".repeat(43)}`, openExternal = vi.fn(async () => {}); installBridge({ openExternal });
    const request = vi.fn<typeof fetch>(async (input) => { const url = String(input); return Response.json(url.endsWith("/identities") ? { identities: [primary], googleAvailable: true } : url.endsWith("step-up/verify") ? { proofId: "proof" } : url.endsWith("google/start") ? { intentId: "intent", browserUrl } : url.endsWith("google/intent") ? { intentId: "intent", status: "complete" } : { challengeId: "challenge", expiresInSeconds: 300 }); }); vi.stubGlobal("fetch", request);
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" })); fireEvent.click(await screen.findByRole("button", { name: "Link Google sign-in" }));
    fireEvent.change(await screen.findByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm primary email" }));
    expect(await screen.findByText("Google sign-in linked to this account. Your primary account and document access are unchanged.")).toBeInTheDocument();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(browserUrl); expect(state.token).toBe("session-a"); expect(state.signOut).not.toHaveBeenCalled();
    expect(request.mock.calls.find(([url]) => String(url).endsWith("step-up/start"))?.[1]?.body).toBe(JSON.stringify({ scope: "google-link" }));
  });
  it("warns that Google unlink signs out every session and requires a dedicated primary proof", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => Response.json(String(input).endsWith("/identities") ? { identities: [primary], providers: [{ id: "google-provider", providerId: "google" }] } : init?.method === "DELETE" ? { ok: true, signedOut: true } : String(input).endsWith("step-up/verify") ? { proofId: "proof" } : { challengeId: "challenge", expiresInSeconds: 300 })); vi.stubGlobal("fetch", request);
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" })); fireEvent.click(await screen.findByRole("button", { name: "Unlink Google sign-in 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("signs out every active session"); fireEvent.change(screen.getByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm unlink and sign out" }));
    await act(async () => {}); expect(state.signOut).toHaveBeenCalledOnce();
    expect(request.mock.calls.find(([url]) => String(url).endsWith("step-up/start"))?.[1]?.body).toBe(JSON.stringify({ scope: "google-remove" }));
    expect(request.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1]?.body).toBe(JSON.stringify({ proofId: "proof" }));
  });
  it("links an Apple ID through Apple's own routes and scope, only when the server advertises Apple", async () => {
    const browserUrl = `https://account.example.test/account/link-apple#intent.${"s".repeat(43)}`, openExternal = vi.fn(async () => {}); installBridge({ openExternal });
    const request = vi.fn<typeof fetch>(async (input) => { const url = String(input); return Response.json(url.endsWith("/identities") ? { identities: [primary], googleAvailable: true, appleAvailable: true } : url.endsWith("step-up/verify") ? { proofId: "proof" } : url.endsWith("apple/start") ? { intentId: "intent", browserUrl } : url.endsWith("apple/intent") ? { intentId: "intent", status: "complete" } : { challengeId: "challenge", expiresInSeconds: 300 }); }); vi.stubGlobal("fetch", request);
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    expect(await screen.findByRole("button", { name: "Link Google sign-in" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link Apple sign-in" }));
    fireEvent.change(await screen.findByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm primary email" }));
    expect(await screen.findByText("Apple sign-in linked to this account. Your primary account and document access are unchanged.")).toBeInTheDocument();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(browserUrl); expect(state.token).toBe("session-a"); expect(state.signOut).not.toHaveBeenCalled();
    expect(request.mock.calls.find(([url]) => String(url).endsWith("step-up/start"))?.[1]?.body).toBe(JSON.stringify({ scope: "apple-link" }));
    expect(request.mock.calls.some(([url]) => String(url).includes("/identities/google/"))).toBe(false);
  });
  it("offers no Apple link on a server that does not advertise it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ identities: [primary], googleAvailable: true })));
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    expect(await screen.findByRole("button", { name: "Link Google sign-in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apple/ })).toBeNull();
  });
  it("refuses an Apple handoff that points anywhere but this server's Apple linking page", async () => {
    const openExternal = vi.fn(async () => {}); installBridge({ openExternal });
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => { const url = String(input); return Response.json(url.endsWith("/identities") ? { identities: [primary], appleAvailable: true } : url.endsWith("step-up/verify") ? { proofId: "proof" } : url.endsWith("apple/start") ? { intentId: "intent", browserUrl: `https://account.example.test/account/link-google#intent.${"s".repeat(43)}` } : { challengeId: "challenge", expiresInSeconds: 300 }); }));
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" })); fireEvent.click(await screen.findByRole("button", { name: "Link Apple sign-in" }));
    fireEvent.change(await screen.findByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm primary email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid account information"); expect(openExternal).not.toHaveBeenCalled();
  });
  it("names each Google and Apple row by its address, keeps the old name for rows without one, and unlinks Apple with Apple's proof", async () => {
    const rows = [{ id: "apple-relay", providerId: "apple", email: "x7k2p9qz4m@privaterelay.appleid.com" }, { id: "apple-b", providerId: "apple", email: "b@icloud.example" }, { id: "google-a", providerId: "google", email: "kirby@zvndev.example" }, { id: "google-old", providerId: "google" }, { id: "password", providerId: "credential" }];
    const request = vi.fn<typeof fetch>(async (input, init) => Response.json(String(input).endsWith("/identities") ? { identities: [primary], providers: rows, googleAvailable: true, appleAvailable: true } : init?.method === "DELETE" ? { ok: true, signedOut: true } : String(input).endsWith("step-up/verify") ? { proofId: "proof" } : { challengeId: "challenge", expiresInSeconds: 300 })); vi.stubGlobal("fetch", request);
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    await screen.findByText("Google: kirby@zvndev.example");
    // Google first, then Apple, each numbered among its own kind; the password row is not a linked sign-in.
    expect(screen.getAllByRole("button", { name: /^Unlink / }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Unlink Google: kirby@zvndev.example", "Unlink Google sign-in 2", "Unlink Apple: x7k2p9qz4m@privaterelay.appleid.com", "Unlink Apple: b@icloud.example",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Apple: b@icloud.example" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Removing this Apple sign-in signs out every active session");
    fireEvent.change(screen.getByLabelText("Primary email confirmation code"), { target: { value: "123456" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm unlink and sign out" }));
    await act(async () => {}); expect(state.signOut).toHaveBeenCalledOnce();
    expect(request.mock.calls.find(([url]) => String(url).endsWith("step-up/start"))?.[1]?.body).toBe(JSON.stringify({ scope: "apple-remove" }));
    const removal = request.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(String(removal[0])).toBe("https://account.example.test/api/account/identities/apple-provider/apple-b");
    expect(removal[1]?.body).toBe(JSON.stringify({ proofId: "proof" }));
  });
  it("on a server without linked sign-ins says so plainly and offers no link actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    const message = await screen.findByText(/This server does not support linked sign-ins or cloud areas yet/);
    expect(message).toHaveAttribute("role", "status"); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Link another email" })).toBeNull(); expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
  });
  it("keeps the link actions and an alert when a supported server fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "identity-unavailable" }, { status: 503 })));
    render(<LinkedIdentities accountId="user-a" />); fireEvent.click(screen.getByRole("button", { name: "Manage linked sign-ins" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Link another email" })).toBeDisabled();
  });
});
