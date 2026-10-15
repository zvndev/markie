import { useEffect, useRef, useState } from "react";
import { DocumentCloudClient, type CloudFile, type CloudSnapshot } from "@/lib/document-cloud";
import { getAuthToken, getServerURL } from "@/lib/auth-client";
import { authStore, useAuth } from "@/lib/auth-store";
import { downloadWebDocument } from "@/lib/web-files";
import { SignInForm } from "./sign-in";
import { CloudDocumentEditor, type CloudEditingState } from "./cloud-document-editor";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument } from "@/lib/document-formats";
import { exportDocx, openDocx } from "@/lib/office/docx";

interface CloudDialogProps { file: CloudFile; onClose: (message: string | null) => void; onCloseGuard?: (guard: (() => boolean) | null) => void }
const BUTTON = "px-3 py-2 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-40";
function cloudIdentity() {
  const { user, status } = authStore.getSnapshot();
  return JSON.stringify([getServerURL(), getAuthToken(), status, user?.id ?? null]);
}

/** Ordinary file sharing is opt-in; no automatic upload and no vault integration. */
export function DocumentCloudDialog({ file, onClose, onCloseGuard }: CloudDialogProps) {
  const { user, status } = useAuth();
  const [cloud, setCloud] = useState<CloudSnapshot | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [members, setMembers] = useState<{ userId: string; email?: string; role: string }[]>([]);
  const [completed, setCompleted] = useState<string | null>(null);
  const [cloudList, setCloudList] = useState<{ id: string; name: string; role: string; version: number }[] | null>(null);
  const [editing, setEditing] = useState<CloudEditingState | null>(null);
  const [editEpoch, setEditEpoch] = useState(0);
  const [cloudDirty, setCloudDirty] = useState(false);
  const [cloudSource, setCloudSource] = useState<Uint8Array | null>(null);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const identity = cloudIdentity();
  const initialIdentity = useRef(identity);
  useEffect(() => {
    const invalidate = () => { generation.current++; activeRequest.current?.abort(); };
    dialog.current?.focus();
    return invalidate;
  }, []);
  const identityMatches = () => initialIdentity.current === cloudIdentity();
  useEffect(() => {
    const clearChangedAccount = () => {
      if (initialIdentity.current === cloudIdentity()) return;
      const hadCloudContent = !!(cloud || editing || cloudList || link);
      generation.current++;
      activeRequest.current?.abort();
      setCloud(null); setCloudSource(null); setEditing(null); setCloudList(null);
      setMembers([]); setLink(null); setLinkId(null); setCloudDirty(false); setCompleted(null);
      setBusy(false); setNotice(null); setError(hadCloudContent ? "The account changed. Cloud content was cleared; reopen sharing for the new account." : null);
      initialIdentity.current = cloudIdentity();
    };
    clearChangedAccount();
    const unsubscribe = authStore.subscribe(clearChangedAccount);
    window.addEventListener("storage", clearChangedAccount);
    return () => { unsubscribe(); window.removeEventListener("storage", clearChangedAccount); };
  }, [identity, user?.id, status, cloud, editing, cloudList, link]);

  async function run(work: (client: DocumentCloudClient) => Promise<void>) {
    const ticket = ++generation.current;
    const token = getAuthToken();
    const server = getServerURL();
    const boundIdentity = cloudIdentity();
    const controller = new AbortController();
    activeRequest.current?.abort(); activeRequest.current = controller;
    const stale = () => ticket !== generation.current || boundIdentity !== cloudIdentity();
    setBusy(true); setError(null);
    try {
      if (!token || authStore.getSnapshot().status !== "in" || !authStore.getSnapshot().user) throw new Error("Sign in before sharing this document.");
      const client = new DocumentCloudClient({ baseUrl: server, token }, async (input, init) => {
        if (stale()) throw new Error("The account changed before the request was sent.");
        return fetch(input, { ...init, signal: controller.signal });
      });
      const guarded = new Proxy(client, { get(target, key) {
        const item = Reflect.get(target, key);
        if (typeof item !== "function") return item;
        return async (...args: unknown[]) => {
          if (stale()) throw new Error("The account or document changed. The action was canceled.");
          const result = await item.apply(target, args);
          if (stale()) throw new Error("The account or document changed. The result was not applied.");
          return result;
        };
      } });
      await work(guarded);
    } catch (failure) { if (ticket === generation.current) setError(failure instanceof Error ? failure.message : "Sharing failed. Your local document is unchanged."); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  async function currentCopy(): Promise<CloudFile> {
    const boundIdentity = initialIdentity.current;
    const privateCloud = !!cloud;
    if (privateCloud && !identityMatches()) throw new Error("The account changed. Cloud content cannot be exported.");
    let bytes = cloudSource ?? file.bytes;
    if (editing?.kind === "docx") bytes = await exportDocx(editing.document);
    else if (editing?.kind === "text") bytes = encodeTextDocument(editing.text, editing.metadata);
    if (privateCloud && boundIdentity !== cloudIdentity()) throw new Error("The account changed. Cloud content cannot be exported.");
    return { ...file, name: cloud?.name ?? file.name, bytes };
  }
  const publish = () => void run(async (client) => {
    const snapshot = await client.upload(await currentCopy(), cloud ? { id: cloud.id, version: cloud.version } : undefined);
    setCloud(snapshot); setCloudDirty(false); setNotice("Cloud copy saved. It is separate from your local recovery copy."); setCompleted("Cloud copy saved.");
  });
  const loadCloud = (id: string) => {
    if (cloudDirty && !window.confirm("Discard the unsaved cloud edits before opening another version?")) return;
    const expectedIdentity = cloudIdentity();
    const expectedGeneration = generation.current + 1;
    void run(async (client) => {
      const response = await client.call(`/documents/${id}`);
      const decoded = await client.decode(response.document);
      const format = classifyDocumentFormat(decoded.snapshot.name);
      const next: CloudEditingState = format.kind === "docx" ? { kind: "docx", document: await openDocx(decoded.bytes) }
        : format.representation === "text" ? (() => { const metadata = decodeTextDocument(decoded.bytes); return { kind: "text" as const, text: metadata.text, metadata }; })() : { kind: "binary" };
      if (expectedIdentity !== cloudIdentity() || expectedGeneration !== generation.current) throw new Error("The account changed. The cloud document was not opened.");
      setCloud(decoded.snapshot); setCloudSource(new Uint8Array(decoded.bytes)); setEditing(next); setCloudDirty(false); setMembers([]); setLink(null); setLinkId(null);
      setEditEpoch((epoch) => epoch + 1);
      setNotice(`Opened cloud version ${decoded.snapshot.version}. Edits are not saved until you save this version.`);
    });
  };
  const mayClose = () => !cloudDirty || window.confirm("Discard unsaved cloud edits? Download a copy first to keep them.");
  useEffect(() => {
    onCloseGuard?.(() => !cloudDirty || window.confirm("Discard unsaved cloud edits? Download a copy first to keep them."));
    return () => onCloseGuard?.(null);
  }, [cloudDirty, onCloseGuard]);
  useEffect(() => {
    if (!cloudDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [cloudDirty]);
  const invite = () => void run(async (client) => {
    if (!cloud) return;
    await client.call(`/documents/${cloud.id}/members`, "POST", { email: email.trim(), role });
    const result = await client.call(`/documents/${cloud.id}/members`);
    setMembers(Array.isArray(result.members) ? result.members as typeof members : []);
    setEmail(""); setNotice("Access added to the verified account. No invitation email was sent."); setCompleted("Document access updated.");
  });
  const createLink = () => void run(async (client) => {
    if (!cloud) return;
    const result = await client.call(`/documents/${cloud.id}/links`, "POST", { expiresInSeconds: 86400 });
    const value = result.link as { token?: string; id?: string } | undefined;
    if (!value?.token || !/^[A-Za-z0-9_-]{20,128}$/.test(value.token)) throw new Error("The server did not return a valid share link.");
    setLink(`${getServerURL()}/api/document-platform/links/${value.token}/download`);
    setLinkId(value.id ?? null); setCompleted("Read-only cloud link created.");
    setNotice("Read-only download link created, valid for 24 hours. Anyone with it can download a copy.");
  });

  return <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="document-cloud-title" onKeyDown={(event) => {
      if (event.key === "Escape" && !busy && mayClose()) { event.preventDefault(); onClose(completed); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && editing && cloud) {
        event.preventDefault();
        if (!busy && cloud.role !== "viewer" && identityMatches()) publish();
      }
    }} className={`w-full ${editing ? "max-w-5xl" : "max-w-xl"} max-h-[90vh] overflow-auto rounded-xl bg-surface text-foreground p-6 space-y-4 border border-border`}>
      <header className="flex items-start justify-between gap-4"><div><h2 id="document-cloud-title" className="text-lg font-semibold">Share {file.name}</h2><p className="text-sm text-muted mt-1">Nothing is uploaded until you choose to create a cloud copy.</p></div><button type="button" className={BUTTON} disabled={busy} onClick={() => { if (mayClose()) onClose(completed); }}>Close</button></header>
      <p className="text-xs text-muted break-all">Server: {getServerURL()}</p>
      {!identityMatches() && (cloud || cloudList || editing || link) ? <p role="alert">The account changed. Close this panel before sharing again.</p> : !user ? <SignInForm reason="share" allowGoogle={false} /> : <>
        <p className="text-sm">Signed in as {user.email}. Cloud access is independent of your local library.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || (cloud?.role === "viewer")} onClick={publish}>{cloud ? "Save this snapshot to cloud" : "Create a cloud copy"}</button><button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async (client) => { const result = await client.call("/documents"); setCloudList(Array.isArray(result.documents) ? result.documents as typeof cloudList : []); })}>Browse cloud documents</button></div>
        {cloudList ? <ul className="space-y-1 max-h-40 overflow-auto" aria-label="Accessible cloud documents">{cloudList.map((entry) => <li key={entry.id}><button type="button" className={`${BUTTON} w-full text-left`} disabled={busy} onClick={() => loadCloud(entry.id)}>{entry.name} · {entry.role} · version {entry.version}</button></li>)}</ul> : null}
        {cloud ? <div className="space-y-4 border-t border-border pt-4">
          <p className="text-xs text-muted">Cloud version {cloud.version}. Version conflicts preserve your local edits; this is not live Word co-editing.</p>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => loadCloud(cloud.id)}>Open current cloud version for editing</button>
          {editing ? <><CloudDocumentEditor key={editEpoch} value={editing} readOnly={busy || cloud.role === "viewer"} onChange={(value) => { setEditing(value); setCloudDirty(true); }} /><p className="text-xs text-muted">{cloudDirty ? "Cloud edits are not saved yet." : "No unsaved cloud edits."}</p></> : null}
          {cloud.role === "owner" ? <fieldset className="space-y-2"><legend className="text-sm font-medium">Verified account access</legend><label className="block text-sm">Email<input type="email" className="w-full mt-1 p-2 rounded-md border border-border bg-background" value={email} onChange={(event) => setEmail(event.target.value)} /></label><div className="flex gap-2">{(["viewer", "editor"] as const).map((value) => <button key={value} type="button" className={BUTTON} aria-pressed={role === value} onClick={() => setRole(value)}>{value === "viewer" ? "Can view" : "Can save versions"}</button>)}<button type="button" className={BUTTON} disabled={busy || !email.trim()} onClick={invite}>Add access</button></div></fieldset> : null}
          {members.map((member) => <div key={member.userId} className="flex justify-between gap-2 text-sm"><span>{member.email ?? member.userId} · {member.role}</span><button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async (client) => { await client.call(`/documents/${cloud.id}/members/${member.userId}`, "DELETE"); setMembers((current) => current.filter((item) => item.userId !== member.userId)); setNotice("Future access revoked. Existing downloaded copies cannot be recalled."); })}>Revoke access</button></div>)}
          {cloud.role === "owner" ? <button type="button" className={BUTTON} disabled={busy} onClick={createLink}>Create 24-hour read-only link</button> : null}
          {link ? <div className="space-y-2"><label className="block text-sm">Read-only download link<input className="w-full mt-1 p-2 rounded-md border border-border bg-background text-xs" value={link} readOnly /></label><button type="button" className={BUTTON} onClick={() => {
            if (!navigator.clipboard?.writeText) { setError("Clipboard access is unavailable. Select and copy the link above."); return; }
            void navigator.clipboard.writeText(link).then(() => setNotice("Link copied.")).catch(() => setError("Clipboard access failed. Select and copy the link above."));
          }}>Copy link</button>{linkId ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(async (client) => { await client.call(`/documents/${cloud.id}/links/${linkId}`, "DELETE"); setLink(null); setLinkId(null); setNotice("Link revoked for future downloads."); })}>Revoke link</button> : null}</div> : null}
        </div> : null}
      </>}
      <div className="border-t border-border pt-3"><button type="button" className={BUTTON} disabled={busy || (!!cloud && !identityMatches())} onClick={() => {
        const boundIdentity = cloud ? cloudIdentity() : null;
        void currentCopy().then((copy) => {
          if (boundIdentity && boundIdentity !== cloudIdentity()) throw new Error("Account changed.");
          downloadWebDocument(copy); setNotice("Download started for this snapshot. This action did not save a cloud version.");
        }).catch(() => setError("The copy could not be exported. Your edits were kept."));
      }}>{editing ? "Download edited copy" : "Download a local copy instead"}</button></div>
      {busy ? <p role="status" className="text-sm text-muted">Updating cloud access…</p> : notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
    </section>
  </div>;
}
