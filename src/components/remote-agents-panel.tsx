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
  offersNoAgentTokens,
  revokeAgentToken,
  type AgentToken,
  type CreatedAgentToken,
} from "@/lib/agent-tokens";
import { CopyBlock } from "@/components/copy-block";

interface RemoteAgentsPanelProps {
  onClose: () => void;
  /**
   * Told whenever a token that has not been copied yet is on screen (and false
   * when it goes, or the panel does), so the app does not close the dialog
   * over a secret the user cannot get back.
   */
  onSecretShownChange?: (shown: boolean) => void;
}

// What a dialog can be tabbed to.
const FOCUSABLE = 'button,input,textarea,select,a[href],[tabindex="0"]';

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
export function RemoteAgentsPanel({ onClose, onSecretShownChange }: RemoteAgentsPanelProps) {
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
  // The server answered "no such route" to the list or create call.
  const [unavailable, setUnavailable] = useState(false);
  // Only the newest list request may write, so an account switch cannot land
  // another account's tokens on screen.
  const ticket = useRef(0);
  const invalidate = useCallback(() => {
    ticket.current++;
  }, []);
  // One ticket per signed-in session of this panel. A create or revoke takes it
  // before it awaits and drops its answer if it moved: a sign-out, an account
  // switch or the panel closing all move it (the same guard auth-client's api()
  // keeps with its session epoch). Separate from the list ticket, which a plain
  // "Try again" is allowed to bump.
  const session = useRef(0);
  const endSession = useCallback(() => {
    session.current++;
  }, []);
  const dialog = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoadError(null);
    const res = await listAgentTokens();
    if (mine !== ticket.current) return;
    if (res.ok) {
      setTokens(res.data);
      setUnavailable(false);
    } else {
      setTokens(null);
      setLoadError(res.message);
      setUnavailable(offersNoAgentTokens(res.status));
    }
  }, []);

  useEffect(() => {
    endSession();
    // A different account, or none, never inherits what the last one made.
    setFresh(null);
    setTokens(null);
    setLoadError(null);
    setCreateError(null);
    setRevokeError(null);
    setUnavailable(false);
    setCreating(false);
    setRevoking(null);
    if (!signedIn) {
      invalidate();
      return;
    }
    void load();
    return () => {
      endSession();
      invalidate();
    };
  }, [signedIn, userId, load, invalidate, endSession]);

  // Tell the app while a token that has not been copied is on screen.
  const reportSecret = useRef(onSecretShownChange);
  reportSecret.current = onSecretShownChange;
  useEffect(() => {
    reportSecret.current?.(fresh !== null);
  }, [fresh]);
  useEffect(() => () => reportSecret.current?.(false), []);

  // Focus moves into the panel when it opens and goes back to whatever opened
  // it when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) opener.focus();
      });
    };
  }, []);

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
    const mine = session.current;
    setCreating(true);
    setCreateError(null);
    const res = await createAgentToken(trimmed);
    // Answered for an account that is no longer here: show it to nobody. The
    // token it made stays on that account's list, where it can be revoked.
    if (mine !== session.current) return;
    setCreating(false);
    if (!res.ok) {
      setCreateError(res.message);
      if (offersNoAgentTokens(res.status)) setUnavailable(true);
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
    if (!window.confirm(`Revoke “${token.name}”? Any agent using it stops working right away. The documents it made stay in your Cloud. This cannot be undone.`)) return;
    const mine = session.current;
    setRevoking(token.id);
    setRevokeError(null);
    const res = await revokeAgentToken(token.id);
    if (mine !== session.current) return;
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
        ref={dialog}
        tabIndex={-1}
        className="markie-overlay-panel w-[520px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-xl p-5 outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-remote-agents-title"
        onKeyDown={(e) => {
          // Tab stays inside the panel, wrapping at both ends.
          if (e.key !== "Tab") return;
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (el) => !el.hasAttribute("disabled") && !el.hidden && !el.closest("[inert]")
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          const focused = document.activeElement;
          if (e.shiftKey && (focused === first || focused === e.currentTarget)) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && (focused === last || focused === e.currentTarget)) {
            e.preventDefault();
            first?.focus();
          }
        }}
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
          Markie Cloud with a token you make here. A token can create documents, and it can read and edit only the
          documents that same token created. It cannot reach your other documents, the ones another token made, or the
          ones an agent on this computer put in your Cloud. They stay private to you and open in the Markie app.
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
        ) : unavailable ? (
          // No tokens here, so there is nothing to set up: a URL and a command
          // for a route that does not exist would only send the user off to
          // paste something that cannot work.
          <p role="alert" className="text-[12px] text-[var(--status-red)] leading-relaxed">
            {loadError ?? createError ?? "This server does not offer agent tokens."}
          </p>
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
