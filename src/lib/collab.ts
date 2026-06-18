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
