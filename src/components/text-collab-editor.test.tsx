import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextCollabEditor } from "@/components/text-collab-editor";
import type { CollabConfig, CollabTicketAnswer } from "@/lib/collab";

// The plain-text pane opens its socket the same way RichView does, so the
// same rule holds: the session token never goes on it unless the server has
// no ticket route. Only the provider is faked.
const fake = vi.hoisted(() => ({
  providers: [] as Array<{ createdWith: Record<string, string>; params: Record<string, string>; connects: number }>,
}));
vi.mock("@/lib/collab-loader", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/collab-loader")>();
  const runtime = await import("@/lib/collab-runtime");
  const { Awareness } = await import("y-protocols/awareness");
  class FakeProvider {
    synced = false;
    shouldConnect = false;
    connects = 0;
    params: Record<string, string>;
    createdWith: Record<string, string>;
    awareness: InstanceType<typeof Awareness>;
    constructor(_url: string, _room: string, doc: import("yjs").Doc, opts?: { params?: Record<string, string> }) {
      this.awareness = new Awareness(doc);
      this.params = opts?.params ?? {};
      this.createdWith = { ...this.params };
      fake.providers.push(this);
    }
    on() {}
    off() {}
    connect() {
      this.shouldConnect = true;
      this.connects += 1;
    }
    disconnect() {}
    destroy() {
      this.awareness.destroy();
    }
  }
  const fakeRuntime = { ...runtime, WebsocketProvider: FakeProvider } as unknown as typeof runtime;
  return { ...real, useCollabRuntime: () => ({ runtime: fakeRuntime, failed: false }) };
});

const SESSION_TOKEN = "account-wide-session-token";
const collab = (fetchTicket: () => Promise<CollabTicketAnswer>): CollabConfig => ({
  docId: "doc-1",
  wsBase: "ws://localhost/collab",
  token: SESSION_TOKEN,
  fetchTicket,
  user: { name: "Me", color: "#000000" },
  readonly: false,
});
const latest = () => fake.providers.at(-1)!;

describe("TextCollabEditor's live-editing pass", () => {
  it("creates the provider with no session token and connects with the server's ticket", async () => {
    fake.providers = [];
    render(
      <TextCollabEditor
        value="plain"
        onChange={() => {}}
        collab={collab(async () => ({ kind: "ticket", ticket: "tk-1", expiresAt: 0 }))}
      />
    );
    await waitFor(() => expect(latest()?.connects).toBe(1));
    expect(latest().createdWith).toEqual({});
    expect(latest().params).toEqual({ ticket: "tk-1" });
  });

  it("falls back to the token on a server that has no ticket route", async () => {
    fake.providers = [];
    render(<TextCollabEditor value="plain" onChange={() => {}} collab={collab(async () => ({ kind: "legacy" }))} />);
    await waitFor(() => expect(latest()?.connects).toBe(1));
    expect(latest().params).toEqual({ token: SESSION_TOKEN });
  });

  it("reports the session unavailable, and never connects, when no ticket can be had", async () => {
    fake.providers = [];
    const onCollabStatus = vi.fn();
    render(
      <TextCollabEditor
        value="plain"
        onChange={() => {}}
        collab={collab(async () => ({ kind: "failed", status: 401 }))}
        onCollabStatus={onCollabStatus}
      />
    );
    await waitFor(() => expect(onCollabStatus).toHaveBeenCalledWith("unavailable"));
    expect(latest().connects).toBe(0);
    expect(latest().params).toEqual({});
  });
});
