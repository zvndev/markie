// Phase 7 server verification: thread lifecycle + role gating.
//   node scripts/comments-api-verify.mjs <aliceToken> <bobToken> <docId>
const SERVER = "http://localhost:8787";
const ORIGIN = { Origin: "http://localhost:3000" };
const [aliceToken, bobToken, docId] = process.argv.slice(2);
if (!aliceToken || !bobToken || !docId) {
  throw new Error("usage: comments-api-verify.mjs <aliceToken> <bobToken> <docId>");
}

const call = async (token, method, path, body) => {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...ORIGIN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const results = {};
const anchor = { from: { type: "rel" }, to: { type: "rel" } }; // opaque to the server

// Alice opens a thread
const created = await call(aliceToken, "POST", `/api/docs/${docId}/threads`, {
  anchor,
  body: "What about renaming this section?",
});
results.createThread = created.status === 200 && !!created.data.id;
const threadId = created.data.id;

// Bob (editor) replies — should notify Alice (owner) by email
const reply = await call(
  bobToken,
  "POST",
  `/api/docs/${docId}/threads/${threadId}/comments`,
  { body: "Agreed, let's do it." }
);
results.reply = reply.status === 200 && !!reply.data.id;

// List shows the thread with both comments and author identities
const list = await call(aliceToken, "GET", `/api/docs/${docId}/threads`);
const thread = list.data?.threads?.find((t) => t.id === threadId);
results.listShape =
  thread?.comments?.length === 2 &&
  thread.comments[0].author_name === "Alice" &&
  thread.comments[1].author_name === "Bob" &&
  thread.status === "open" &&
  typeof thread.anchor === "object";

// Resolve, then reopen
const resolved = await call(
  bobToken,
  "POST",
  `/api/docs/${docId}/threads/${threadId}/status`,
  { status: "resolved" }
);
const afterResolve = await call(aliceToken, "GET", `/api/docs/${docId}/threads`);
results.resolve =
  resolved.status === 200 &&
  afterResolve.data.threads.find((t) => t.id === threadId).status === "resolved";
const reopened = await call(aliceToken, "POST", `/api/docs/${docId}/threads/${threadId}/status`, {
  status: "open",
});
const afterReopen = await call(aliceToken, "GET", `/api/docs/${docId}/threads`);
results.reopen =
  reopened.status === 200 &&
  afterReopen.data.threads.find((t) => t.id === threadId).status === "open";

// A stranger gets 403/401 everywhere
const stranger = await call("garbage-token", "GET", `/api/docs/${docId}/threads`);
results.strangerBlocked = stranger.status === 401 || stranger.status === 403;

// Bob can't delete Alice's comment; Alice (owner) can delete Bob's
const aliceCommentId = thread.comments[0].id;
const bobCommentId = thread.comments[1].id;
const bobDeletesAlice = await call(
  bobToken,
  "DELETE",
  `/api/docs/${docId}/threads/${threadId}/comments/${aliceCommentId}`
);
results.crossDeleteBlocked = bobDeletesAlice.status === 403;
const aliceDeletesBob = await call(
  aliceToken,
  "DELETE",
  `/api/docs/${docId}/threads/${threadId}/comments/${bobCommentId}`
);
results.ownerDelete = aliceDeletesBob.status === 200;

// Deleting the last comment removes the thread
const aliceDeletesOwn = await call(
  aliceToken,
  "DELETE",
  `/api/docs/${docId}/threads/${threadId}/comments/${aliceCommentId}`
);
results.lastDeleteKillsThread = aliceDeletesOwn.data?.threadDeleted === true;
const finalList = await call(aliceToken, "GET", `/api/docs/${docId}/threads`);
results.threadGone = !finalList.data.threads.some((t) => t.id === threadId);

console.log(JSON.stringify(results, null, 2));
const pass = Object.values(results).every(Boolean);
console.log(pass ? "ALL PASS" : "FAILURES PRESENT");
process.exit(pass ? 0 : 1);
