// The recipient's side of sharing: requests waiting for them, the people
// whose shares land, and the people they blocked. The rule and the table are
// in share-people-store.ts.
//
// Every route acts for the signed-in account only, as the recipient. Every
// change runs in one write transaction, and anything the caller cannot see
// (a sender with no request for them, a request that is not theirs) answers
// 404, the same as something that does not exist.

import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { createPendingShareStore } from "./pending.ts";
import { disconnectUser } from "./collab.ts";
import { recheckLiveDocChannels } from "./live-docs-channels.ts";
import {
  clearSenderState,
  docsFromSender,
  ensureSharePeopleSchema,
  landRequestsFrom,
  peopleFor,
  hasRequestFrom,
  removeRequest,
  removeFileSharesFromSender,
  requestDocsFrom,
  requestFor,
  requestsFor,
  senderState,
  setSenderState,
} from "./share-people-store.ts";

const db = openDatabase();
ensureSharePeopleSchema(db);
// Its own store on this handle, so revokeMember's transaction nests inside
// the route's as a savepoint and the whole change commits or none of it does.
const pendingStore = createPendingShareStore(db);

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const NOT_FOUND = { error: "not found" } as const;
const validId = (id: string) => id.length > 0 && id.length <= 128;

// Take every share from `senderId` out of `recipientId`'s Markie: the share
// rows go (fenced like an owner's own removal, so an old invite cannot bring
// them back), and so do document-platform memberships. Returns the Markdown
// and Live Doc ids, whose open sockets and tabs the caller closes after the
// transaction commits.
function dropSharesFrom(recipientId: string, senderId: string): string[] {
  const docIds = docsFromSender(db, recipientId, senderId);
  for (const docId of docIds) pendingStore.revokeMember(docId, recipientId);
  removeFileSharesFromSender(db, recipientId, senderId);
  return docIds;
}

// After a commit that took documents away: hang up live editing sockets and
// close open Live Doc tabs, which both outlive the rows they were opened on.
function cutOff(recipientId: string, docIds: string[]): void {
  for (const docId of docIds) {
    disconnectUser(docId, recipientId);
    recheckLiveDocChannels(docId);
  }
}

export const people = new Hono();

// Requests waiting for the caller: who wants to share what. Names the sender
// (name and their account's address) and the file name as plain text, nothing
// of the content. The newest REQUESTS_LISTED, with the total as `count`.
people.get("/requests", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { requests, total } = requestsFor(db, user.id);
  return c.json({ requests, count: total });
});

// Accepted people and blocked people.
people.get("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json(peopleFor(db, user.id));
});

// Decline one request. It goes, fenced like an owner's own removal for a
// Markdown document; the sender can ask again later with a new share.
people.post("/requests/:docId/decline", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("docId");
  if (!validId(docId)) return c.json(NOT_FOUND, 404);
  const declined = db.transaction(() => {
    const request = requestFor(db, user.id, docId);
    if (!request) return false;
    if (request.kind === "doc") pendingStore.revokeMember(docId, user.id);
    else removeRequest(db, "file", docId, user.id);
    return true;
  }).immediate();
  if (!declined) return c.json(NOT_FOUND, 404);
  return c.json({ ok: true });
});

// Accept a sender: every request from them moves into real shares at once
// (share_requests to shares and dp_members), and their later shares land
// directly. Only a sender with a request waiting can
// be accepted, so this route cannot be used to probe for accounts.
people.post("/:senderId/accept", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const senderId = c.req.param("senderId");
  if (!validId(senderId) || senderId === user.id) return c.json(NOT_FOUND, 404);
  const landed = db.transaction(() => {
    if (!hasRequestFrom(db, user.id, senderId)) return null;
    setSenderState(db, user.id, senderId, "accepted");
    const moved = landRequestsFrom(db, user.id, senderId);
    return [...moved.docs, ...moved.files];
  }).immediate();
  if (!landed) return c.json(NOT_FOUND, 404);
  return c.json({ ok: true, landed });
});

// Block a sender, whether their shares are still requests or already landed.
// Their requests leave the caller's view for good, and later shares from them
// go nowhere the caller can see. The request rows stay in share_requests,
// which grants nothing, only so the sender's own view still reads "waiting":
// to them a block looks exactly like no answer. Shares that had landed leave
// at once, exactly as removing the person does.
people.post("/:senderId/block", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const senderId = c.req.param("senderId");
  if (!validId(senderId) || senderId === user.id) return c.json(NOT_FOUND, 404);
  const removed = db.transaction(() => {
    const state = senderState(db, user.id, senderId);
    if (state === "blocked") return [];
    let dropped: string[] = [];
    if (state === "accepted") dropped = dropSharesFrom(user.id, senderId);
    else if (!hasRequestFrom(db, user.id, senderId)) return null;
    setSenderState(db, user.id, senderId, "blocked");
    return dropped;
  }).immediate();
  if (!removed) return c.json(NOT_FOUND, 404);
  cutOff(user.id, removed);
  return c.json({ ok: true });
});

// Unblock: back to having said nothing. Nothing sent during the block ever
// reaches the caller: the requests kept for the sender's "waiting" view are
// deleted now, fenced like a decline, so the sender sees an ordinary decline.
// Later shares from them arrive as normal requests.
people.post("/:senderId/unblock", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const senderId = c.req.param("senderId");
  if (!validId(senderId)) return c.json(NOT_FOUND, 404);
  const cleared = db.transaction(() => {
    if (senderState(db, user.id, senderId) !== "blocked") return false;
    const held = requestDocsFrom(db, user.id, senderId);
    for (const docId of held.docs) pendingStore.revokeMember(docId, user.id);
    for (const docId of held.files) removeRequest(db, "file", docId, user.id);
    return clearSenderState(db, user.id, senderId, "blocked");
  }).immediate();
  if (!cleared) return c.json(NOT_FOUND, 404);
  return c.json({ ok: true });
});

// Remove an accepted person: everything they shared leaves the caller's
// Markie at once, open editors and Live Doc tabs included. Their next share
// is a request again.
people.delete("/:senderId", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const senderId = c.req.param("senderId");
  if (!validId(senderId)) return c.json(NOT_FOUND, 404);
  const removed = db.transaction(() => {
    if (senderState(db, user.id, senderId) !== "accepted") return null;
    const dropped = dropSharesFrom(user.id, senderId);
    clearSenderState(db, user.id, senderId, "accepted");
    return dropped;
  }).immediate();
  if (!removed) return c.json(NOT_FOUND, 404);
  cutOff(user.id, removed);
  return c.json({ ok: true });
});
