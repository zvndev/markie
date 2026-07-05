"use client";

import { useCallback, useEffect, useState } from "react";
import {
  authClient,
  sharesClient,
  type MarkieUser,
  type ShareAccess,
  type ShareMember,
} from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";
import { getDocTheme, setDocTheme } from "@/lib/theme-sync";
import { findTheme, loadThemeStore } from "@/lib/theme";
import {
  shareAccessLine,
  shareCapabilityView,
  shareRoleLabel,
} from "@/lib/share-access-view";

interface ShareDialogProps {
  docId: string;
  fileName: string;
  onClose: () => void;
  // Membership changed — the page re-evaluates whether the doc is live
  onChanged: () => void;
}

export function ShareDialog({
  docId,
  fileName,
  onClose,
  onChanged,
}: ShareDialogProps) {
  const [me, setMe] = useState<MarkieUser | null>(null);
  const [access, setAccess] = useState<ShareAccess | null>(null);
  const [members, setMembers] = useState<ShareMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [themePinned, setThemePinned] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      authClient.me(),
      sharesClient.access(docId),
      sharesClient.list(docId),
      sharesClient.getPublicLink(docId),
    ]).then(
      ([user, nextAccess, list, url]) => {
        setMe(user);
        setAccess(nextAccess);
        setMembers(list ?? []);
        setPublicUrl(url);
      }
    );
  }, [docId]);

  useEffect(() => {
    load();
    getDocTheme(docId).then((tokens) => setThemePinned(!!tokens));
  }, [load, docId]);

  const toggleThemePin = async () => {
    const next = !themePinned;
    setThemePinned(next);
    const store = loadThemeStore();
    const ok = await setDocTheme(
      docId,
      next ? findTheme(store, store.activeId).tokens : null
    );
    if (!ok) setThemePinned(!next);
    else onChanged();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canManage = !!access?.canManage;

  const handleAdd = async () => {
    const target = email.trim().toLowerCase();
    if (!target) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    const res = await sharesClient.add(docId, target, role);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't share the doc");
      return;
    }
    setEmail("");
    setFlash(
      res.status === "invited"
        ? `Invited ${target} — they'll get an email and it lands in their Library when they join.`
        : `Shared with ${target}.`
    );
    await load();
    onChanged();
  };

  // idOrEmail: member user id, or the email for a pending invite
  const handleRemove = async (idOrEmail: string) => {
    setBusy(true);
    const ok = await sharesClient.remove(docId, idOrEmail);
    setBusy(false);
    if (ok) {
      await load();
      onChanged();
    }
  };

  const createLink = async () => {
    setLinkBusy(true);
    setError(null);
    const url = await sharesClient.createPublicLink(docId);
    setLinkBusy(false);
    if (url) setPublicUrl(url);
    else setError("Couldn't create a public link");
  };

  const revokeLink = async () => {
    setLinkBusy(true);
    setError(null);
    const ok = await sharesClient.revokePublicLink(docId);
    setLinkBusy(false);
    if (ok) setPublicUrl(null);
    else setError("Couldn't revoke the link");
  };

  const copyLink = () => {
    if (!publicUrl) return;
    navigator.clipboard.writeText(publicUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError("Couldn't copy the link")
    );
  };

  return (
    <div
      className="markie-scrim fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel w-[440px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-share-title"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 id="markie-share-title" className="text-[14px] font-semibold text-foreground">Share</h2>
          <button
            onClick={onClose}
            aria-label="Close share dialog"
            className="markie-overlay-close"
          >
            ×
          </button>
        </div>
        <div className="text-[11px] text-muted mb-4 truncate">{fileName}</div>
        <ShareAccessSummary access={access} />

        {canManage && (
          <div className="mb-4">
            <div className="flex gap-2">
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                placeholder="person@example.com"
                className="markie-overlay-field flex-1 text-[13px] px-2.5 py-1.5"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                aria-label="Role"
                className="markie-overlay-field text-[12px] px-2"
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
              <button
                onClick={handleAdd}
                disabled={busy || !email.trim()}
                className="markie-overlay-button text-[13px] px-3 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50"
              >
                Invite
              </button>
            </div>
            {error && (
              <div className="text-[12px] text-[var(--status-red)] mt-2">{error}</div>
            )}
            {flash && (
              <div className="text-[12px] text-[var(--status-green)] mt-2">{flash}</div>
            )}
            <div className="text-[11px] text-muted mt-2">
              Anyone with an email works — no Markie account needed to invite
              them. They get an email; the doc shows up in their Library when
              they join, and editors edit live with you.
            </div>
            <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={themePinned}
                onChange={toggleThemePin}
                className="accent-current"
              />
              <span className="text-[12px] text-foreground/90">
                Viewers see my theme
              </span>
              <span className="text-[10px] text-muted">
                — pins your current preset to this doc
              </span>
            </label>
          </div>
        )}

        <div className="markie-overlay-section mb-2">
          People with access
        </div>
        {members === null ? (
          <div className="text-[12px] text-muted">Loading…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {canManage && me && (
              <MemberRow
                name={me.name || me.email}
                email={me.email}
                roleLabel="Owner"
              />
            )}
            {members.map((m) => (
              <MemberRow
                key={m.user_id ?? m.email}
                name={m.name || m.email}
                email={m.email}
                roleLabel={
                  m.pending
                    ? `Invited · ${m.role === "editor" ? "Editor" : "Viewer"}`
                    : m.role === "editor"
                      ? "Editor"
                      : "Viewer"
                }
                pending={m.pending}
                onRemove={
                  canManage
                    ? () => handleRemove(m.pending ? m.email : (m.user_id as string))
                    : undefined
                }
              />
            ))}
            {members.length === 0 && !canManage && (
              <div className="text-[12px] text-muted">Just you so far.</div>
            )}
            {members.length === 0 && canManage && (
              <div className="text-[12px] text-muted">
                Not shared with anyone yet.
              </div>
            )}
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-border">
          <div className="text-[12px] font-medium text-foreground mb-1">
            Anyone with the link
          </div>
          {publicUrl ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={publicUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="markie-overlay-field flex-1 text-[12px] px-2 py-1.5 text-muted"
                />
                <button
                  onClick={copyLink}
                  className="markie-overlay-button text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] text-muted">
                  Anyone with this link can view &amp; download — no account needed.
                </span>
                {canManage && (
                  <button
                    onClick={revokeLink}
                    disabled={linkBusy}
                    className="text-[11px] text-[var(--status-red)] hover:opacity-80 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </>
          ) : !canManage ? (
            <div className="text-[11px] text-muted">
              Only the owner can create a public link.
            </div>
          ) : (
            <button
              onClick={createLink}
              disabled={linkBusy}
              className="markie-overlay-button text-[12px] px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground disabled:opacity-50"
            >
              {linkBusy ? "Creating…" : "Create a public link"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ShareAccessSummary({ access }: { access: ShareAccess | null }) {
  const capabilities = shareCapabilityView(access);
  return (
    <div className="mb-4 rounded-md border border-border/70 bg-background/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted">Your access</div>
          <div className="mt-0.5 text-[13px] font-medium text-foreground">
            {shareRoleLabel(access)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {capabilities.map((capability) => (
            <span
              key={capability.label}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                capability.enabled
                  ? "border-[color:var(--status-green)] text-[var(--status-green)]"
                  : "border-border text-muted"
              }`}
            >
              {capability.label}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-1.5 text-[11px] leading-snug text-muted">
        {shareAccessLine(access)}
      </div>
    </div>
  );
}

function MemberRow({
  name,
  email,
  roleLabel,
  pending,
  onRemove,
}: {
  name: string;
  email: string;
  roleLabel: string;
  pending?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
          pending ? "text-muted border border-dashed border-border" : "text-black/80"
        }`}
        style={pending ? undefined : { background: colorForName(name) }}
      >
        {pending ? "…" : initials(name)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-foreground truncate">{name}</div>
        <div className="text-[11px] text-muted truncate">{email}</div>
      </div>
      <span className="text-[11px] text-muted">{roleLabel}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="markie-overlay-close hover:text-[var(--status-red)] text-[13px]"
        >
          ×
        </button>
      )}
    </div>
  );
}
