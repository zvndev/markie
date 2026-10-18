// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ token: "session-a", server: "https://account.example.test", confirmed: true }));
vi.mock("./auth-client", () => ({ getAuthToken: () => state.token, getServerURL: () => state.server, getConfirmedAuthIdentity: () => state.confirmed ? { userId: "user-a", serverURL: state.server } : null }));
vi.mock("./auth-store", () => ({ authStore: { getSnapshot: () => ({ status: "in", user: { id: "user-a" } }) } }));
import { AccountIdentitiesClient } from "./account-identities";
beforeEach(() => { state.token = "session-a"; state.server = "https://account.example.test"; state.confirmed = true; });
describe("confirmed account identity client", () => {
  it("binds primary confirmation and unlink proof to authenticated routes without redirects", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ challengeId: "challenge", expiresInSeconds: 300 }));
    const client = new AccountIdentitiesClient(request); await client.startStepUp("email-remove");
    expect(request).toHaveBeenCalledWith("https://account.example.test/api/account/identities/step-up/start", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer session-a" }), body: JSON.stringify({ scope: "email-remove" }) }));
    request.mockResolvedValueOnce(Response.json({ ok: true })); await client.unlink("alias-id", "proof-id");
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ proofId: "proof-id" }) });
  });
  it("rejects unconfirmed sessions and responses from an old bearer", async () => {
    state.confirmed = false; expect(() => new AccountIdentitiesClient()).toThrow("confirm"); state.confirmed = true;
    const request = vi.fn(async () => { state.token = "session-b"; return Response.json({ identities: [] }); });
    await expect(new AccountIdentitiesClient(request).identities()).rejects.toThrow("account or server changed");
  });
  it("calls browser-owned fetch with its Window/global receiver rather than the client object", async () => {
    const prior = globalThis.fetch;
    const nativeLike = function (this: unknown) { if (this !== globalThis) throw new TypeError("Illegal invocation"); return Promise.resolve(Response.json({ identities: [] })); };
    globalThis.fetch = nativeLike as typeof fetch;
    try { await expect(new AccountIdentitiesClient().identities()).resolves.toMatchObject({ identities: [] }); }
    finally { globalThis.fetch = prior; }
  });
  it("reports unsupported servers and conflicts without retrying or merging", async () => {
    const request = vi.fn(async () => new Response(null, { status: 404 })), client = new AccountIdentitiesClient(request);
    await expect(client.identities()).rejects.toThrow("does not support"); expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(Response.json({ code: "email-conflict" }, { status: 409 })); await expect(client.startEmail("alias@example.test", "proof")).rejects.toThrow("Accounts were not merged");
  });
  it("keeps alias sign-in flow binding in the verification body and returns an explicit session", async () => {
    const flowId = "a".repeat(43), request = vi.fn<typeof fetch>(async () => Response.json({ challengeId: "challenge", flowId, expiresInSeconds: 300 }));
    const challenge = await AccountIdentitiesClient.startAliasSignIn("alias@example.test", request); expect(challenge.flowId).toBe(flowId);
    request.mockResolvedValueOnce(Response.json({ token: "session-new", user: { id: "user-a", email: "primary@example.test", name: "Writer" } }));
    expect((await AccountIdentitiesClient.verifyAliasSignIn("challenge", flowId, "123456", request)).token).toBe("session-new");
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ body: JSON.stringify({ challengeId: "challenge", flowId, code: "123456" }) }); expect(localStorage.length).toBe(0);
  });
});
