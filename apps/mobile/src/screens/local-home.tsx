// "On this phone": the files and folders the person let Markie use. It works
// with nobody signed in. Opening a file here edits that file where it is;
// nothing is copied into the app and nothing is sent anywhere.
import { useCallback, useEffect, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { formatFromName, markFormat } from "../lib/docs";
import { haptics } from "../lib/native";
import { LocalFileError, type LocalFiles, type LocalGrant } from "../lib/local-files";
import { displayName } from "../lib/recent";
import { Screen } from "../components/screen";
import { AlertIcon, ChevronRight, DocIcon, FolderIcon, PhoneIcon } from "../components/icons";

interface LocalHomeProps {
  files: LocalFiles;
  back: { label: string; onBack: () => void };
  /** The screen is the one showing: it reads the list again, so a file opened a moment ago is first. */
  active: boolean;
  onOpenFile: (grant: LocalGrant) => Promise<void>;
  onOpenFolder: (grant: LocalGrant) => void;
}

export function LocalHomeScreen({ files, back, active, onOpenFile, onOpenFolder }: LocalHomeProps) {
  const [grants, setGrants] = useState<LocalGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGrants((await files.grants()).filter((grant) => grant.persisted));
    } catch {
      setGrants((current) => current ?? []);
    }
  }, [files]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof LocalFileError ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
      void load();
    }
  };

  const pickFile = () => run("file", async () => {
    haptics.tap();
    const grant = await files.pickDocument();
    if (grant) await onOpenFile(grant);
  });
  const pickFolder = () => run("folder", async () => {
    haptics.tap();
    const grant = await files.pickFolder();
    if (grant) onOpenFolder(grant);
  });
  /** A folder Markie lost: the person picks it again, and the old entry goes. */
  const pickAgain = (old: LocalGrant) => run(old.id, async () => {
    const grant = await files.pickFolder();
    if (!grant) return;
    if (grant.id !== old.id) await files.forget(old.id);
    onOpenFolder(grant);
  });
  const remove = (grant: LocalGrant) => run(grant.id, () => files.forget(grant.id));

  const folders = (grants ?? []).filter((grant) => grant.kind === "folder");
  const recent = (grants ?? []).filter((grant) => grant.kind === "file");

  return (
    <Screen title="On this phone" largeTitle back={back} className="m-local-home">
      <div className="m-local-actions">
        <button type="button" className="m-button m-button-primary" onClick={() => void pickFile()} disabled={!!busy}>
          <DocIcon size={19} />{busy === "file" ? "Opening…" : "Open a file"}
        </button>
        <button type="button" className="m-button m-button-secondary" onClick={() => void pickFolder()} disabled={!!busy}>
          <FolderIcon size={19} />{busy === "folder" ? "Opening…" : "Add a folder"}
        </button>
      </div>
      {error ? <p className="m-inline-error" role="alert">{error}</p> : null}

      {grants && grants.length === 0 ? (
        <div className="m-empty m-empty-compact">
          <PhoneIcon size={30} />
          <h2>Nothing here yet</h2>
          <p>Open a Markdown or text file from this phone, or add a folder of notes. Markie saves your changes back to the same file.</p>
        </div>
      ) : null}

      {folders.length > 0 ? (
        <section className="m-list-section" aria-label="Folders">
          <h2 className="m-list-heading">Folders</h2>
          <ul className="m-list">
            {folders.map((grant) => (
              <li key={grant.id}>
                {grant.reachable ? (
                  <button type="button" className="m-row" onClick={() => onOpenFolder(grant)} disabled={!!busy}>
                    <span className="m-local-folder-mark"><FolderIcon size={22} /></span>
                    <span className="m-row-main"><span className="m-row-title">{grant.name}</span></span>
                    <ChevronRight size={16} className="m-row-chevron" />
                  </button>
                ) : (
                  <LostRow name={grant.name} what="folder" busy={busy === grant.id} onAgain={() => void pickAgain(grant)} onRemove={() => void remove(grant)} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="m-list-section" aria-label="Files">
          <h2 className="m-list-heading">Files</h2>
          <ul className="m-list">
            {recent.map((grant) => (
              <li key={grant.id}>
                {grant.reachable ? (
                  <button type="button" className="m-row" onClick={() => void run(grant.id, () => onOpenFile(grant))} disabled={!!busy}>
                    <DocumentFormatMark format={markFormat({ name: grant.name, format: formatFromName(grant.name) })} size="sm" />
                    <span className="m-row-main">
                      <span className="m-row-title">{displayName(grant.name)}</span>
                      <span className="m-row-meta">{grant.name}</span>
                    </span>
                    <ChevronRight size={16} className="m-row-chevron" />
                  </button>
                ) : (
                  <LostRow name={grant.name} what="file" busy={busy === grant.id} onRemove={() => void remove(grant)} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="m-group-footer m-local-footnote">
        These files stay on this phone. Markie reads and saves them where they are, and sends them nowhere. No account is needed.
      </p>
    </Screen>
  );
}

/** A file or folder the system no longer lets Markie open: say so, and offer the two ways out. */
export function LostRow({ name, what, busy, onAgain, onRemove }: { name: string; what: "file" | "folder"; busy: boolean; onAgain?: () => void; onRemove: () => void }) {
  return (
    <div className="m-row m-local-lost" role="group" aria-label={name}>
      <span className="m-local-folder-mark is-lost"><AlertIcon size={20} /></span>
      <span className="m-row-main">
        <span className="m-row-title">{name}</span>
        <span className="m-local-lost-note">Markie can't reach this {what} any more.</span>
        <span className="m-local-lost-actions">
          {onAgain ? <button type="button" className="m-link-button" onClick={onAgain} disabled={busy}>Choose it again</button> : null}
          <button type="button" className="m-link-button" onClick={onRemove} disabled={busy}>Remove</button>
        </span>
      </span>
    </div>
  );
}
