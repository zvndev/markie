"use client";

import { useCallback, useEffect, useState } from "react";
import {
  authClient,
  sharesClient,
  type MarkieUser,
  type ShareMember,
} from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";
import { getDocTheme, setDocTheme } from "@/lib/theme-sync";
import { findTheme, loadThemeStore } from "@/lib/theme";

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
    sharesClient.getPublicLink(docId).then((url) => {
      setPublicUrl(url);
    });
    return Promise.all([authClient.me(), sharesClient.list(docId)]).then(
      ([user, list]) => {
        setMe(user);
        setMembers(list ?? []);
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

  // The owner isn't in the shares table; members see the list read-only
  const isOwner = !!me && !!members && !members.some((m) => m.user_id === me.id);

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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[440px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[14px] font-semibold text-foreground">Share</h2>
          <button
            onClick={onClose}
            aria-label="Close share dialog"
            className="text-muted hover:text-foreground"
          >
            ×
          </button>
        </div>
        <div className="text-[11px] text-muted mb-4 truncate">{fileName}</div>

        {isOwner && (
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
                className="flex-1 text-[13px] bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground outline-none focus:border-accent"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                aria-label="Role"
                className="text-[12px] bg-background border border-border rounded-md px-2 text-foreground outline-none"
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
              <button
                onClick={handleAdd}
                disabled={busy || !email.trim()}
                className="text-[13px] px-3 rounded-md bg-accent text-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                Invite
              </button>
            </div>
            {error && (
              <div className="text-[12px] text-red-400 mt-2">{error}</div>
            )}
            {flash && (
              <div className="text-[12px] text-green-400 mt-2">{flash}</div>
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

        <div className="text-[10px] uppercase tracking-wide text-muted mb-2">
          People with access
        </div>
        {members === null ? (
          <div className="text-[12px] text-muted">Loading…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {isOwner && me && (
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
                  isOwner
                    ? () => handleRemove(m.pending ? m.email : (m.user_id as string))
                    : undefined
                }
              />
            ))}
            {members.length === 0 && !isOwner && (
              <div className="text-[12px] text-muted">Just you so far.</div>
            )}
            {members.length === 0 && isOwner && (
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
                  className="flex-1 text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-muted outline-none"
                />
                <button
                  onClick={copyLink}
                  className="text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] text-muted">
                  Anyone with this link can view &amp; download — no account needed.
                </span>
                <button
                  onClick={revokeLink}
                  disabled={linkBusy}
                  className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={createLink}
              disabled={linkBusy}
              className="text-[12px] px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground disabled:opacity-50"
            >
              {linkBusy ? "Creating…" : "Create a public link"}
            </button>
          )}
        </div>
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
          className="text-muted hover:text-red-400 text-[13px] px-1"
        >
          ×
        </button>
      )}
    </div>
  );
}
