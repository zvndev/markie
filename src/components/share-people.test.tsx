import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PeopleClient, SharePerson, ShareRequest } from "@/lib/auth-client";
import { SharePeopleSettings, ShareRequestsPanel } from "./share-people";

const request = (o: Partial<ShareRequest> = {}): ShareRequest => ({
  docId: "doc-1",
  name: "Plan.md",
  kind: "doc",
  role: "editor",
  createdAt: "2026-11-15T10:00:00.000Z",
  sender: { id: "olive", name: "Olive", email: "olive@markie.test" },
  ...o,
});
const person = (o: Partial<SharePerson> = {}): SharePerson => ({
  id: "olive",
  name: "Olive",
  email: "olive@markie.test",
  since: "2026-11-15T10:00:00.000Z",
  ...o,
});

function fakeClient(o: Partial<PeopleClient> = {}): PeopleClient {
  return {
    requests: vi.fn(async () => ({ requests: [], count: 0 })),
    people: vi.fn(async () => ({ accepted: [], blocked: [] })),
    accept: vi.fn(async () => true),
    decline: vi.fn(async () => true),
    block: vi.fn(async () => true),
    unblock: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ...o,
  };
}

describe("Requests", () => {
  it("takes no room when nobody is waiting", async () => {
    const client = fakeClient();
    const { container } = render(<ShareRequestsPanel accountKey="me" client={client} />);
    await waitFor(() => expect(client.requests).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("names the sender, their address and the file, with a count", async () => {
    const client = fakeClient({ requests: vi.fn(async () => ({ requests: [request(), request({ docId: "doc-2", name: "Notes.wd" })], count: 2 })) });
    render(<ShareRequestsPanel accountKey="me" client={client} />);
    const panel = await screen.findByRole("region", { name: "Requests" });
    expect(within(panel).getByLabelText("2 waiting")).toHaveTextContent("2");
    expect(within(panel).getByText("Plan.md")).toBeInTheDocument();
    expect(within(panel).getByText("Notes.wd")).toBeInTheDocument();
    expect(within(panel).getAllByText("olive@markie.test")).toHaveLength(2);
  });

  it("accepting the sender asks for the library again and clears what landed", async () => {
    const requests = vi.fn<PeopleClient["requests"]>().mockResolvedValueOnce({ requests: [request()], count: 1 }).mockResolvedValue({ requests: [], count: 0 });
    const client = fakeClient({ requests });
    const onChanged = vi.fn();
    render(<ShareRequestsPanel accountKey="me" client={client} onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(client.accept).toHaveBeenCalledWith("olive");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toHaveTextContent("Accepted Olive");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("declines one request by its document, and blocks by sender", async () => {
    const client = fakeClient({ requests: vi.fn(async () => ({ requests: [request()], count: 1 })) });
    render(<ShareRequestsPanel accountKey="me" client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(client.decline).toHaveBeenCalledWith("doc-1");
    await userEvent.click(await screen.findByRole("button", { name: "Block" }));
    expect(client.block).toHaveBeenCalledWith("olive");
  });

  it("says so when an answer fails, and keeps the request", async () => {
    const client = fakeClient({ requests: vi.fn(async () => ({ requests: [request()], count: 1 })), accept: vi.fn(async () => false) });
    render(<ShareRequestsPanel accountKey="me" client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't accept");
    expect(screen.getByText("Plan.md")).toBeInTheDocument();
  });
});

describe("Requests beyond the first page", () => {
  it("counts every request waiting and says only the newest are shown", async () => {
    const client = fakeClient({ requests: vi.fn(async () => ({ requests: [request()], count: 73 })) });
    render(<ShareRequestsPanel accountKey="me" client={client} />);
    expect(await screen.findByLabelText("73 waiting")).toHaveTextContent("73");
    expect(screen.getByText(/Showing the newest 1 of 73/)).toBeInTheDocument();
  });
});

describe("Accepted people", () => {
  it("lists accepted people with Remove and Block, and blocked people with Unblock", async () => {
    const client = fakeClient({
      people: vi.fn(async () => ({ accepted: [person()], blocked: [person({ id: "mallory", name: null, email: "m@x.test" })] })),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SharePeopleSettings accountId="me" client={client} />);
    const olive = (await screen.findByText("Olive")).closest("li")!;
    await userEvent.click(within(olive).getByRole("button", { name: "Remove" }));
    expect(client.remove).toHaveBeenCalledWith("olive");
    await userEvent.click(within(olive).getByRole("button", { name: "Block" }));
    expect(client.block).toHaveBeenCalledWith("olive");
    const mallory = screen.getByText("m@x.test").closest("li")!;
    await userEvent.click(within(mallory).getByRole("button", { name: "Unblock" }));
    expect(client.unblock).toHaveBeenCalledWith("mallory");
  });

  it("does nothing when removing is not confirmed", async () => {
    const client = fakeClient({ people: vi.fn(async () => ({ accepted: [person()], blocked: [] })) });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SharePeopleSettings accountId="me" client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("explains an empty list", async () => {
    render(<SharePeopleSettings accountId="me" client={fakeClient()} />);
    expect(await screen.findByText(/Nobody yet/)).toBeInTheDocument();
  });
});
