// @vitest-environment jsdom
// How the desktop reads the answer to "may I have a live-editing pass". The
// one answer that lets the session token onto the socket is a server with no
// ticket route at all, so that answer has to be told apart from every other.
import { describe, expect, it, vi } from "vitest";
import { makeSharesClient, type ApiRequest } from "./auth-client";

type Reply = { status: number; data: unknown };

function serverAnswering(...replies: Reply[]) {
  let i = 0;
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; data: unknown }>>(
    async () => {
      const { status, data } = replies[Math.min(i++, replies.length - 1)];
      return { ok: status >= 200 && status < 300, status, data };
    }
  );
  return { client: makeSharesClient(request as unknown as ApiRequest), request };
}

describe("collabTicket", () => {
  it("asks the document's ticket route and hands back the ticket", async () => {
    const { client, request } = serverAnswering({ status: 200, data: { ticket: "tk", expiresAt: 123 } });
    expect(await client.collabTicket("doc/1")).toEqual({ kind: "ticket", ticket: "tk", expiresAt: 123 });
    expect(request).toHaveBeenCalledWith("/api/docs/doc%2F1/collab-ticket", { method: "POST", body: JSON.stringify({ schema: 2 }) });
  });

  it("reads a 404 or 405 with no route of its own as a server from before tickets", async () => {
    for (const reply of [
      { status: 404, data: { error: "not found" } },
      { status: 404, data: null },
      { status: 405, data: null },
    ]) {
      expect(await serverAnswering(reply).client.collabTicket("d")).toEqual({ kind: "legacy" });
    }
  });

  it("reads the route's own refusal as a failure, never as a reason to use the token", async () => {
    const { client } = serverAnswering({ status: 404, data: { error: "no_ticket" } });
    expect(await client.collabTicket("d")).toEqual({ kind: "failed", status: 404 });
  });

  it("never goes back to the token on a server that has already issued tickets", async () => {
    const { client } = serverAnswering(
      { status: 200, data: { ticket: "tk", expiresAt: 1 } },
      { status: 404, data: { error: "not found" } }
    );
    await client.collabTicket("d");
    expect(await client.collabTicket("d")).toEqual({ kind: "failed", status: 404 });
  });

  it("treats every other answer as a failure", async () => {
    for (const reply of [
      { status: 401, data: { error: "unauthorized" } },
      { status: 429, data: { error: "rate_limited" } },
      { status: 500, data: null },
      { status: 0, data: null },
      { status: 200, data: { ticket: "" } },
    ]) {
      expect((await serverAnswering(reply).client.collabTicket("d")).kind).toBe("failed");
    }
  });
});
