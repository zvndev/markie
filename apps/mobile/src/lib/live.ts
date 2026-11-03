// Live editing on the phone: the desktop's own rule for when a document goes
// live, and the session config its editors (RichView, TextCollabEditor) take.
//
// The socket's only credential is a short-lived pass from the document's
// server (server/src/collab-tickets.ts). The session token never goes into the
// socket URL: `token` below is empty, and the phone's ticket call never
// answers "legacy", which is the one case where connectWithTicket would fall
// back to a token (src/lib/collab.ts).
import { classifyDocumentFormat } from "@/lib/document-formats";
import { colorForName, type CollabConfig, type CollabTicketAnswer } from "@/lib/collab";
import { writeLiveSnapshot, type LiveSnapshotResult, type RoomMeta, type RoomTexts } from "@/lib/live-snapshot";
import type { DocFormat } from "./docs";

// The desktop opens no live session for a document this large
// (LARGE_DOC_BYTES in electron/doc-tiers.js, refreshCollab in src/app/page.tsx).
export const LIVE_MAX_CHARS = 1_000_000;

/** Which live editor a document takes, or null when the desktop never edits it live. */
export type LiveKind = "rich" | "text";

export function liveKind(name: string, format: DocFormat): LiveKind | null {
  if (format === "markdown" && classifyDocumentFormat(name).kind === "markdown") return "rich";
  // The desktop's plain-text rule (isPlainTextName in src/app/page.tsx).
  if (classifyDocumentFormat(name).kind === "text") return "text";
  return null;
}

/**
 * The desktop's rule: a document is edited live once anyone else is on it,
 * a pending invitation included, and only while it is small enough.
 */
export function shouldGoLive(members: readonly unknown[] | null, kind: LiveKind | null, chars: number): boolean {
  return kind !== null && !!members && members.length > 0 && chars <= LIVE_MAX_CHARS;
}

/** ws(s)://host/collab for an http(s) origin. y-websocket appends /<docId>. */
export function collabWsBase(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Not a server address.");
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/collab`;
}

export interface LiveConfigInput {
  origin: string;
  docId: string;
  /** How others see this person: their name, or their email when they have none. */
  displayName: string;
  readonly: boolean;
  fetchTicket: () => Promise<CollabTicketAnswer>;
}

export function liveConfig({ origin, docId, displayName, readonly, fetchTicket }: LiveConfigInput): CollabConfig {
  const name = displayName.trim() || "Someone";
  return {
    docId,
    wsBase: collabWsBase(origin),
    // Never sent: see the note at the top of this file.
    token: "",
    fetchTicket: async () => {
      const answer = await fetchTicket();
      // Belt and braces: whatever the client says, the phone never takes the
      // path that would put a credential other than a pass on the socket.
      return answer.kind === "legacy" ? { kind: "failed", status: 404 } : answer;
    },
    user: { name, color: colorForName(name) },
    readonly,
  };
}

interface SnapshotApi {
  saveDoc(input: { id: string; name: string; content: string; baseVersion: number }): Promise<{ id: string; version: number }>;
  doc(id: string): Promise<{ version: number | null; content: string; name?: string }>;
}

const isVersionConflict = (error: unknown) =>
  !!error && typeof error === "object" && (error as { status?: unknown }).status === 409 && (error as { code?: unknown }).code === "conflict";

/**
 * Writes the room's text over the stored version, the way the web app does,
 * under the shared policy (src/lib/live-snapshot.ts): the caller has already
 * checked the room is ready and this phone is its writer, and a 409 goes
 * over a version only when its text came out of the room. Anything else is
 * a conflict, never an overwrite.
 */
export function saveLiveSnapshot(
  api: SnapshotApi,
  { id, name, content, version, room, meta = null }: { id: string; name: string; content: string; version: number; room: RoomTexts; meta?: RoomMeta | null }
): Promise<LiveSnapshotResult> {
  return writeLiveSnapshot({
    save: async (text, baseVersion) => (await api.saveDoc({ id, name, content: text, baseVersion })).version,
    read: async () => {
      const current = await api.doc(id);
      return current.version === null ? null : { content: current.content, name: current.name ?? name, version: current.version };
    },
    isConflict: isVersionConflict,
  }, { content, name, version, room, meta });
}
