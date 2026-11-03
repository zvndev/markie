// Sharing and version history for Word, RTF and OpenDocument files, which
// live in the server's snapshot store (/api/document-platform) rather than
// beside Markdown. The same calls the desktop's cloud document dialog makes
// (src/components/document-cloud-dialog.tsx), laid out as the web app's
// dialogs. Access goes to existing verified accounts only, and a link is a
// read-only download that expires in a day.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { platformClient } from "./cloud";
import type { CloudRole } from "./cloud";

const BUTTON = "rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-accent disabled:opacity-40";

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-label={title} className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-auto rounded-xl border border-border bg-surface p-5 text-foreground">
      <header className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <button type="button" className={BUTTON} onClick={onClose}>Close</button>
      </header>
      {children}
    </section>
  </div>;
}

const message = (error: unknown) => error instanceof Error ? error.message : "That didn't work. Try again.";

export function PlatformShareDialog({ docId, name, role, onClose }: { docId: string; name: string; role: CloudRole; onClose: () => void }) {
  const owner = role === "owner";
  const [members, setMembers] = useState<{ userId: string; email?: string; role: string }[]>([]);
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"viewer" | "editor">("viewer");
  const [link, setLink] = useState<{ url: string; id: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }, []);
  const load = useCallback(() => run(async () => {
    const result = await platformClient().call(`/documents/${docId}/members`);
    setMembers(Array.isArray(result.members) ? result.members as typeof members : []);
  }), [docId, run]);
  useEffect(() => { if (owner) void load(); }, [load, owner]);

  return <Dialog title={`Share ${name}`} onClose={onClose}>
    {!owner ? <p className="text-[12.5px] text-muted">Only the owner of this document can change who has access.</p> : <>
      <p className="text-[12px] text-muted">Give a Markie account access to this file. It must already be a verified account; no invitation email is sent.</p>
      <div className="flex flex-wrap gap-2">
        <input type="email" aria-label="Email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px]" />
        <select aria-label="Access" value={memberRole} onChange={(event) => setMemberRole(event.target.value as "viewer" | "editor")} className="rounded-md border border-border bg-background px-2 text-[12px]">
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </select>
        <button type="button" className={BUTTON} disabled={busy || !email.trim()} onClick={() => void run(async () => {
          await platformClient().call(`/documents/${docId}/members`, "POST", { email: email.trim(), role: memberRole });
          setEmail(""); setNotice("Access added."); await load();
        })}>Add</button>
      </div>
      <ul aria-label="People with access" className="space-y-1">
        {members.length === 0 ? <li className="text-[12px] text-muted">Only you have access.</li> : members.map((member) => <li key={member.userId} className="flex items-center justify-between gap-2 text-[12.5px]">
          <span className="truncate">{member.email ?? member.userId} · {member.role === "editor" ? "can edit" : "can view"}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async () => {
            await platformClient().call(`/documents/${docId}/members/${member.userId}`, "DELETE");
            setNotice("Access removed. Copies already downloaded can't be recalled."); await load();
          })}>Remove</button>
        </li>)}
      </ul>
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-[12px] text-muted">A link lets anyone who has it download a read-only copy for 24 hours.</p>
        {link ? <>
          <input readOnly aria-label="Download link" value={link.url} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11.5px]" />
          <div className="flex gap-2">
            <button type="button" className={BUTTON} onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setNotice("Link copied."))}>Copy link</button>
            {link.id ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async () => {
              await platformClient().call(`/documents/${docId}/links/${link.id}`, "DELETE");
              setLink(null); setNotice("Link turned off.");
            })}>Turn off link</button> : null}
          </div>
        </> : <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async () => {
          const result = await platformClient().call(`/documents/${docId}/links`, "POST", { expiresInSeconds: 86400 });
          const value = result.link as { token?: string; id?: string } | undefined;
          if (!value?.token || !/^[A-Za-z0-9_-]{20,128}$/.test(value.token)) throw new Error("The server didn't return a usable link.");
          setLink({ url: `${window.location.origin}/api/document-platform/links/${value.token}/download`, id: value.id ?? null });
        })}>Create a 24-hour download link</button>}
      </div>
    </>}
    {busy ? <p role="status" className="text-[12px] text-muted">Working…</p> : notice ? <p role="status" className="text-[12px] text-muted">{notice}</p> : null}
    {error ? <p role="alert" className="text-[12px] text-[var(--status-red)]">{error}</p> : null}
  </Dialog>;
}

interface HistoryRow { version: number; updatedAt: number; byteLength: number; name: string }

export function PlatformHistoryDialog({ docId, name, current, onClose, onOpenCopy }: {
  docId: string; name: string; current: number; onClose: () => void; onOpenCopy: (bytes: Uint8Array) => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    platformClient().call(`/documents/${docId}/history`).then((result) => {
      if (!live) return;
      const list = Array.isArray(result.history) ? result.history as HistoryRow[] : [];
      setRows(list.filter((row) => typeof row.version === "number"));
    }, (failure: unknown) => { if (live) setError(message(failure)); });
    return () => { live = false; };
  }, [docId]);
  return <Dialog title={`Version history · ${name}`} onClose={onClose}>
    <p className="text-[12px] text-muted">Bringing back an older version puts it in the editor as unsaved changes. Nothing is overwritten until you save.</p>
    {error ? <p role="alert" className="text-[12px]">{error}</p> : !rows ? <p role="status" className="text-[12px] text-muted">Loading versions…</p> : <ul className="space-y-1">
      {rows.map((row) => <li key={row.version} className="flex items-center justify-between gap-2 text-[12.5px]">
        <span>Version {row.version}{row.version === current ? " (current)" : ""} · {new Date(row.updatedAt).toLocaleString()}</span>
        {row.version !== current ? <button type="button" className={BUTTON} onClick={() => void (async () => {
          try {
            const client = platformClient();
            const result = await client.call(`/documents/${docId}/history/${row.version}`);
            onOpenCopy((await client.decode(result.document)).bytes);
          } catch (failure) { setError(message(failure)); }
        })()}>Bring back</button> : null}
      </li>)}
    </ul>}
  </Dialog>;
}
