// A file from this phone, shown to read. It needs no account. A text file
// opened in place has Edit, which saves back to the same file. A converted
// copy (Word, RTF, OpenDocument, HTML) or a copy another app handed over has
// nothing to save back to, and says so.
import { useCallback, useState, type ReactNode } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { markFormat, type DocFormat } from "../lib/docs";
import { classifyDocumentLink } from "../lib/deep-links";
import { openExternal, openSystemUrl } from "../lib/native";
import { displayName } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { CsvTable } from "@/components/csv-table/csv-table";
import { isCsvName } from "@/lib/csv-table";
import { DarkmownView } from "../components/darkmown-view";
import { PencilIcon, PhoneIcon } from "../components/icons";

// A web address in a CSV cell opens outside the app, as a link in a document does.
const openCsvLink = (url: string) => { void openExternal(url).catch(() => undefined); };

interface LocalDocProps {
  docKey: string;
  name: string;
  format: DocFormat;
  content: string;
  /** Where this text lives and what saving does, in one plain sentence. */
  note: string;
  tone: Tone;
  back: { label: string; onBack: () => void };
  /** Null when there is no file to save back to. */
  onEdit: (() => void) | null;
  /** Signed in: keep a copy in Markie Cloud. It resolves once the copy is open. */
  cloud: { where: string; save: () => Promise<void> } | null;
  /** Signed out, and nothing to save back to: the one way to keep it. */
  onSignIn: (() => void) | null;
}

export function LocalDocScreen({ docKey, name, format, content, note, tone, back, onEdit, cloud, onSignIn }: LocalDocProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveCopy = useCallback(async () => {
    if (!cloud || saving) return;
    setSaving(true);
    setError(null);
    try {
      await cloud.save();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't save the copy. Try again.");
      setSaving(false);
    }
  }, [cloud, saving]);

  // Its relative links point at files beside it, which this screen does not
  // follow. Web and mail links open outside the app.
  const onLink = useCallback((href: string | null) => {
    const link = classifyDocumentLink(href, "", new Map());
    if (link.kind === "external") void openExternal(link.url);
    else if (link.kind === "system") openSystemUrl(link.url);
  }, []);

  let action: ReactNode = null;
  if (onEdit) action = <button type="button" className="m-button m-button-small m-button-primary" onClick={onEdit}>Edit</button>;
  else if (cloud) action = <button type="button" className="m-button m-button-small m-button-primary" onClick={() => void saveCopy()} disabled={saving}>{saving ? "Saving" : "Save"}</button>;
  else if (onSignIn) action = <button type="button" className="m-button m-button-small m-button-secondary" onClick={onSignIn}>Sign in</button>;

  const isWd = format === "darkmown";
  // A CSV or TSV reads as its table, which scrolls itself both ways.
  const isCsv = format === "text" && isCsvName(name);
  return (
    <Screen
      title={displayName(name)}
      back={back}
      actions={onEdit ? <button type="button" className="m-nav-icon" aria-label="Edit" onClick={onEdit}><PencilIcon size={22} /></button> : null}
      fill={isWd || isCsv}
      className="m-document m-incoming m-local-doc"
    >
      <div className="m-incoming-card">
        <DocumentFormatMark format={markFormat({ name, format })} size="sm" />
        <div className="m-incoming-text">
          <strong>{name}</strong>
          <span><PhoneIcon size={13} />{note}</span>
        </div>
        {action}
      </div>
      {onEdit && cloud ? (
        <p className="m-local-cloud">
          <button type="button" className="m-link-button" onClick={() => void saveCopy()} disabled={saving}>{saving ? "Saving a copy…" : `Save a copy to ${cloud.where}`}</button>
        </p>
      ) : null}
      {error ? <p className="m-inline-error" role="alert">{error}</p> : null}
      {format === "markdown" ? <MarkdownView content={content} onLink={onLink} /> : null}
      {format === "text" && !isCsv ? <pre className="m-text-doc">{content}</pre> : null}
      {isCsv ? <div className="m-csv-doc" data-csv-doc><CsvTable text={content} name={name} readOnly compact onOpenLink={openCsvLink} /></div> : null}
      {isWd ? <DarkmownView docKey={docKey} source={content} tone={tone} /> : null}
    </Screen>
  );
}
