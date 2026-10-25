import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-store";
import { getServerURL } from "@/lib/auth-client";
import {
  AGENT_TOKEN_NAME_MAX,
  claudeCodeSetupCommand,
  createAgentToken,
  genericMcpConfig,
  hostedMcpUrl,
  listAgentTokens,
  revokeAgentToken,
  type AgentToken,
  type CreatedAgentToken,
} from "@/lib/agent-tokens";
import { CopyBlock } from "@/components/copy-block";

interface RemoteAgentsPanelProps {
  onClose: () => void;
}

// Stands in for the token in the setup commands until one has been created.
const TOKEN_PLACEHOLDER = "<token>";

function formatWhen(value: string | number | null): string {
  if (value === null) return "";
  // Seconds and milliseconds both turn up in a stored timestamp.
  const date = new Date(typeof value === "number" && value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Remote agents: an agent with no Markie app nearby (Claude on a phone, in the
 * cloud) connects to the hosted MCP endpoint with a token made here. The full
 * token is held in this component's state alone: it is shown once, never
 * stored or logged, and gone when the panel closes or the account changes.
 */
export function RemoteAgentsPanel({ onClose }: RemoteAgentsPanelProps) {
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const signedIn = auth.status === "in" && !!userId;

  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<CreatedAgentToken | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Only the newest list request may write, so an account switch cannot land
  // another account's tokens on screen.
  const ticket = useRef(0);
  const invalidate = useCallback(() => {
    ticket.current++;
  }, []);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoadError(null);
    const res = await listAgentTokens();
    if (mine !== ticket.current) return;
    if (res.ok) setTokens(res.data);
    else {
      setTokens(null);
      setLoadError(res.message);
    }
  }, []);

  useEffect(() => {
    // A different account, or none, never inherits what the last one made.
    setFresh(null);
    setTokens(null);
    setLoadError(null);
    setCreateError(null);
    setRevokeError(null);
    if (!signedIn) {
      invalidate();
      return;
    }
    void load();
    return invalidate;
  }, [signedIn, userId, load, invalidate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await createAgentToken(trimmed);
    setCreating(false);
    if (!res.ok) {
      setCreateError(res.message);
      return;
    }
    setFresh(res.data);
    setName("");
    setTokens((prev) => [
      { id: res.data.id, name: res.data.name, prefix: res.data.prefix, createdAt: res.data.createdAt, lastUsedAt: null },
      ...(prev ?? []),
    ]);
  };

  const revoke = async (token: AgentToken) => {
    if (!window.confirm(`Revoke “${token.name}”? Any agent using it stops working right away. This cannot be undone.`)) return;
    setRevoking(token.id);
    setRevokeError(null);
    const res = await revokeAgentToken(token.id);
    setRevoking(null);
    if (!res.ok) {
      setRevokeError(res.message);
      return;
    }
    setTokens((prev) => (prev ? prev.filter((t) => t.id !== token.id) : prev));
    setFresh((prev) => (prev && prev.id === token.id ? null : prev));
  };

  const url = hostedMcpUrl(getServerURL());
  const secret = fresh ? fresh.token : TOKEN_PLACEHOLDER;

  return (
    <div
      className="markie-scrim fixed inset-0 z-[110] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel w-[520px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-remote-agents-title"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 id="markie-remote-agents-title" className="text-[14px] font-semibold text-foreground">
            Remote agents
          </h2>
          <button onClick={onClose} aria-label="Close" className="markie-overlay-close">
            ×
          </button>
        </div>
        <p className="text-[12px] text-muted leading-relaxed mb-4">
          For an agent that does not run on this computer, such as Claude on your phone or in the cloud. It connects to
          Markie Cloud with a token you make here, and can create documents there. It can read and edit only the
          documents it made, never the rest of your Cloud. They stay private to you and open in the Markie app.
        </p>

        {auth.status === "checking" ? (
          <p className="text-[12px] text-muted" role="status">
            Checking your Markie Cloud sign-in&hellip;
          </p>
        ) : !signedIn ? (
          <div role="status">
            <div className="markie-overlay-section mb-1.5">Sign in first</div>
            <p className="text-[12px] text-muted leading-relaxed">
              Remote agents need a Markie Cloud sign-in, because the tokens belong to your account. Sign in to Markie
              Cloud from Settings, then open this panel again.
            </p>
          </div>
        ) : (
          <>
            <CopyBlock label="MCP URL" hint="the hosted Markie server" text={url} />

            <div className="markie-overlay-section mb-1.5 mt-4">Create a token</div>
            <form onSubmit={create} className="flex gap-2 mb-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={AGENT_TOKEN_NAME_MAX}
                placeholder="Name it after the agent, such as Claude on my phone"
                aria-label="Token name"
                autoComplete="off"
                spellCheck={false}
                className="markie-overlay-field flex-1 min-w-0 px-2.5 py-1.5 text-[12px]"
              />
              <button
                type="submit"
                disabled={!name.trim() || creating}
                className="markie-overlay-button text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50 shrink-0"
              >
                {creating ? "Creating…" : "Create token"}
              </button>
            </form>
            {createError && (
              <p role="alert" className="text-[12px] text-[var(--status-red)] mb-2">
                {createError}
              </p>
            )}

            {fresh && (
              <div className="rounded-md border border-border bg-background p-2.5 mb-3" role="group" aria-label="New token">
                <p role="alert" className="text-[12px] leading-relaxed text-[var(--status-yellow)] mb-2">
                  Copy this token now. It will not be shown again, and Markie does not keep it. If you lose it, revoke
                  it and make a new one.
                </p>
                <CopyBlock label={`Token: ${fresh.name}`} hint="shown once" text={fresh.token} />
                <button
                  type="button"
                  onClick={() => setFresh(null)}
                  className="markie-overlay-button text-[11px] px-2 py-0.5 rounded-md bg-accent text-foreground hover:opacity-90"
                >
                  I have copied it
                </button>
              </div>
            )}

            <div className="markie-overlay-section mb-1.5 mt-4">Set up your agent</div>
            <p className="text-[12px] text-muted leading-relaxed mb-2">
              {fresh
                ? "These include the token you just made."
                : <>Replace <code>{TOKEN_PLACEHOLDER}</code> with a token. A new token fills it in here.</>}
            </p>
            <CopyBlock label="Claude Code" hint="run this in your terminal" text={claudeCodeSetupCommand(url, secret)} />
            <CopyBlock label="Other MCP clients" hint="add to the client's MCP config" text={genericMcpConfig(url, secret)} />

            <div className="markie-overlay-section mb-1.5 mt-4">Your tokens</div>
            {loadError ? (
              <div role="alert" className="text-[12px] text-[var(--status-red)]">
                {loadError}{" "}
                <button onClick={() => void load()} className="underline text-foreground">
                  Try again
                </button>
              </div>
            ) : tokens === null ? (
              <p className="text-[12px] text-muted" role="status">
                Loading&hellip;
              </p>
            ) : tokens.length === 0 ? (
              <p className="text-[12px] text-muted">No tokens yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border border border-border rounded-md">
                {tokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-2.5 py-2 text-[12px]">
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate">{t.name}</div>
                      <div className="text-muted text-[11px] truncate">
                        {t.prefix ? <code>{t.prefix}&hellip;</code> : null}
                        {t.prefix ? " · " : ""}
                        {t.createdAt !== null && formatWhen(t.createdAt) ? `Created ${formatWhen(t.createdAt)}` : "Created"}
                        {" · "}
                        {t.lastUsedAt !== null && formatWhen(t.lastUsedAt) ? `Last used ${formatWhen(t.lastUsedAt)}` : "Never used"}
                      </div>
                    </div>
                    <button
                      onClick={() => void revoke(t)}
                      disabled={revoking === t.id}
                      aria-label={`Revoke ${t.name}`}
                      className="markie-overlay-button text-[11px] px-2 py-0.5 rounded-md text-muted hover:text-[var(--status-red)] disabled:opacity-50"
                    >
                      {revoking === t.id ? "Revoking…" : "Revoke"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {revokeError && (
              <p role="alert" className="text-[12px] text-[var(--status-red)] mt-2">
                {revokeError}
              </p>
            )}
            <p className="text-[11px] text-muted leading-relaxed mt-3">
              You can have up to 20 active tokens. Each token can make 60 changes an hour.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
