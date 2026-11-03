// Starting a document on the phone. The first step is the desktop's own
// centered chooser (src/components/new-document-modal.tsx) with every format
// it offers; the second is a name. A text kind isn't created on the server
// until its first save, so backing out leaves no empty document. Word, Rich
// Text and OpenDocument are files of their own format, created blank on the
// document platform when Create is tapped, then opened to write in.
import { useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { NewDocumentModal } from "@/components/new-document-modal";
import { formatFromName, newDocName, newDocType, type DocFormat, type NewDocType } from "../lib/docs";
import { decodeIncomingFile, IncomingFileError, type IncomingFile } from "../lib/incoming-file";
import { haptics } from "../lib/native";
import { ApiError, type ApiClient } from "../lib/api";
import { Screen } from "../components/screen";
import { ChevronRight, InboxIcon } from "../components/icons";

// What the Files picker offers: the text kinds, and the documents Markie turns into text.
const OPENABLE = ".md,.markdown,.mdx,.wd,.txt,.text,.log,.csv,.tsv,.json,.yaml,.yml,.xml,.toml,.ini,.docx,.rtf,.odt,.html,.htm,text/*";

/** The desktop's chooser, over whatever screen asked for it, with the phone's own "Open a file" under the formats. */
export function NewDocChooser({ onChoose, onClose, onOpenFile }: {
  onChoose: (type: NewDocType) => void;
  onClose: () => void;
  onOpenFile: (file: IncomingFile) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const picked = async (list: FileList | null) => {
    const chosen = list?.[0];
    if (picker.current) picker.current.value = "";
    if (!chosen) return;
    setOpening(true);
    setOpenError(null);
    try {
      onOpenFile(await decodeIncomingFile(chosen.name, new Uint8Array(await chosen.arrayBuffer())));
    } catch (error) {
      setOpenError(error instanceof IncomingFileError ? error.message : "Markie couldn't open that file.");
      setOpening(false);
    }
  };

  return (
    <div className="m-chooser">
      <NewDocumentModal
        onClose={onClose}
        onCreate={(format) => { haptics.tap(); onChoose(newDocType(format)); }}
        footer={
          <div className="m-chooser-footer">
            <h3 className="mb-2.5 mt-6 text-[13px] font-semibold text-foreground">From your phone</h3>
            <button type="button" className="m-chooser-open" onClick={() => picker.current?.click()} disabled={opening}>
              <InboxIcon size={20} />
              <span>{opening ? "Opening…" : "Open a file from your phone"}</span>
              <ChevronRight size={16} className="m-row-chevron" />
            </button>
            {openError ? <p className="m-form-error" role="alert">{openError}</p> : null}
            <input ref={picker} type="file" accept={OPENABLE} hidden onChange={(event) => void picked(event.target.files)} />
          </div>
        }
      />
    </div>
  );
}

interface NewDocProps {
  api: ApiClient;
  type: NewDocType;
  onCancel: () => void;
  /** A text kind: open the editor on a draft that isn't saved yet. */
  onStart: (draft: { name: string; format: DocFormat; content: string }) => void;
  /** A Word, RTF or OpenDocument file, made blank on the server: open it to write. */
  onCreated: (doc: { id: string; name: string }) => void;
  onUnauthorized: () => void;
}

export function NewDocScreen({ api, type, onCancel, onStart, onCreated, onUnauthorized }: NewDocProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = newDocName(typed, type);
  const platform = type.store === "platform";

  const start = async () => {
    if (busy) return;
    const title = name.replace(/\.[^.]*$/, "");
    haptics.tap();
    if (!platform) {
      onStart({ name, format: formatFromName(name), content: type.starter(title) });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = await blankFile(type.id);
      const snapshot = await api.platform().upload({ name, bytes });
      haptics.success();
      onCreated({ id: snapshot.id, name: snapshot.name });
    } catch (failure) {
      const status = failure instanceof ApiError ? failure.status : (failure as { status?: unknown } | null)?.status;
      if (status === 401) { onUnauthorized(); return; }
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't create the document. Try again.");
      setBusy(false);
    }
  };

  return (
    <Screen
      title={`New ${type.label}`}
      leading={<button type="button" className="m-nav-text" onClick={onCancel} disabled={busy}>Cancel</button>}
      actions={
        <button type="button" className="m-nav-text m-nav-text-strong" onClick={() => void start()} disabled={busy}>
          {busy ? <span className="m-spinner m-spinner-small" aria-hidden="true" /> : null}
          {platform ? (busy ? "Creating" : "Create") : "Next"}
        </button>
      }
      className="m-new-doc"
    >
      <form className="m-new-doc-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <div className="m-new-doc-kind">
          <DocumentFormatMark format={type.id} size="md" />
          <span className="m-type-text">
            <span className="m-type-label">{type.label} <span className="m-type-ext">{type.extension}</span></span>
            <span className="m-type-hint">{type.hint}</span>
          </span>
        </div>
        <label className="m-field">
          <span className="m-field-label">Name</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Untitled"
            autoFocus
            enterKeyHint={platform ? "done" : "next"}
            autoCapitalize="sentences"
            aria-describedby="m-new-doc-file"
          />
          <span id="m-new-doc-file" className="m-field-hint">Saved to Markie Cloud as <strong>{name}</strong></span>
        </label>
        {error ? <p className="m-form-error" role="alert">{error}</p> : null}
        <p className="m-group-footer">
          {platform
            ? `A ${type.label} file stays a ${type.label} file. It opens in Markie on your computer as one.`
            : "Type your own extension in the name for any other kind of text file. It opens on your computer the moment it syncs."}
        </p>
      </form>
    </Screen>
  );
}

/** A blank file of the format, written by the desktop's own writers. */
async function blankFile(format: string): Promise<Uint8Array> {
  if (format === "docx") {
    const { createDocx, exportDocx } = await import("@/lib/office/docx");
    return exportDocx(await createDocx(""));
  }
  if (format === "rtf" || format === "odt") {
    const { createRichDocument, exportRichDocument } = await import("@/lib/office/rich-document");
    return exportRichDocument(await createRichDocument(format, ""));
  }
  throw new Error("That kind of document is made as text.");
}
