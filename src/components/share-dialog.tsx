"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  sharesClient,
  type ShareAccess,
  type ShareMember,
} from "@/lib/auth-client";
import { useAuth } from "@/lib/auth-store";
import { localAssetCount } from "@/lib/attach";
import { colorForName, initials } from "@/lib/collab";
import { getDocTheme, setDocTheme } from "@/lib/theme-sync";
import { findTheme, loadThemeStore } from "@/lib/theme";
import {
  shareAccessLine,
  shareCapabilityView,
  shareMembersEmptyLine,
  sharePublicLinkUnavailableLine,
  shareRoleLabel,
} from "@/lib/share-access-view";
import {
  generalAccessFor,
  generalAccessLine,
  publishWarning,
  revokeWarning,
  roleDescription,
} from "@/lib/general-access";
import { getElectronAPI } from "@/lib/electron";

interface ShareDialogProps {
  docId: string;
  fileName: string;
  // The document's markdown, so the dialog can say what will not travel with
  // it. Sharing sends the text and nothing else.
  body?: string;
  onClose: () => void;
  // Membership changed — the page re-evaluates whether the doc is live
  onChanged: () => void;
}

export function ShareDialog({
  docId,
  fileName,
  body = "",
  onClose,
  onChanged,
}: ShareDialogProps) {
  const { user: me } = useAuth();
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
  // Which person's role is mid-change, so only their row shows it.
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
  // Publishing asks once before it happens.
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      sharesClient.access(docId),
      sharesClient.list(docId),
      sharesClient.getPublicLink(docId),
    ]).then(([nextAccess, list, url]) => {
      setAccess(nextAccess);
      setMembers(list ?? []);
      setPublicUrl(url);
    });
  }, [docId]);

  useEffect(() => {
    load();
    getDocTheme(docId).then((tokens) => setThemePinned(!!tokens));
  }, [load, docId]);

  const toggleThemePin = async () => {
    if (!canManage) return setError("Only the owner can pin the shared theme.");
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

  const accessChecking = members === null;
  const canManage = !!access?.canManage;

  const handleAdd = async () => {
    if (!canManage) return setError("Only the owner can invite people.");
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
    if (!canManage) return setError("Only the owner can remove access.");
    setBusy(true);
    const ok = await sharesClient.remove(docId, idOrEmail);
    setBusy(false);
    if (ok) {
      await load();
      onChanged();
    }
  };

  // Changing somebody's role reuses the invite call, which upserts. Kept as its
  // own function so the row can show which person is mid-change.
  const changeRole = async (
    target: string,
    nextRole: "viewer" | "editor"
  ) => {
    if (!canManage) return setError("Only the owner can change what people can do.");
    setRoleBusy(target);
    setError(null);
    const res = await sharesClient.add(docId, target, nextRole);
    setRoleBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't change their access");
      return;
    }
    await load();
    onChanged();
  };

  // Publishing is the one action here that cannot be taken back for anyone who
  // already has the URL, so it asks first and says what it means in the file's
  // own name. Everything else in this dialog is reversible.
  const createLink = async () => {
    if (!canManage) return setError("Only the owner can create a public link.");
    if (!confirmingPublish) {
      setConfirmingPublish(true);
      return;
    }
    setConfirmingPublish(false);
    setLinkBusy(true);
    setError(null);
    const url = await sharesClient.createPublicLink(docId);
    setLinkBusy(false);
    if (url) setPublicUrl(url);
    else setError("Public link unavailable — check your connection and try again.");
  };

  // Seeing the page a stranger sees is the only way to be sure what is exposed.
  // Reading the URL is not the same as looking at it.
  const viewPublicPage = () => {
    if (!publicUrl) return;
    const api = getElectronAPI();
    if (api?.openExternal) api.openExternal(publicUrl);
    else window.open(publicUrl, "_blank", "noopener");
  };

  const revokeLink = async () => {
    if (!canManage) return setError("Only the owner can revoke the public link.");
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
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[440px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl p-5"
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
        <ShareAccessSummary access={access} checking={accessChecking} />
        <LocalFilesNotice count={localAssetCount(body)} />

        {/* The standing answer to "who can see this". Above the controls,
            because it is the thing you came here to find out, and loudest when
            the answer is "anyone". */}
        {members !== null && (
          <WhoCanSeeThis
            line={generalAccessLine({
              general: generalAccessFor(publicUrl),
              namedCount: members.filter((m) => !m.pending).length,
              invitedCount: members.filter((m) => m.pending).length,
            })}
            isPublic={!!publicUrl}
          />
        )}

        {canManage && (
          <div className="mb-4">
            <div className="markie-overlay-section mb-2">Invite by email</div>
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
            {error && <StatusRow tone="error">{error}</StatusRow>}
            {flash && <StatusRow tone="ok">{flash}</StatusRow>}
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
                role="owner"
              />
            )}
            {members.map((m) => (
              <MemberRow
                key={m.user_id ?? m.email}
                name={m.name || m.email}
                email={m.email}
                role={m.role === "editor" ? "editor" : "viewer"}
                pending={m.pending}
                busy={roleBusy === (m.pending ? m.email : m.user_id)}
                onRoleChange={
                  canManage
                    ? (next) => changeRole(m.email, next)
                    : undefined
                }
                onRemove={
                  canManage
                    ? () => handleRemove(m.pending ? m.email : (m.user_id as string))
                    : undefined
                }
              />
            ))}
            {members.length === 0 && (
              <div className="text-[12px] text-muted">
                {shareMembersEmptyLine(access)}
              </div>
            )}
          </div>
        )}

        {/* General access. Presented as the document's current state with two
            settings, not as a button that makes a feature appear: "Restricted"
            has to be visible as a live choice, or nobody ever learns it was
            the alternative. */}
        <div data-markie-general-access className="mt-5 pt-4 border-t border-border">
          <div className="markie-overlay-section mb-2">General access</div>

          {!canManage ? (
            <div className="text-[11px] text-muted">
              {sharePublicLinkUnavailableLine(access)}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-[13px]">
                  {publicUrl ? "🌐" : "🔒"}
                </span>
                <select
                  value={publicUrl ? "link" : "restricted"}
                  disabled={linkBusy}
                  onChange={(e) => {
                    setConfirmingPublish(false);
                    if (e.target.value === "link") createLink();
                    else revokeLink();
                  }}
                  aria-label="General access"
                  className="markie-overlay-field text-[12px] px-2 py-1.5 disabled:opacity-50"
                >
                  <option value="restricted">Restricted</option>
                  <option value="link">Anyone with the link</option>
                </select>
                {linkBusy && <span className="text-[11px] text-muted">Working…</span>}
              </div>

              <div className="text-[11px] text-muted mt-2 leading-snug">
                {publicUrl
                  ? revokeWarning()
                  : "Only people you add above can open it. Backing the document up to the cloud does not publish it."}
              </div>

              {/* Publishing asks once. It is the only control in this dialog
                  whose effect survives being undone. */}
              {confirmingPublish && !publicUrl && (
                <div className="mt-2 rounded-md border border-[color:var(--status-yellow)] px-3 py-2">
                  <div className="text-[11px] leading-snug text-[var(--status-yellow)]">
                    {publishWarning(fileName)}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={createLink}
                      disabled={linkBusy}
                      className="markie-overlay-button text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Publish it
                    </button>
                    <button
                      onClick={() => setConfirmingPublish(false)}
                      className="markie-overlay-button text-[12px] px-3 py-1.5 text-muted hover:text-foreground"
                    >
                      Keep it private
                    </button>
                  </div>
                </div>
              )}

              {publicUrl && (
                <div className="mt-2">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={publicUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Public link"
                      className="markie-overlay-field flex-1 text-[12px] px-2 py-1.5 text-muted"
                    />
                    <button
                      onClick={copyLink}
                      className="markie-overlay-button text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  {/* Reading a URL is not the same as looking at the page.
                      Seeing it is the only way to know what is exposed. */}
                  <button
                    onClick={viewPublicPage}
                    className="markie-overlay-button text-[12px] mt-2 px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground"
                  >
                    See what a stranger sees ↗
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  tone,
  children,
}: {
  tone: "ok" | "error";
  children: ReactNode;
}) {
  return (
    <div className={`markie-status-row markie-status-row--${tone} mt-2`} role="status">
      {tone === "ok" ? <CheckIcon /> : <AlertIcon />}
      <span>{children}</span>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ShareAccessSummary({
  access,
  checking,
}: {
  access: ShareAccess | null;
  checking: boolean;
}) {
  const capabilities = shareCapabilityView(access);
  return (
    <div className="mb-4 rounded-md border border-border/70 bg-background/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted">Your access</div>
          <div className="mt-0.5 text-[13px] font-medium text-foreground">
            {shareRoleLabel(access, checking)}
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
        {shareAccessLine(access, checking)}
      </div>
    </div>
  );
}

// The sentence that says what the document's exposure actually is. Styled by
// state rather than uniformly: "anyone on the internet" should not look the
// same as "only you".
function WhoCanSeeThis({ line, isPublic }: { line: string; isPublic: boolean }) {
  return (
    <div
      data-markie-access-line
      data-public={isPublic ? "true" : "false"}
      role="status"
      className={`mb-4 rounded-md border px-3 py-2 text-[12px] leading-snug ${
        isPublic
          ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
          : "border-border/70 text-muted"
      }`}
      style={isPublic ? { background: "rgba(250,204,21,0.07)" } : undefined}
    >
      {isPublic && <span aria-hidden="true">⚠ </span>}
      {line}
    </div>
  );
}

function MemberRow({
  name,
  email,
  role,
  pending,
  busy,
  onRoleChange,
  onRemove,
}: {
  name: string;
  email: string;
  // "owner" is not a role anyone can be moved to or from, so it renders as a
  // label rather than a choice.
  role: "viewer" | "editor" | "owner";
  pending?: boolean;
  busy?: boolean;
  onRoleChange?: (next: "viewer" | "editor") => void;
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
        {/* An invited person has no access at all until they sign up. Saying
            "Viewer" alone reads as though they already have it. */}
        <div className="text-[11px] text-muted truncate">
          {pending ? "Invited, not joined yet" : email}
        </div>
      </div>
      {onRoleChange && role !== "owner" ? (
        <select
          value={role}
          disabled={busy}
          onChange={(e) => onRoleChange(e.target.value as "viewer" | "editor")}
          aria-label={`What ${name} can do`}
          title={roleDescription(role)}
          className="markie-overlay-field text-[11px] px-1.5 py-1 disabled:opacity-50"
        >
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </select>
      ) : (
        <span className="text-[11px] text-muted" title={roleDescription(role)}>
          {role === "owner" ? "Owner" : role === "editor" ? "Can edit" : "Can view"}
        </span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name} — takes effect immediately`}
          className="markie-overlay-close hover:text-[var(--status-red)] text-[13px]"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Said before either sharing control, not after, because the moment to learn
 * that a picture will be missing is before somebody else opens the link.
 *
 * The plan is to upload these to storage of our own and rewrite the links, at
 * which point this notice goes away. Until then the honest thing is to say what
 * happens rather than let the recipient discover it.
 */
function LocalFilesNotice({ count }: { count: number }) {
  if (count < 1) return null;
  return (
    <div
      className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-[1.5] text-muted"
      role="note"
    >
      <span className="text-foreground font-medium">
        {count === 1 ? "1 file on this computer" : `${count} files on this computer`}
      </span>{" "}
      {count === 1 ? "is" : "are"} linked from this document. Sharing sends the
      text, so whoever opens it will see a gap where{" "}
      {count === 1 ? "it is" : "they are"}. To send{" "}
      {count === 1 ? "it" : "them"} along, use Export, which folds pictures into
      the file itself.
    </div>
  );
}
