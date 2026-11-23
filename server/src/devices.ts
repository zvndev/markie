// The phones a person gets push notifications on, and the fan-out that sends
// them (docs/mobile: plan item 8.9).
//
// A row is one phone's push token, registered by the app after sign-in. It
// belongs to the session that registered it, and lives exactly as long as
// that session: signing out, a password reset that ends every session, or
// deleting the account takes the row with it (the triggers below), and a
// session that has expired gets nothing. So a phone that is no longer signed
// in is never told about anybody's comments.
//
// Delivery itself is push.ts. With no push secrets set, registering still
// works and nothing is ever sent.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { deployment } from "./deployment.ts";
import { pushSender, type PushMessage, type PushPlatform } from "./push.ts";

const db = openDatabase();

// Safe on a live database: one new table, nothing existing altered.
db.exec(`
  CREATE TABLE IF NOT EXISTS device_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
    show_names INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens (user_id);
  CREATE INDEX IF NOT EXISTS idx_device_tokens_session ON device_tokens (session_id);
`);

// A device goes with its session and its account, however those rows are
// removed: better-auth's sign-out, a revoke-all in account-platform.ts, an
// admin's SQL. The session and user tables come from better-auth's migration,
// which a deployment runs before the server starts; where they are not there
// yet this is tried again on the first registration.
let followersInstalled = false;
function installFollowers(): void {
  if (followersInstalled) return;
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has("session") || !has("user")) return;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS device_tokens_follow_session AFTER DELETE ON "session"
    BEGIN DELETE FROM device_tokens WHERE session_id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS device_tokens_follow_user AFTER DELETE ON "user"
    BEGIN DELETE FROM device_tokens WHERE user_id = OLD.id; END;
  `);
  followersInstalled = true;
}
installFollowers();

export const DEVICE_LIMITS = {
  /** Phones per account. One more replaces the one seen longest ago. */
  perUser: 10,
  /** Registrations per account in the window. The app sends one per launch. */
  registrations: 30,
  windowMs: 10 * 60 * 1000,
} as const;

// APNs hands out hex (32 bytes today, and Apple says not to assume a length).
// An FCM registration token is URL-safe base64 with colons.
const TOKEN_SHAPE: Record<PushPlatform, RegExp> = {
  ios: /^[0-9a-f]{64,256}$/,
  android: /^[A-Za-z0-9_:-]{32,1024}$/,
};

function isPlatform(value: unknown): value is PushPlatform {
  return value === "ios" || value === "android";
}

// Held in memory, like the invite limiter (invite-guard.ts): the API is one
// process, and a redeploy forgetting the counts is acceptable here.
const registrations = new Map<string, number[]>();
function takeRegistration(userId: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const recent = (registrations.get(userId) ?? []).filter((at) => now - at < DEVICE_LIMITS.windowMs);
  if (recent.length >= DEVICE_LIMITS.registrations) {
    registrations.set(userId, recent);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + DEVICE_LIMITS.windowMs - now) / 1000)) };
  }
  recent.push(now);
  registrations.set(userId, recent);
  if (registrations.size > 10_000) {
    for (const [key, list] of registrations) {
      if (list.every((at) => now - at >= DEVICE_LIMITS.windowMs)) registrations.delete(key);
    }
  }
  return { ok: true };
}

/** Test seam: suites that register many devices start each test clean. */
export function resetDeviceLimitsForTests(): void {
  registrations.clear();
}

/**
 * Files one phone under one account. A token another account registered
 * moves here: the phone has one owner at a time, the person signed in on it
 * now.
 */
export function registerDevice(args: { userId: string; sessionId: string; platform: PushPlatform; token: string; showNames: boolean }): void {
  installFollowers();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO device_tokens (token, user_id, session_id, platform, show_names, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         created_at = CASE WHEN device_tokens.user_id = excluded.user_id THEN device_tokens.created_at ELSE excluded.created_at END,
         user_id = excluded.user_id,
         session_id = excluded.session_id,
         platform = excluded.platform,
         show_names = excluded.show_names,
         last_seen_at = excluded.last_seen_at`
    ).run(args.token, args.userId, args.sessionId, args.platform, args.showNames ? 1 : 0, now, now);
    db.prepare(
      `DELETE FROM device_tokens WHERE user_id = ? AND token NOT IN (
         SELECT token FROM device_tokens WHERE user_id = ? ORDER BY last_seen_at DESC, rowid DESC LIMIT ?
       )`
    ).run(args.userId, args.userId, DEVICE_LIMITS.perUser);
  })();
}

/** Removes one of this account's phones. Another account's token is left alone. */
export function removeDevice(userId: string, token: string): boolean {
  return db.prepare("DELETE FROM device_tokens WHERE token = ? AND user_id = ?").run(token, userId).changes > 0;
}

interface DeviceRow {
  token: string;
  platform: PushPlatform;
  show_names: number;
  session_user: string | null;
  session_expires: string | number | null;
}

function sessionLive(row: DeviceRow, now: number): boolean {
  if (row.session_expires === null) return false;
  const raw = row.session_expires;
  const expires = typeof raw === "number" ? raw : /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(expires) && expires > now;
}

/**
 * The phones that may be told something for this account right now: those
 * whose session still exists, belongs to the account, and has not expired.
 * A row whose session is gone is removed on the way.
 */
function liveDevices(userId: string, now = Date.now()): DeviceRow[] {
  const rows = db
    .prepare(
      `SELECT d.token, d.platform, d.show_names, s.userId AS session_user, s.expiresAt AS session_expires
       FROM device_tokens d LEFT JOIN "session" s ON s.id = d.session_id
       WHERE d.user_id = ?`
    )
    .all(userId) as DeviceRow[];
  const live: DeviceRow[] = [];
  for (const row of rows) {
    if (row.session_user === null || row.session_user !== userId) {
      db.prepare("DELETE FROM device_tokens WHERE token = ?").run(row.token);
    } else if (sessionLive(row, now)) {
      live.push(row);
    }
  }
  return live;
}

// One printable line, cut to a length a lock screen shows.
function oneLine(value: string, max: number): string {
  const clean = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * What a comment notification says. It passes through Apple or Google on its
 * way to the phone, so by default it carries no words from the document: not
 * the comment, and not the document's name. It says who commented and links
 * to the thread by ID. A phone whose owner turned on "Show document names"
 * also gets the name. The comment's text is never sent.
 */
export function commentPushMessage(args: { from: string; docId: string; docName: string; threadId: string; showNames: boolean }): PushMessage {
  const who = oneLine(args.from, 60) || "Someone";
  const name = args.showNames ? oneLine(args.docName, 80) : "";
  return {
    title: "New comment",
    body: name ? `${who} commented on "${name}".` : `${who} commented on a document.`,
    link: `${deployment().origin}/d/${encodeURIComponent(args.docId)}?thread=${encodeURIComponent(args.threadId)}`,
    group: args.docId,
  };
}

/**
 * Tells each recipient's phones about a new comment. The caller (comments.ts
 * notify) has already decided who the recipients are, by the same rule as the
 * email: people who can read the document now, never the comment's author.
 *
 * Returns at once. Nothing here can fail or delay the comment request or its
 * email: sends run on their own, and a token the push service calls dead is
 * removed when its answer comes back.
 */
export function pushComment(args: { userIds: string[]; from: string; docId: string; docName: string; threadId: string }): void {
  try {
    const sender = pushSender();
    if (!sender.delivers("ios") && !sender.delivers("android")) return;
    for (const userId of new Set(args.userIds)) {
      for (const device of liveDevices(userId)) {
        if (!sender.delivers(device.platform)) continue;
        const message = commentPushMessage({ ...args, showNames: device.show_names === 1 });
        void sender
          .send(device.platform, device.token, message)
          .then((result) => {
            if (result === "dead") db.prepare("DELETE FROM device_tokens WHERE token = ?").run(device.token);
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("push fan-out failed:", err);
  }
}

export const devices = new Hono();

const tooLarge = bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "bad request" }, 413) });

// Register this phone, or refresh it. The app calls this after sign-in, on
// each launch, and whenever the push service hands it a new token.
devices.post("/", tooLarge, async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { platform?: unknown; token?: unknown; showNames?: unknown } | null;
  if (!body || !isPlatform(body.platform) || typeof body.token !== "string" || !TOKEN_SHAPE[body.platform].test(body.token)) {
    return c.json({ error: "bad request" }, 400);
  }
  if (body.showNames !== undefined && typeof body.showNames !== "boolean") return c.json({ error: "bad request" }, 400);
  const allowed = takeRegistration(session.user.id);
  if (!allowed.ok) {
    c.header("Retry-After", String(allowed.retryAfterSeconds));
    return c.json({ error: "Too many requests. Try again later." }, 429);
  }
  registerDevice({
    userId: session.user.id,
    sessionId: session.session.id,
    platform: body.platform,
    token: body.token,
    showNames: body.showNames === true,
  });
  // delivers: whether this server is set up to send to that kind of phone, so
  // the app can say so instead of promising notifications that never come.
  return c.json({ ok: true, delivers: pushSender().delivers(body.platform) });
});

// Forget this phone: signing out, or turning notifications off in Settings.
devices.delete("/:token", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const token = c.req.param("token");
  if (!TOKEN_SHAPE.ios.test(token) && !TOKEN_SHAPE.android.test(token)) return c.json({ error: "bad request" }, 400);
  return c.json({ ok: true, removed: removeDevice(session.user.id, token) });
});
