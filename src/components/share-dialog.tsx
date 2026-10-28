import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getServerURL,
  type ShareAccess,
  type ShareContact,
  type ShareMember,
} from "@/lib/auth-client";
import { sharesClientFor, useAuthFor } from "@/lib/server-sessions";
import { localAssetCount } from "@/lib/attach";
import { colorForName, initials } from "@/lib/collab";
import { shareMembersEmptyLine } from "@/lib/share-access-view";
import { roleDescription } from "@/lib/general-access";
import { getElectronAPI } from "@/lib/electron";

// Shaped after Google Docs' share dialog, because that is the one people
// already know: add people at the top, who has access in the middle, general
// access below, and the link one click away in the footer from the moment the
// dialog opens.

type Role = "viewer" | "editor";

interface ShareDialogProps {
  docId: string;
  // The server the document lives on, when it is not Markie Cloud. Everything
  // here then goes to that server, as that server's account.
  server?: string;
  fileName: string;
  // The document's markdown, so the dialog can say what will not travel with
  // it. Sharing sends the text and nothing else.
  body?: string;
  onClose: () => void;
  // Membership changed: the page re-evaluates whether the doc is live
  onChanged: () => void;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_SUGGESTIONS = 6;

function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function ShareDialog({
  docId,
  server,
  fileName,
  body = "",
  onClose,
  onChanged,
}: ShareDialogProps) {
  const { user: me } = useAuthFor(server);
  const sharesClient = sharesClientFor(server);
  const [access, setAccess] = useState<ShareAccess | null>(null);
  const [members, setMembers] = useState<ShareMember[] | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [contacts, setContacts] = useState<ShareContact[]>([]);

  // The "Add people" field: addresses already chosen, plus what is being typed.
  const [pending, setPending] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Which person's row is mid-change, so only that row shows it.
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    return Promise.all([
      sharesClient.access(docId),
      sharesClient.list(docId),
      sharesClient.getPublicLink(docId),
    ]).then(([nextAccess, list, url]) => {
      setAccess(nextAccess);
      setMembers(list ?? []);
      setPublicUrl(url);
      setLoaded(true);
    });
  }, [docId, sharesClient]);

  useEffect(() => {
    load();
  }, [load]);

  const canManage = !!access?.canManage;

  useEffect(() => {
    if (!canManage) return;
    let live = true;
    sharesClient.contacts().then((list) => {
      if (live) setContacts(list);
    });
    return () => {
      live = false;
    };
  }, [canManage, sharesClient]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Everyone already on the document, so suggestions never offer them again.
  const taken = useMemo(() => {
    const set = new Set<string>(pending);
    for (const m of members ?? []) set.add(m.email.toLowerCase());
    if (me?.email) set.add(me.email.toLowerCase());
    return set;
  }, [members, pending, me?.email]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return contacts
      .filter((c) => !taken.has(c.email.toLowerCase()))
      .filter(
        (c) =>
          c.email.toLowerCase().includes(q) ||
          (c.name ?? "").toLowerCase().includes(q)
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [contacts, query, taken]);

  const showMenu = menuOpen && suggestions.length > 0;

  const addPending = (address: string) => {
    const clean = address.trim().toLowerCase();
    if (!clean) return;
    if (!isEmail(clean)) {
      setError(`"${address.trim()}" is not an email address.`);
      return;
    }
    setError(null);
    setFlash(null);
    if (!taken.has(clean)) setPending((p) => [...p, clean]);
    setQuery("");
    setMenuOpen(false);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const removePending = (address: string) => {
    setPending((p) => p.filter((a) => a !== address));
    inputRef.current?.focus();
  };

  const cancelInvite = () => {
    setPending([]);
    setQuery("");
    setMenuOpen(false);
    setError(null);
  };

  // What Send would send: the chosen addresses, plus a finished address still
  // sitting in the field, so nobody has to press Enter before Send.
  const toSend = useMemo(() => {
    const typed = query.trim().toLowerCase();
    return isEmail(typed) && !pending.includes(typed) ? [...pending, typed] : pending;
  }, [pending, query]);
  const inviting = toSend.length > 0;

  const send = async () => {
    if (!canManage) return setError("Only the owner can invite people.");
    if (toSend.length === 0) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    const failed: { email: string; error: string }[] = [];
    const invited: string[] = [];
    const shared: string[] = [];
    for (const target of toSend) {
      const res = await sharesClient.add(docId, target, role);
      if (!res.ok) failed.push({ email: target, error: res.error ?? "Couldn't share the doc" });
      else if (res.status === "invited") invited.push(target);
      else shared.push(target);
    }
    setBusy(false);
    const failedEmails = failed.map((f) => f.email);
    setPending(failedEmails);
    // Whatever failed stays as a chip, so it can be fixed and sent again.
    setQuery("");
    if (failed.length > 0) {
      setError(
        failed.length === 1 && toSend.length === 1
          ? failed[0].error
          : failed.map((f) => `${f.email}: ${f.error}`).join(" ")
      );
    }
    const lines: string[] = [];
    if (shared.length) lines.push(`Shared with ${listOf(shared)}.`);
    if (invited.length) {
      lines.push(
        `Invited ${listOf(invited)}. ${
          invited.length === 1 ? "They get" : "Each gets"
        } an email, and it lands in their Library when they join.`
      );
    }
    if (lines.length) setFlash(lines.join(" "));
    if (shared.length || invited.length) {
      await load();
      onChanged();
    }
  };

  // idOrEmail: member user id, or the email for a pending invite
  const removeMember = async (idOrEmail: string) => {
    if (!canManage) return setError("Only the owner can remove access.");
    setRowBusy(idOrEmail);
    setError(null);
    const ok = await sharesClient.remove(docId, idOrEmail);
    setRowBusy(null);
    if (!ok) return setError("Couldn't remove their access.");
    await load();
    onChanged();
  };

  // Changing somebody's role reuses the invite call, which upserts.
  const changeRole = async (rowKey: string, target: string, nextRole: Role) => {
    if (!canManage) return setError("Only the owner can change what people can do.");
    setRowBusy(rowKey);
    setError(null);
    const res = await sharesClient.add(docId, target, nextRole);
    setRowBusy(null);
    if (!res.ok) return setError(res.error ?? "Couldn't change their access");
    await load();
    onChanged();
  };

  // General access. "Anyone with the link" publishes at once, the way Docs
  // does: the select itself is the decision, and Restricted takes it back.
  const setGeneralAccess = async (next: "restricted" | "link") => {
    if (!canManage) return setError("Only the owner can change general access.");
    setLinkBusy(true);
    setError(null);
    if (next === "link") {
      const url = await sharesClient.createPublicLink(docId);
      setLinkBusy(false);
      if (url) setPublicUrl(url);
      else setError("Couldn't turn on the link. Check your connection and try again.");
    } else {
      const ok = await sharesClient.revokePublicLink(docId);
      setLinkBusy(false);
      if (ok) setPublicUrl(null);
      else setError("Couldn't turn off the link. Check your connection and try again.");
    }
  };

  // The link Copy hands out: the public page when anyone may open it, and
  // otherwise the document's own page, which opens for the people above.
  const privateUrl = `${(server ?? getServerURL()).replace(/\/+$/, "")}/d/${encodeURIComponent(docId)}`;
  const linkToCopy = publicUrl ?? privateUrl;

  const copyLink = () => {
    navigator.clipboard.writeText(linkToCopy).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setError("Couldn't copy the link.")
    );
  };

  // Seeing the page a stranger sees is the only way to be sure what is exposed.
  const viewPublicPage = () => {
    if (!publicUrl) return;
    const api = getElectronAPI();
    if (api?.openExternal) api.openExternal(publicUrl);
    else window.open(publicUrl, "_blank", "noopener");
  };

  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setMenuOpen(true);
      setHighlight((h) => (showMenu ? (h + 1) % suggestions.length : 0));
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setMenuOpen(true);
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showMenu) addPending(suggestions[Math.min(highlight, suggestions.length - 1)].email);
      else if (query.trim()) addPending(query);
      else if (pending.length > 0) void send();
    } else if (e.key === "," || e.key === ";" || (e.key === "Tab" && query.trim())) {
      if (query.trim()) {
        e.preventDefault();
        addPending(query);
      }
    } else if (e.key === "Backspace" && !query && pending.length > 0) {
      setPending((p) => p.slice(0, -1));
    } else if (e.key === "Escape") {
      // Escape steps back one level before it closes the dialog.
      if (showMenu) {
        e.stopPropagation();
        setMenuOpen(false);
      } else if (pending.length > 0 || query) {
        e.stopPropagation();
        cancelInvite();
      }
    }
  };

  const generalIsPublic = !!publicUrl;
  const memberCount = members?.length ?? 0;

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter markie-share w-[480px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-share-title"
      >
        <div className="markie-share-head">
          <h2 id="markie-share-title" className="markie-share-title" title={fileName}>
            Share &quot;{fileName}&quot;
          </h2>
          <button
            onClick={onClose}
            aria-label="Close share dialog"
            className="markie-overlay-close"
          >
            ×
          </button>
        </div>

        {canManage && (
          <div>
            <div className="markie-share-add">
            <div
              className="markie-share-field"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  inputRef.current?.focus();
                }
              }}
            >
              {pending.map((address) => (
                <span key={address} className="markie-share-chip">
                  <span
                    className="markie-share-avatar markie-share-avatar--sm"
                    style={{ background: colorForName(address) }}
                    aria-hidden="true"
                  >
                    {initials(address)}
                  </span>
                  <span className="truncate">{address}</span>
                  <button
                    type="button"
                    onClick={() => removePending(address)}
                    aria-label={`Don't add ${address}`}
                    className="markie-share-chip-x"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                autoFocus
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMenuOpen(true);
                  setHighlight(0);
                }}
                onFocus={() => setMenuOpen(true)}
                onBlur={() => setMenuOpen(false)}
                onKeyDown={onFieldKey}
                placeholder={pending.length ? "" : "Add people by email"}
                aria-label="Add people by email"
                role="combobox"
                aria-expanded={showMenu}
                aria-controls="markie-share-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={
                  showMenu ? `markie-share-suggestion-${highlight}` : undefined
                }
                className="markie-share-input"
              />
            </div>
            {showMenu && (
              <ul
                id="markie-share-suggestions"
                role="listbox"
                aria-label="Suggested people"
                className="markie-menu-panel markie-share-suggestions"
              >
                {suggestions.map((c, i) => (
                  <li
                    key={c.email}
                    id={`markie-share-suggestion-${i}`}
                    role="option"
                    aria-selected={i === highlight}
                    data-active={i === highlight ? "true" : "false"}
                    className="markie-share-suggestion"
                    // mousedown, not click: the field's blur would close the
                    // menu before a click landed.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addPending(c.email);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    <Avatar name={c.name || c.email} />
                    <div className="min-w-0 flex-1">
                      <div className="markie-share-name truncate">{c.name || c.email}</div>
                      {c.name && <div className="markie-share-sub truncate">{c.email}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            </div>

            {inviting && (
              <div className="markie-share-invite-row">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  aria-label="Role"
                  title={roleDescription(role)}
                  className="markie-overlay-field markie-share-select"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <span className="markie-share-sub flex-1">
                  {role === "editor" ? "Can edit and comment" : "Can read and comment"}
                </span>
                <button
                  type="button"
                  onClick={cancelInvite}
                  className="markie-overlay-button markie-share-btn markie-share-btn--quiet"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy}
                  className="markie-overlay-button markie-share-btn markie-share-btn--primary"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            )}
          </div>
        )}

        {error && <StatusRow tone="error">{error}</StatusRow>}
        {flash && <StatusRow tone="ok">{flash}</StatusRow>}
        <LocalFilesNotice count={localAssetCount(body)} />

        <div className="markie-share-section">
          <div className="markie-share-label">People with access</div>
          {!loaded ? (
            <div className="markie-share-sub py-1">Loading…</div>
          ) : (
            <div className="flex flex-col">
              {canManage && me && (
                <MemberRow
                  name={me.name ? `${me.name} (you)` : me.email}
                  email={me.email}
                  avatarName={me.name || me.email}
                  role="owner"
                />
              )}
              {(members ?? []).map((m) => {
                const key = m.pending ? m.email : (m.user_id as string);
                return (
                  <MemberRow
                    key={m.user_id ?? m.email}
                    name={m.name || m.email}
                    email={m.email}
                    avatarName={m.name || m.email}
                    role={m.role === "editor" ? "editor" : "viewer"}
                    pending={m.pending}
                    busy={rowBusy === key}
                    onRoleChange={
                      canManage ? (next) => changeRole(key, m.email, next) : undefined
                    }
                    onRemove={canManage ? () => removeMember(key) : undefined}
                  />
                );
              })}
              {memberCount === 0 && !canManage && (
                <div className="markie-share-sub py-1">{shareMembersEmptyLine(access)}</div>
              )}
              {!access && (
                <div className="markie-share-sub py-1">
                  Access details could not be loaded. Sign in again or check your
                  connection before changing sharing.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="markie-share-section" data-markie-general-access>
          <div className="markie-share-label">General access</div>
          <div className="markie-share-general">
            <span
              className="markie-share-general-icon"
              data-public={generalIsPublic ? "true" : "false"}
              aria-hidden="true"
            >
              {generalIsPublic ? <GlobeIcon /> : <LockIcon />}
            </span>
            <div className="min-w-0 flex-1">
              {canManage ? (
                <select
                  value={generalIsPublic ? "link" : "restricted"}
                  disabled={linkBusy || !loaded}
                  onChange={(e) =>
                    void setGeneralAccess(e.target.value as "restricted" | "link")
                  }
                  aria-label="General access"
                  className="markie-share-general-select"
                >
                  <option value="restricted">Restricted</option>
                  <option value="link">Anyone with the link</option>
                </select>
              ) : (
                <div className="markie-share-name font-medium">
                  {generalIsPublic ? "Anyone with the link" : "Restricted"}
                </div>
              )}
              <div className="markie-share-sub" data-markie-access-line>
                {linkBusy
                  ? "Updating…"
                  : generalIsPublic
                    ? "Anyone on the internet with the link can view"
                    : "Only people with access can open with the link"}
                {generalIsPublic && !linkBusy && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={viewPublicPage}
                      className="markie-share-inline-link"
                    >
                      See what a stranger sees
                    </button>
                  </>
                )}
              </div>
            </div>
            {generalIsPublic && <span className="markie-share-sub shrink-0">Viewer</span>}
          </div>
        </div>

        <div className="markie-share-foot">
          <button
            type="button"
            onClick={copyLink}
            data-copied={copied ? "true" : "false"}
            title={linkToCopy}
            className="markie-overlay-button markie-share-btn markie-share-copy"
          >
            {copied ? <CheckIcon /> : <LinkIcon />}
            {copied ? "Link copied" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="markie-overlay-button markie-share-btn markie-share-btn--primary"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function listOf(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Avatar({ name, pending }: { name: string; pending?: boolean }) {
  return (
    <span
      className="markie-share-avatar"
      data-pending={pending ? "true" : "false"}
      style={pending ? undefined : { background: colorForName(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function MemberRow({
  name,
  email,
  avatarName,
  role,
  pending,
  busy,
  onRoleChange,
  onRemove,
}: {
  name: string;
  email: string;
  avatarName: string;
  // "owner" is not a role anyone can be moved to or from, so it renders as a
  // label rather than a choice.
  role: Role | "owner";
  pending?: boolean;
  busy?: boolean;
  onRoleChange?: (next: Role) => void;
  onRemove?: () => void;
}) {
  const label = role === "owner" ? "Owner" : role === "editor" ? "Editor" : "Viewer";
  return (
    <div className="markie-share-row">
      <Avatar name={avatarName} pending={pending} />
      <div className="min-w-0 flex-1">
        <div className="markie-share-name truncate">{name}</div>
        {/* An invited person has no access at all until they sign up. Saying
            "Viewer" alone reads as though they already have it. */}
        <div className="markie-share-sub truncate">
          {pending ? "Invited, not joined yet" : email}
        </div>
      </div>
      {role !== "owner" && onRoleChange ? (
        <select
          value={role}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "remove") onRemove?.();
            else onRoleChange(next as Role);
          }}
          aria-label={`What ${name} can do`}
          title={roleDescription(role)}
          className="markie-share-role-select"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option disabled>──────────</option>
          <option value="remove">Remove access</option>
        </select>
      ) : (
        <span className="markie-share-sub shrink-0" title={roleDescription(role)}>
          {label}
        </span>
      )}
    </div>
  );
}

function StatusRow({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  return (
    <div className={`markie-status-row markie-status-row--${tone} mt-2`} role="status">
      {tone === "ok" ? <CheckIcon /> : <AlertIcon />}
      <span>{children}</span>
    </div>
  );
}

function svgProps(size = 16) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function LinkIcon() {
  return (
    <svg {...svgProps(15)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...svgProps(16)}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...svgProps(16)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...svgProps(14)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg {...svgProps(14)}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/**
 * Said before anything is shared, because the moment to learn that a picture
 * will be missing is before somebody else opens the link.
 *
 * The plan is to upload these to storage of our own and rewrite the links, at
 * which point this notice goes away. Until then the honest thing is to say what
 * happens rather than let the recipient discover it.
 */
function LocalFilesNotice({ count }: { count: number }) {
  if (count < 1) return null;
  return (
    <div className="markie-share-note" role="note">
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
