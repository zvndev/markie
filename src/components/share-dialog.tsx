"use client";

import { useCallback, useEffect, useState } from "react";
import {
  authClient,
  sharesClient,
  type MarkieUser,
  type ShareMember,
} from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";

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
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return Promise.all([authClient.me(), sharesClient.list(docId)]).then(
      ([user, list]) => {
        setMe(user);
        setMembers(list ?? []);
      }
    );
  }, [docId]);

  useEffect(() => {
    load();
  }, [load]);

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
    const res = await sharesClient.add(docId, target, role);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't share the doc");
      return;
    }
    setEmail("");
    await load();
    onChanged();
  };

  const handleRemove = async (userId: string) => {
    setBusy(true);
    const ok = await sharesClient.remove(docId, userId);
    setBusy(false);
    if (ok) {
      await load();
      onChanged();
    }
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
                <option value="editor">Can edit</option>
                <option value="viewer">Can view</option>
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
            <div className="text-[11px] text-muted mt-2">
              They get an email, and the doc appears in their Library. Everyone
              in it edits live, together.
            </div>
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
                key={m.user_id}
                name={m.name || m.email}
                email={m.email}
                roleLabel={m.role === "editor" ? "Editor" : "Viewer"}
                onRemove={isOwner ? () => handleRemove(m.user_id) : undefined}
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
      </div>
    </div>
  );
}

function MemberRow({
  name,
  email,
  roleLabel,
  onRemove,
}: {
  name: string;
  email: string;
  roleLabel: string;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-black/80 shrink-0"
        style={{ background: colorForName(name) }}
      >
        {initials(name)}
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
