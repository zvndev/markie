// One folder the person granted, or a folder inside it: its subfolders and
// the documents Markie can open. The grant is checked every time the folder
// is read, so one the system took back says so plainly instead of failing.
import { useCallback, useEffect, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { formatFromName, kindFromName } from "../lib/docs";
import { LocalFileError, type LocalEntry, type LocalFiles, type LocalGrant } from "../lib/local-files";
import { displayName } from "../lib/recent";
import { Screen } from "../components/screen";
import { AlertIcon, ChevronRight, FolderIcon } from "../components/icons";

interface LocalFolderProps {
  files: LocalFiles;
  grant: LocalGrant;
  /** Null for the granted folder itself. */
  entry: string | null;
  name: string;
  back: { label: string; onBack: () => void };
  active: boolean;
  onOpenFolder: (entry: LocalEntry) => void;
  onOpenFile: (entry: LocalEntry) => Promise<void>;
  /** The person picked the folder again after Markie lost it. */
  onGrantedAgain: (grant: LocalGrant) => void;
  onRemoved: () => void;
}

type State = { status: "loading" } | { status: "ready"; entries: LocalEntry[] } | { status: "lost" } | { status: "error"; message: string };

export function LocalFolderScreen({ files, grant, entry, name, back, active, onOpenFolder, onOpenFile, onGrantedAgain, onRemoved }: LocalFolderProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", entries: await files.list(grant.id, entry) });
    } catch (failure) {
      if (failure instanceof LocalFileError && (failure.code === "unreachable" || failure.code === "missing")) setState({ status: "lost" });
      else setState({ status: "error", message: failure instanceof Error ? failure.message : "Markie couldn't read that folder." });
    }
  }, [files, grant.id, entry]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const open = async (item: LocalEntry) => {
    if (busy) return;
    if (item.folder) { onOpenFolder(item); return; }
    setBusy(true);
    setError(null);
    try {
      await onOpenFile(item);
    } catch (failure) {
      setError(failure instanceof LocalFileError ? failure.message : "Markie couldn't open that file.");
    } finally {
      setBusy(false);
    }
  };

  const pickAgain = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const again = await files.pickFolder();
      if (!again) return;
      if (again.id !== grant.id) await files.forget(grant.id);
      onGrantedAgain(again);
    } catch (failure) {
      setError(failure instanceof LocalFileError ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    await files.forget(grant.id).catch(() => undefined);
    onRemoved();
  };

  const entries = state.status === "ready" ? state.entries : [];
  return (
    <Screen title={name} largeTitle back={back} onRefresh={state.status === "lost" ? undefined : load} className="m-local-folder">
      {error ? <p className="m-inline-error" role="alert">{error}</p> : null}
      {state.status === "lost" ? (
        <div className="m-empty" role="alert" data-local-lost>
          <AlertIcon size={30} />
          <h2>Markie can't reach this folder any more</h2>
          <p>It was moved or deleted, or this phone took the permission back. Your files are not affected.</p>
          <button type="button" className="m-button m-button-primary" onClick={() => void pickAgain()} disabled={busy}>Choose it again</button>
          <button type="button" className="m-button m-button-secondary" onClick={() => void remove()} disabled={busy}>Remove from Markie</button>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="m-empty" role="alert">
          <AlertIcon size={30} />
          <h2>Couldn't read this folder</h2>
          <p>{state.message}</p>
          <button type="button" className="m-button m-button-secondary" onClick={() => { setState({ status: "loading" }); void load(); }}>Try again</button>
        </div>
      ) : null}
      {state.status === "ready" && entries.length === 0 ? (
        <div className="m-empty m-empty-compact">
          <h2>No documents here</h2>
          <p>Markdown and text files in this folder show up here.</p>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <ul className="m-list m-local-list">
          {entries.map((item) => (
            <li key={item.id}>
              <button type="button" className="m-row" onClick={() => void open(item)} disabled={busy}>
                {item.folder
                  ? <span className="m-local-folder-mark"><FolderIcon size={22} /></span>
                  : <DocumentFormatMark format={kindFromName(item.name, formatFromName(item.name))} size="sm" />}
                <span className="m-row-main">
                  <span className="m-row-title">{item.folder ? item.name : displayName(item.name)}</span>
                  {item.folder ? null : <span className="m-row-meta">{item.name}</span>}
                </span>
                <ChevronRight size={16} className="m-row-chevron" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Screen>
  );
}
