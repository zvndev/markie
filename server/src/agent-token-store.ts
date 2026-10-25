// The agent_tokens table, and the one thing auth.ts needs from it: revoking
// every token a user has. Kept apart from agent-tokens.ts, which imports
// auth.ts for sessions, so auth.ts can reach this without an import cycle.
// See docs/mobile/AGENT-LINKS-CONTRACT.md.
import { openDatabase } from "./db.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);
`);

type RevokedAllListener = (userId: string, tokenIds: string[]) => void;
const revokedAllListeners: RevokedAllListener[] = [];

/**
 * Run `listener` after revokeAgentTokensForUser, with every token id the user
 * has. agent-tokens.ts registers one to clear the user's write and byte
 * windows, which live there and which this file cannot import.
 */
export function onAgentTokensRevokedForUser(listener: RevokedAllListener): void {
  revokedAllListeners.push(listener);
}

/**
 * Revoke every live agent token of one user, effective on the next request.
 * A password reset or change calls this (auth.ts): whoever had the old
 * password, or a session made with it, may have minted tokens, and a new
 * password has to shut them out too. Their documents stay the user's. Their
 * usage leaves the user's windows with them, so the token the owner mints
 * after securing the account starts with the whole budget.
 */
export function revokeAgentTokensForUser(userId: string, now = Date.now()): number {
  const changes = db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, userId).changes;
  const ids = (db.prepare("SELECT id FROM agent_tokens WHERE user_id = ?").all(userId) as { id: string }[]).map((r) => r.id);
  for (const listener of revokedAllListeners) listener(userId, ids);
  return changes;
}
