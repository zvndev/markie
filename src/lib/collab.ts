// Live-collaboration config shared between the page (which decides when a
// doc is live) and RichView (which runs the Yjs session).

export interface PeerUser {
  name: string;
  color: string;
}

export interface CollabConfig {
  docId: string;
  wsBase: string; // ws(s)://host/collab — y-websocket appends /<docId>
  token: string;
  user: PeerUser;
  readonly: boolean; // viewer role: presence yes, edits no
}

// The shape RichView writes into a room when it seeds one. Bump it whenever a
// change to the editor's schema would make an older room's content unreadable
// to this build, so a client that meets such a room can say so instead of
// silently mangling it.
export const COLLAB_SCHEMA_VERSION = 1;

// A room is seeded by whichever client gets there first, and the server elects
// exactly one seeder per empty room. This is the client half: after the first
// sync, wait this long and look again before writing anything, so the losing
// racer sees the winner's content rather than adding a second copy of the file.
export const SEED_SETTLE_MS = 150;

export const SCHEMA_MISMATCH_NOTICE =
  "This document was made with a different Markie version; editing may misbehave.";

/** True when a room carries a schema version this build does not speak. */
export function isSchemaMismatch(version: unknown): boolean {
  return typeof version === "number" && version !== COLLAB_SCHEMA_VERSION;
}

/**
 * Whether the schema-mismatch notice should be raised now: only on a genuine
 * mismatch, and only if it has not already been said. The room's meta map can
 * fire the observer many times as edits stream in, so this keeps the warning
 * to once per session.
 */
export function shouldWarnSchema(version: unknown, alreadyWarned: boolean): boolean {
  return !alreadyWarned && isSchemaMismatch(version);
}

const PEER_COLORS = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
