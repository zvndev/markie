// A file from the document platform: Word, Rich Text, OpenDocument, or a
// text file the desktop stored there as a cloud copy. It is read and saved as
// its own format through the desktop's own client (src/lib/document-cloud.ts)
// and drawn by the desktop's own Word editor
// (src/components/documents/word-document-editor.tsx), so a page here looks
// like the page there. A save is a new version of the file's bytes, refused
// when someone saved a newer one first.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument, type DecodedTextDocument } from "@/lib/document-formats";
import type { CloudSnapshot } from "@/lib/document-cloud";
import type { DocxDocument } from "@/lib/office/docx-types";
import type { RichDocument } from "@/lib/office/rich-text-types";
import { ApiError, type ApiClient } from "../lib/api";
import { haptics, openExternal } from "../lib/native";
import { kindLabel } from "../lib/docs";
import { platformPeople } from "../lib/share-people";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { DarkmownView } from "../components/darkmown-view";
import { ShareSheet } from "../components/share-sheet";
import { AlertIcon, PencilIcon, UserPlusIcon } from "../components/icons";

const WordEditor = lazy(() => import("@/components/documents/word-document-editor").then((module) => ({ default: module.WordDocumentEditor })));

type Body =
  | { kind: "docx"; document: DocxDocument }
  | { kind: "rich"; document: RichDocument }
  | { kind: "text"; text: string; metadata: DecodedTextDocument }
  | { kind: "binary" };

type State =
  | { status: "loading" }
  | { status: "ready"; snapshot: CloudSnapshot; body: Body }
  | { status: "error"; message: string };

interface OfficeProps {
  api: ApiClient;
  id: string;
  initialName?: string;
  backLabel: string;
  tone: Tone;
  me: { email: string; name: string };
  /** Open straight into editing: a document just made on the phone. */
  startEditing?: boolean;
  onBack: () => void;
  onUnauthorized: () => void;
  onChanged: () => void;
}

async function bodyFor(name: string, bytes: Uint8Array): Promise<Body> {
  const format = classifyDocumentFormat(name);
  if (format.kind === "docx") {
    const { openDocx } = await import("@/lib/office/docx");
    return { kind: "docx", document: await openDocx(bytes) };
  }
  if (format.kind === "rtf" || format.kind === "odt") {
    const { openRichDocument } = await import("@/lib/office/rich-document");
    return { kind: "rich", document: await openRichDocument(format.kind, bytes) };
  }
  if (format.representation === "text") {
    const metadata = decodeTextDocument(bytes);
    return { kind: "text", text: metadata.text, metadata };
  }
  return { kind: "binary" };
}

async function bytesFor(body: Body): Promise<Uint8Array | null> {
  if (body.kind === "docx") return (await import("@/lib/office/docx")).exportDocx(body.document);
  if (body.kind === "rich") return (await import("@/lib/office/rich-document")).exportRichDocument(body.document);
  if (body.kind === "text") return encodeTextDocument(body.text, body.metadata);
  return null;
}

export function OfficeScreen({ api, id, initialName, backLabel, tone, me, startEditing = false, onBack, onUnauthorized, onChanged }: OfficeProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Body | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const run = useRef(0);

  // DocumentCloudClient's errors carry the status the way ApiError does.
  const failed = useCallback((failure: unknown, fallback: string): string => {
    const status = failure instanceof ApiError ? failure.status : (failure as { status?: unknown } | null)?.status;
    if (status === 401) onUnauthorized();
    return failure instanceof Error && failure.message ? failure.message : fallback;
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    const current = ++run.current;
    try {
      const client = api.platform();
      const response = await client.call(`/documents/${id}`);
      const decoded = await client.decode(response.document);
      if (decoded.snapshot.id !== id) throw new Error("The server sent a different document.");
      const body = await bodyFor(decoded.snapshot.name, decoded.bytes);
      if (current !== run.current) return;
      setState({ status: "ready", snapshot: decoded.snapshot, body });
      setDraft(null);
      setEpoch((value) => value + 1);
      if (startEditing && body.kind !== "binary" && decoded.snapshot.role !== "viewer") setEditing(true);
    } catch (failure) {
      if (current !== run.current) return;
      setState({ status: "error", message: failed(failure, "Couldn't open this document.") });
    }
  }, [api, id, failed, startEditing]);
  useEffect(() => { void load(); }, [load]);

  const doc = state.status === "ready" ? state : null;
  const role = doc?.snapshot.role ?? null;
  const canEdit = !!doc && role !== "viewer" && doc.body.kind !== "binary" && !(doc.body.kind === "text" && doc.body.metadata.newline === "mixed");
  const shown = editing && draft ? draft : doc?.body ?? null;
  const dirty = editing && draft !== null;

  const cancelEdit = () => {
    if (dirty && !window.confirm("Discard your changes? They haven't been saved.")) return;
    setEditing(false);
    setDraft(null);
    setError(null);
    setEpoch((value) => value + 1);
  };

  const saveEdit = async () => {
    if (!doc || !draft) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    try {
      const bytes = await bytesFor(draft);
      if (!bytes) throw new Error("This format can't be saved from a phone.");
      const snapshot = await api.platform().upload({ name: doc.snapshot.name, bytes }, { id: doc.snapshot.id, version: doc.snapshot.version });
      haptics.success();
      setState({ status: "ready", snapshot, body: draft });
      setDraft(null);
      setEditing(false);
      onChanged();
    } catch (failure) {
      const status = (failure as { status?: unknown })?.status;
      setError(status === 409 ? "Someone saved a newer version while you were editing. Your changes are still here: copy what you need, then cancel to read theirs." : failed(failure, "Couldn't save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const name = doc?.snapshot.name ?? initialName ?? "Document";
  const kind = classifyDocumentFormat(name).kind;
  const title = name.replace(/\.(docx|rtf|odt|doc)$/i, "") || name;

  const actions = doc ? editing ? (
    <button type="button" className="m-nav-text m-nav-text-strong" onClick={() => void saveEdit()} disabled={saving || !dirty}>
      {saving ? <span className="m-spinner m-spinner-small" aria-hidden="true" /> : null}{saving ? "Saving" : "Save"}
    </button>
  ) : (
    <>
      {canEdit ? <button type="button" className="m-nav-icon" aria-label="Edit" onClick={() => { haptics.tap(); setEditing(true); }}><PencilIcon size={22} /></button> : null}
      {role === "owner" ? <button type="button" className="m-nav-icon" aria-label="Share" onClick={() => setSharing(true)}><UserPlusIcon size={23} /></button> : null}
    </>
  ) : null;

  return (
    <Screen
      title={title}
      back={editing ? undefined : { label: backLabel, onBack }}
      leading={editing ? <button type="button" className="m-nav-text" onClick={cancelEdit} disabled={saving}>Cancel</button> : undefined}
      actions={actions}
      fill={!!shown && (shown.kind === "docx" || shown.kind === "rich" || (editing && shown.kind === "text"))}
      className="m-office"
    >
      {state.status === "loading" ? <div className="m-editor-wait" role="status"><span className="m-spinner" aria-hidden="true" />Opening…</div> : null}
      {state.status === "error" ? (
        <div className="m-empty" role="alert">
          <AlertIcon size={30} />
          <h2>Couldn't open this document</h2>
          <p>{state.message}</p>
          <button type="button" className="m-button m-button-secondary" onClick={() => { setState({ status: "loading" }); void load(); }}>Try again</button>
        </div>
      ) : null}
      {doc && shown ? (
        <>
          {!editing ? (
            <div className="m-doc-meta">
              <DocumentFormatMark format={kind === "unsupported" ? "other" : kind} size="sm" />
              <div className="m-doc-meta-text">
                <span className="m-visually-hidden">{name}</span>
                <span className="m-doc-meta-line">
                  <span>{kindLabel({ kind, format: "text" })}</span>
                  {role === "viewer" ? <span>View only</span> : role === "editor" ? <span>Shared with you</span> : null}
                  <span>Version {doc.snapshot.version}</span>
                </span>
              </div>
            </div>
          ) : null}
          {error ? <p className="m-editor-error" role="alert">{error}</p> : null}
          {shown.kind === "docx" || shown.kind === "rich" ? (
            <div className="m-office-page" data-tone={tone}>
              <Suspense fallback={<div className="m-editor-wait" role="status"><span className="m-spinner" aria-hidden="true" />Opening the page…</div>}>
                <WordEditor
                  key={epoch}
                  document={shown.document as RichDocument}
                  readOnly={!editing || saving}
                  onChange={(next: RichDocument) => {
                    if (!editing || saving) return;
                    setDraft(next.format === "docx" ? { kind: "docx", document: next as DocxDocument } : { kind: "rich", document: next });
                  }}
                />
              </Suspense>
            </div>
          ) : null}
          {shown.kind === "text" ? (
            editing ? (
              <textarea
                className="m-editor-text is-code"
                value={shown.text.replace(/\r\n?/g, "\n")}
                aria-label={`Text of ${title}`}
                onChange={(event) => {
                  const text = event.target.value;
                  const newline = shown.metadata.newline;
                  setDraft({ ...shown, text: newline === "crlf" ? text.replace(/\n/g, "\r\n") : newline === "cr" ? text.replace(/\n/g, "\r") : text });
                }}
              />
            ) : kind === "markdown" ? (
              <MarkdownView content={shown.text} onLink={(href) => { if (href && /^https?:/i.test(href)) void openExternal(href); }} />
            ) : kind === "darkmown" ? (
              <DarkmownView docKey={`p:${id}`} source={shown.text} tone={tone} />
            ) : (
              <pre className="m-text-doc">{shown.text}</pre>
            )
          ) : null}
          {shown.kind === "binary" ? (
            <div className="m-empty">
              <AlertIcon size={30} />
              <h2>Open this one on your computer</h2>
              <p>Older Word files (.doc) open in Markie on your computer. Save it there as .docx to read it here.</p>
            </div>
          ) : null}
        </>
      ) : null}
      {sharing && doc ? (
        <ShareSheet
          title={name}
          people={platformPeople(api, id)}
          canManage={role === "owner"}
          me={me}
          link={null}
          onClose={() => setSharing(false)}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </Screen>
  );
}
