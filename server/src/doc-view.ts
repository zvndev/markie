// Reading a shared document on the web, scoped to the person it was shared
// with. Markie documents are never public: there is no URL here that shows a
// document to someone who is not signed in as a member of it.
//
// One way in: a signed-in session (the web sign-in's cookie, or a Bearer
// token), whose account is checked live against the share tables on every
// request. Removing someone takes effect on their next request.
//
// The ?k=<token> on an emailed link authorizes nothing. Email gets forwarded,
// so a token that opened the document would hand it to whoever the email
// reached. It only decides what a reader who is not signed in sees next:
//
//   a member's token   a redirect to the web sign-in, which comes back here
//   an open invite's   a page naming the invited address, since signing in or
//                      making an account with that address is how it opens
//
// A verified account arriving with an open invite for this document claims it
// here, through the same verified-address gate the Library listing uses.
//
// Anything else gets an access page that names no document, so the route
// cannot be used to discover which document ids exist.
import { Hono, type Context } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canEditLevel,
  canReadLevel,
  memberForToken,
} from "./shares.ts";
import { claimPendingInvites, listPendingForDoc, pendingForToken } from "./pending.ts";
import { sharedPageLinkFor } from "./doc-links.ts";
import { assetRefsFor, assetVersion, serveAsset } from "./assets.ts";
import { deployment } from "./deployment.ts";
import { renderAccessRequiredPage, renderSharedDocPage } from "./render.ts";
import { renderSignInNotice, webSignInHref } from "./web-signin.ts";
import { downloadFilename } from "./doc-meta.ts";

const db = openDatabase();

const MARKIE_SITE = deployment().siteUrl;
// Web sign-in runs on this server's own origin, where its session cookie lives.
const AUTH_BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:8787";

export const docView = new Hono();

interface DocRow {
  id: string;
  name: string;
  content: string;
  owner_id: string;
  format: string;
}

function loadDoc(docId: string): DocRow | null {
  return (
    (db
      .prepare(
        "SELECT id, name, content, owner_id, format FROM docs WHERE id = ? AND deleted_at IS NULL"
      )
      .get(docId) as DocRow | undefined) ?? null
  );
}

function inviterName(userId: string): string | null {
  const row = db
    .prepare("SELECT name, email FROM user WHERE id = ?")
    .get(userId) as { name: string | null; email: string | null } | undefined;
  return row?.name || row?.email || null;
}

/** What this request may do with this document, and what to show if nothing. */
export type DocAccess =
  /** A signed-in account that passes accessLevel. The only kind that reads. */
  | { kind: "reader"; canEdit: boolean; userId: string }
  /**
   * Signed in, but not as anyone this document is shared with. invitedEmail is
   * set when the request also carries this document's open invite, so the
   * page can say which address to use; the holder already saw that address in
   * the email.
   */
  | { kind: "wrong-account"; signedInAs: string; invitedEmail: string | null }
  /** Nobody signed in, holding a current member's link to this document. */
  | { kind: "member-link" }
  /** Nobody signed in, holding this document's open invite. */
  | { kind: "invite"; email: string }
  | { kind: "none" };

// Decide what this request gets. Reading is decided by the session alone; the
// token only chooses which refusal to show someone who is not signed in.
export async function resolveViewer(
  docId: string,
  token: string | null,
  headers: Headers
): Promise<DocAccess> {
  const pending = token ? pendingForToken(token) : null;
  // The token must belong to the document being asked for, or one invite
  // would put its address on the page for every other document id.
  const invite = pending && pending.docId === docId ? pending : null;

  const session = await auth.api.getSession({ headers });
  const user = session?.user;
  if (user?.id) {
    let level = accessLevel(docId, user.id);
    // An invite becomes a share only for an account that has proven the
    // address it was sent to: the same gate, and the same call, as the Library
    // listing in docs.ts. The token plays no part, so a forwarded invite claims
    // nothing for whoever is signed in. Checked against the doc's pending rows
    // first so a refused read does not take a write lock.
    if (!canReadLevel(level) && user.email && user.emailVerified && listPendingForDoc(docId).length > 0) {
      try {
        claimPendingInvites(user.email, user.id);
      } catch (err) {
        console.error("claim-on-view failed:", err);
      }
      level = accessLevel(docId, user.id);
    }
    if (canReadLevel(level)) return { kind: "reader", canEdit: canEditLevel(level), userId: user.id };
    return { kind: "wrong-account", signedInAs: user.email ?? "", invitedEmail: invite?.email ?? null };
  }

  if (token) {
    const member = memberForToken(token);
    // A token that outlived its member's access is just a stranger's request.
    if (member && member.docId === docId && canReadLevel(accessLevel(docId, member.userId))) {
      return { kind: "member-link" };
    }
    if (invite) return { kind: "invite", email: invite.email };
  }
  return { kind: "none" };
}

// Every /d/ response, refusals and redirects included. The URL a reader
// arrives on can carry their personal token, so it stays out of shared caches
// and out of the referrer of anything the page links to. Set here rather than
// inherited from the website, which does not own these responses: they are
// served through a rewrite and must carry their own policy.
function keepPrivate(c: Context) {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
}

function invitePage(docId: string, doc: DocRow, email: string): string {
  const sharedBy = inviterName(doc.owner_id);
  const href = webSignInHref(AUTH_BASE, docId);
  // The name and the sharer are already in the invite email's subject and
  // body, so naming them here tells the token's holder nothing new. The
  // content stays behind the sign-in.
  return renderSignInNotice({
    title: "Sign in to read this",
    heading: "Sign in to open this document",
    lines: [
      [sharedBy ? `${sharedBy} shared "${doc.name}" with ` : `"${doc.name}" was shared with `, { strong: email }, "."],
      ["To open it, sign in with that address, or make your Markie account with it. We'll email you a code to prove it's yours."],
    ],
    action: href ? { href, label: "Sign in or create your account" } : null,
  });
}

// Names the account the browser is signed in as, which the browser already
// knows, and nothing about the document: the same page answers for a document
// that does not exist.
function wrongAccountPage(docId: string, signedInAs: string, invitedEmail: string | null): string {
  const href = webSignInHref(AUTH_BASE, docId, { switchAccount: true });
  return renderSignInNotice({
    title: "No access",
    heading: "This account can't open this document",
    lines: [
      signedInAs ? ["You're signed in as ", { strong: signedInAs }, "."] : ["You're signed in to Markie."],
      invitedEmail
        ? ["It was shared with ", { strong: invitedEmail }, ". Sign in with that address to open it."]
        : ["If it was shared with a different address, sign in with that one."],
    ],
    action: href ? { href, label: "Sign in with a different account" } : null,
  });
}

docView.get("/d/:id", async (c) => {
  keepPrivate(c);
  const docId = c.req.param("id");
  const access = await resolveViewer(docId, c.req.query("k") ?? null, c.req.raw.headers);
  // The sign-in link names only the id the browser already asked for, and is
  // offered whether or not the document exists, so it reveals nothing.
  const signIn = webSignInHref(AUTH_BASE, docId);
  // 403 for both "no access" and "no such document": telling them apart would
  // turn this route into a way to enumerate document ids.
  const accessRequired = () => c.html(renderAccessRequiredPage(MARKIE_SITE, signIn), 403);

  if (access.kind === "member-link") return signIn ? c.redirect(signIn, 302) : accessRequired();
  if (access.kind === "invite") {
    const doc = loadDoc(docId);
    return doc ? c.html(invitePage(docId, doc, access.email), 401) : accessRequired();
  }
  if (access.kind === "wrong-account") {
    return c.html(wrongAccountPage(docId, access.signedInAs, access.invitedEmail), 403);
  }
  if (access.kind !== "reader") return accessRequired();
  const doc = loadDoc(docId);
  if (!doc) return accessRequired();

  const refs = assetRefsFor(docId);
  // ?v= carries the hash this ref currently points at. The asset route
  // ignores it, but the URL is what a browser caches against, and the
  // response is fresh for an hour: without it, relinking a.png to new bytes
  // leaves the same URL and a browser may legally keep showing the old
  // picture, with no request for an ETag to answer. No ?k=: the asset is
  // read with the same session as this page, and copying the token into
  // every src would only spread it.
  const assetUrlFor = (ref: string) => {
    const row = refs.get(ref);
    if (!row) return null;
    return `/d/${encodeURIComponent(docId)}/assets?ref=${encodeURIComponent(ref)}&v=${assetVersion(row.hash)}`;
  };
  return c.html(
    renderSharedDocPage({
      title: doc.name,
      markdown: doc.content,
      docId,
      siteUrl: MARKIE_SITE,
      sharedBy: inviterName(doc.owner_id),
      canEdit: access.canEdit,
      assetUrlFor,
      docLinkFor: sharedPageLinkFor(docId, access.userId),
      // A Darkmown document never runs on the web: render.ts shows its source.
      format: doc.format,
    })
  );
});

// The raw text and the assets answer a link without a session with a bare 401:
// there is no page to show, and the HTML route is where a reader signs in.
const SIGN_IN_FIRST = "Sign in to read this document.";

docView.get("/d/:id/raw", async (c) => {
  keepPrivate(c);
  const docId = c.req.param("id");
  const access = await resolveViewer(docId, c.req.query("k") ?? null, c.req.raw.headers);
  if (access.kind === "member-link" || access.kind === "invite") return c.text(SIGN_IN_FIRST, 401);
  if (access.kind !== "reader") return c.text("Not found", 403);
  const doc = loadDoc(docId);
  if (!doc) return c.text("Not found", 403);

  const filename = downloadFilename(doc.name, doc.format);
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return c.body(doc.content);
});

docView.get("/d/:id/assets", async (c) => {
  keepPrivate(c);
  const docId = c.req.param("id");
  const access = await resolveViewer(docId, c.req.query("k") ?? null, c.req.raw.headers);
  if (access.kind === "member-link" || access.kind === "invite") return c.text(SIGN_IN_FIRST, 401);
  if (access.kind === "wrong-account") return c.text("Not found", 403);
  if (access.kind !== "reader") return c.text("Not found", 404);
  if (!loadDoc(docId)) return c.text("Not found", 404);
  // A served asset carries its own private, hour-long caching (assets.ts),
  // which the ?v= in its URL relies on; this response replaces the headers
  // set above.
  return serveAsset(c, docId, c.req.query("ref") ?? "");
});
