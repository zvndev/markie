// Sharing a document from the phone, through the routes the desktop's share
// dialog uses: invite by email, change someone's role, take them off. Only
// the owner manages people; anyone on the document can see who else is.
import { useCallback, useEffect, useState } from "react";
import { ApiError, type ShareRole } from "../lib/api";
import { haptics, shareLink } from "../lib/native";
import { Sheet } from "./sheet";
import { Avatar } from "./presence";
import { ShareIcon } from "./icons";

export interface SharePerson {
  /** Null for an invitation nobody has taken up yet. */
  userId: string | null;
  email: string;
  name: string | null;
  role: ShareRole;
  pending: boolean;
}

/** The calls the sheet makes, for whichever store the document lives in. */
export interface SharePeopleApi {
  list(): Promise<SharePerson[]>;
  add(email: string, role: ShareRole): Promise<"member" | "invited">;
  setRole(person: SharePerson, role: ShareRole): Promise<void>;
  remove(person: SharePerson): Promise<void>;
  /** Whether an unknown address gets an invitation email (Markdown) or is refused (the document platform). */
  invites: boolean;
}

/**
 * The owner's public link (server/src/shares.ts /public-link), the desktop
 * share dialog's "Anyone with the link". Private is the default: nothing here
 * turns it on except the owner tapping "Make public".
 */
export interface PublicLinkApi {
  get(): Promise<string | null>;
  create(): Promise<string>;
  revoke(): Promise<void>;
}

interface ShareSheetProps {
  title: string;
  people: SharePeopleApi;
  /** Owner only, and only for a document that has a web page. */
  publicLink?: PublicLinkApi | null;
  canManage: boolean;
  /**
   * For someone who doesn't own it: who does, as the list names them (Shared
   * by). The owner is never in the member list the server sends, so the
   * sheet adds them, as the desktop names them. Null when not known.
   */
  owner?: string | null;
  me: { email: string; name: string };
  /** The private link, for the system share sheet. None for a file that has no web page. */
  link: string | null;
  onClose: () => void;
  onUnauthorized: () => void;
  /** After any change, so the screen underneath can recount who is on it. */
  onChanged?: () => void;
}

export function ShareSheet({ title, people, publicLink = null, canManage, owner = null, me, link, onClose, onUnauthorized, onChanged }: ShareSheetProps) {
  const [list, setList] = useState<SharePerson[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const failed = useCallback((failure: unknown, fallback: string) => {
    if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
    setError(failure instanceof Error && failure.message ? failure.message : fallback);
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    try {
      setList(await people.list());
    } catch (failure) {
      failed(failure, "Couldn't load who has access.");
      setList([]);
    }
  }, [people, failed]);
  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      haptics.success();
      if (message) setNotice(message);
      await load();
      onChanged?.();
    } catch (failure) {
      failed(failure, "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const invite = () => {
    const address = email.trim();
    if (!address) return;
    void act(async () => {
      const result = await people.add(address, role);
      setEmail("");
      return result === "invited"
        ? `Invitation sent to ${address}. They can open it once they sign in with that address.`
        : `${address} can ${role === "editor" ? "edit" : "view"} this document now.`;
    });
  };

  return (
    <Sheet title="Share" onClose={onClose} tall className="m-share">
      <p className="m-share-doc">{title}</p>
      {link ? (
        <div className="m-group">
          <button type="button" className="m-group-action" onClick={() => void shareLink(title, link)}>
            <ShareIcon size={20} />
            <span>Send the link</span>
          </button>
        </div>
      ) : null}
      {link ? <p className="m-group-footer">The link opens only for people on this document, after they sign in.</p> : null}

      {canManage ? (
        <form className="m-share-invite" onSubmit={(event) => { event.preventDefault(); invite(); }}>
          <h3 className="m-group-heading">Add people</h3>
          <div className="m-share-invite-row">
            <input
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="name@example.com"
              aria-label="Email address to share with"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              enterKeyHint="send"
            />
            <RolePicker value={role} onChange={setRole} label="Role for the new person" />
          </div>
          <button type="submit" className="m-button m-button-primary" disabled={busy || !email.trim()}>{busy ? "Sharing…" : people.invites ? "Share" : "Add"}</button>
          {!people.invites ? <p className="m-group-footer">This file can be shared with people who already have a Markie account.</p> : null}
        </form>
      ) : null}

      {notice ? <p className="m-share-notice" role="status">{notice}</p> : null}
      {error ? <p className="m-form-error" role="alert">{error}</p> : null}

      {publicLink && canManage ? <PublicLinkSection api={publicLink} title={title} onUnauthorized={onUnauthorized} onChanged={onChanged} /> : null}

      <h3 className="m-group-heading">People with access</h3>
      <ul className="m-group m-share-people" aria-label="People with access">
        {canManage ? (
          <li className="m-share-person">
            <Avatar name={me.name || me.email} />
            <span className="m-share-person-text">
              <span className="m-share-person-name">{me.name || me.email} (you)</span>
              {me.name ? <span className="m-share-person-email">{me.email}</span> : null}
            </span>
            <span className="m-share-person-role">Owner</span>
          </li>
        ) : (
          <li className="m-share-person" data-share-owner>
            <Avatar name={owner || "Owner"} />
            <span className="m-share-person-text">
              <span className="m-share-person-name">{owner || "The document's owner"}</span>
            </span>
            <span className="m-share-person-role">Owner</span>
          </li>
        )}
        {list === null ? <li className="m-share-person"><span className="m-spinner" aria-hidden="true" /><span className="m-visually-hidden" role="status">Loading</span></li> : null}
        {list?.map((person) => {
          const label = person.name || person.email;
          const isMe = person.email.toLowerCase() === me.email.toLowerCase();
          return (
            <li key={person.userId ?? `invite:${person.email}`} className="m-share-person">
              <Avatar name={label} />
              <span className="m-share-person-text">
                <span className="m-share-person-name">{label}{isMe ? " (you)" : ""}</span>
                <span className="m-share-person-email">{person.pending ? `Invited · ${person.email}` : person.name ? person.email : ""}</span>
              </span>
              {canManage ? (
                <span className="m-share-person-actions">
                  <RolePicker value={person.role} label={`Role for ${label}`} disabled={busy} onChange={(next) => {
                    if (next === person.role) return;
                    void act(async () => { await people.setRole(person, next); return `${label} can ${next === "editor" ? "edit" : "only view"} now.`; });
                  }} />
                  <button type="button" className="m-share-remove" aria-label={`Remove ${label}`} disabled={busy} onClick={() => {
                    if (!window.confirm(person.pending ? `Withdraw the invitation to ${person.email}?` : `Remove ${label} from this document?`)) return;
                    void act(async () => { await people.remove(person); return person.pending ? "Invitation withdrawn." : `${label} no longer has access.`; });
                  }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  </button>
                </span>
              ) : (
                <span className="m-share-person-role">{person.role === "editor" ? "Can edit" : "Can view"}</span>
              )}
            </li>
          );
        })}
      </ul>
      {list && list.length === 0 && canManage ? <p className="m-group-footer">Nobody else is on this document yet. Once someone is, you edit it together live.</p> : null}
    </Sheet>
  );
}

function PublicLinkSection({ api, title, onUnauthorized, onChanged }: { api: PublicLinkApi; title: string; onUnauthorized: () => void; onChanged?: () => void }) {
  // undefined while asking; null when the document is private; "unknown"
  // when the answer never came, which is not the same as private.
  const [url, setUrl] = useState<string | null | undefined | "unknown">(undefined);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setUrl(undefined);
    setError(null);
    api.get().then((value) => { if (live) setUrl(value); }, (failure) => {
      if (!live) return;
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      setUrl("unknown");
      setError("Couldn't check whether this document is public.");
    });
    return () => { live = false; };
  }, [api, onUnauthorized, attempt]);

  const change = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setUrl(await work());
      haptics.success();
      onChanged?.();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      setError(failure instanceof Error && failure.message ? failure.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      haptics.selection();
    } catch {
      setError("Couldn't copy. Use Send instead.");
    }
  };

  const isPublic = typeof url === "string" && url !== "unknown";
  return (
    <section className="m-share-public" aria-label="Public link">
      <h3 className="m-group-heading">General access</h3>
      <div className="m-group">
        <div className="m-share-public-row">
          <span className={`m-share-public-icon${isPublic ? " is-public" : ""}`} aria-hidden="true">
            {isPublic
              ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>
              : <svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.2" /><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" /></svg>}
          </span>
          <span className="m-share-person-text">
            <span className="m-share-person-name">{url === undefined ? "Checking…" : url === "unknown" ? "Couldn't check" : isPublic ? "Public: anyone with the link" : "Private"}</span>
            <span className="m-share-person-email">{url === "unknown" ? "It may be public or private." : isPublic ? "Anyone with the link can read it, no account needed." : "Only you and the people below can open it."}</span>
          </span>
        </div>
        {isPublic ? (
          <>
            <p className="m-share-public-url m-selectable">{url}</p>
            <div className="m-share-public-actions">
              <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
              <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => void shareLink(title, url)}>Send</button>
              <button type="button" className="m-button m-button-small m-button-destructive" disabled={busy} onClick={() => {
                if (!window.confirm("Turn off the public link? Anyone holding it can no longer open this document.")) return;
                void change(async () => { await api.revoke(); return null; });
              }}>{busy ? "Turning off…" : "Make private"}</button>
            </div>
          </>
        ) : url === "unknown" ? (
          <div className="m-share-public-actions">
            <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </div>
        ) : url === null ? (
          <div className="m-share-public-actions">
            <button type="button" className="m-button m-button-small m-button-secondary" disabled={busy} onClick={() => {
              if (!window.confirm("Make this document public? Anyone with the link will be able to read it without signing in.")) return;
              void change(() => api.create());
            }}>{busy ? "Making public…" : "Make public"}</button>
          </div>
        ) : null}
      </div>
      {error ? <p className="m-form-error" role="alert">{error}</p> : null}
    </section>
  );
}

function RolePicker({ value, onChange, label, disabled = false }: { value: ShareRole; onChange: (role: ShareRole) => void; label: string; disabled?: boolean }) {
  return (
    <select className="m-select" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as ShareRole)}>
      <option value="viewer">Can view</option>
      <option value="editor">Can edit</option>
    </select>
  );
}
