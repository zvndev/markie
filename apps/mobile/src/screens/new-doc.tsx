// Starting a document on the phone: a name and a kind. Nothing is created on
// the server until the first save, so backing out leaves no empty document.
import { useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { formatFromName, markFormat, newDocName, NEW_DOC_TYPES, type DocFormat } from "../lib/docs";
import { decodeIncomingFile, IncomingFileError, type IncomingFile } from "../lib/incoming-file";
import { haptics } from "../lib/native";
import { Screen } from "../components/screen";
import { CheckIcon, ChevronRight, InboxIcon } from "../components/icons";

// What the Files picker offers: the text kinds, and the documents Markie turns into text.
const OPENABLE = ".md,.markdown,.mdx,.wd,.txt,.text,.log,.csv,.tsv,.json,.yaml,.yml,.xml,.toml,.ini,.docx,.rtf,.odt,.html,.htm,text/*";

interface NewDocProps {
  onCancel: () => void;
  onStart: (draft: { name: string; format: DocFormat; content: string }) => void;
  /** A file picked from the phone (Files, iCloud Drive, Drive), opened before it is saved. */
  onOpenFile: (file: IncomingFile) => void;
}

export function NewDocScreen({ onCancel, onStart, onOpenFile }: NewDocProps) {
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

  const [typed, setTyped] = useState("");
  const [typeId, setTypeId] = useState(NEW_DOC_TYPES[0].id);
  const type = NEW_DOC_TYPES.find((item) => item.id === typeId) ?? NEW_DOC_TYPES[0];
  const name = newDocName(typed, type);

  const start = () => {
    const title = name.replace(/\.[^.]*$/, "");
    haptics.tap();
    onStart({ name, format: formatFromName(name), content: type.starter(title) });
  };

  return (
    <Screen
      title="New document"
      leading={<button type="button" className="m-nav-text" onClick={onCancel}>Cancel</button>}
      actions={<button type="button" className="m-nav-text m-nav-text-strong" onClick={start}>Next</button>}
      className="m-new-doc"
    >
      <form className="m-new-doc-form" onSubmit={(event) => { event.preventDefault(); start(); }}>
        <label className="m-field">
          <span className="m-field-label">Name</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Untitled"
            autoFocus
            enterKeyHint="next"
            autoCapitalize="sentences"
            aria-describedby="m-new-doc-file"
          />
          <span id="m-new-doc-file" className="m-field-hint">Saved to Markie Cloud as <strong>{name}</strong></span>
        </label>
        <h2 className="m-group-heading">Kind</h2>
        <div className="m-group m-type-list" role="radiogroup" aria-label="Kind of document">
          {NEW_DOC_TYPES.map((item) => {
            const selected = item.id === type.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`m-type-row${selected ? " is-selected" : ""}`}
                onClick={() => { if (!selected) { haptics.selection(); setTypeId(item.id); } }}
              >
                <DocumentFormatMark format={markFormat({ name: `x${item.extension}`, format: formatFromName(`x${item.extension}`) })} size="sm" />
                <span className="m-type-text">
                  <span className="m-type-label">{item.label} <span className="m-type-ext">{item.extension}</span></span>
                  <span className="m-type-hint">{item.hint}</span>
                </span>
                {selected ? <CheckIcon size={20} className="m-type-check" /> : null}
              </button>
            );
          })}
        </div>
        <p className="m-group-footer">Type your own extension in the name for any other kind of text file. It opens on your computer the moment it syncs.</p>
        <h2 className="m-group-heading">Or bring one in</h2>
        <div className="m-group">
          <button type="button" className="m-group-action m-open-file" onClick={() => picker.current?.click()} disabled={opening}>
            <InboxIcon size={20} />
            <span>{opening ? "Opening…" : "Open a file from your phone"}</span>
            <ChevronRight size={16} className="m-row-chevron" />
          </button>
        </div>
        {openError ? <p className="m-form-error m-open-error" role="alert">{openError}</p> : null}
        <p className="m-group-footer">Markdown, text, Darkmown, CSV and JSON open as they are. Word files become Markdown, and RTF, OpenDocument and HTML become plain text. The original isn't changed.</p>
        <input ref={picker} type="file" accept={OPENABLE} hidden onChange={(event) => void picked(event.target.files)} />
      </form>
    </Screen>
  );
}
