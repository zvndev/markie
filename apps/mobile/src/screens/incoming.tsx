// A file another app handed to Markie, shown before it is kept anywhere. It
// lives only in memory until the person saves it to Markie Cloud, where it
// becomes an ordinary document: editable here, and on the computer once the
// desktop syncs.
import { useCallback, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { ApiError, type ApiClient } from "../lib/api";
import { markFormat } from "../lib/docs";
import type { IncomingFile } from "../lib/incoming-file";
import { classifyDocumentLink, type LinkTarget } from "../lib/deep-links";
import { haptics, openExternal, openSystemUrl } from "../lib/native";
import { displayName } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { isMarkieCloud } from "../lib/server-origin";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { DarkmownView } from "../components/darkmown-view";
import { InboxIcon, PencilIcon } from "../components/icons";

interface IncomingProps {
  api: ApiClient;
  file: IncomingFile;
  fileKey: string;
  tone: Tone;
  backLabel: string;
  onBack: () => void;
  onEdit: () => void;
  onSaved: (saved: { id: string; name: string }) => void;
  onOpen: (target: LinkTarget) => void;
  onUnauthorized: () => void;
}

export function IncomingScreen({ api, file, fileKey, tone, backLabel, onBack, onEdit, onSaved, onOpen, onUnauthorized }: IncomingProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = isMarkieCloud(api.origin) ? "Markie Cloud" : "your server";

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await api.createDoc({ name: file.name, content: file.content });
      haptics.success();
      onSaved({ id: created.id, name: file.name });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      setError(failure instanceof Error ? failure.message : "Couldn't save. Try again.");
      setSaving(false);
    }
  }, [api, file, onSaved, onUnauthorized]);

  // Its relative links point at files on the sender's device, so only web,
  // mail and Markie document links go anywhere.
  const onLink = useCallback((href: string | null) => {
    const link = classifyDocumentLink(href, api.origin, new Map());
    if (link.kind === "markie") onOpen(link.target);
    else if (link.kind === "external") void openExternal(link.url);
    else if (link.kind === "system") openSystemUrl(link.url);
  }, [api.origin, onOpen]);

  const isWd = file.format === "darkmown";
  return (
    <Screen
      title={displayName(file.name)}
      back={{ label: backLabel, onBack }}
      actions={<button type="button" className="m-nav-icon" aria-label="Edit before saving" onClick={onEdit} disabled={saving}><PencilIcon size={22} /></button>}
      fill={isWd}
      className="m-document m-incoming"
    >
      <div className="m-incoming-card">
        <DocumentFormatMark format={markFormat(file)} size="sm" />
        <div className="m-incoming-text">
          <strong>{file.name}</strong>
          <span>
            <InboxIcon size={13} />
            {file.convertedFrom ? `A text copy of a ${file.convertedFrom} file. Not in ${where} yet.` : `Opened from another app. Not in ${where} yet.`}
          </span>
        </div>
        <button type="button" className="m-button m-button-small m-button-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <span className="m-spinner m-spinner-small" aria-hidden="true" /> : null}
          {saving ? "Saving" : "Save"}
        </button>
      </div>
      {error ? <p className="m-inline-error" role="alert">{error}</p> : null}
      {file.format === "markdown" ? <MarkdownView content={file.content} onLink={onLink} /> : null}
      {file.format === "text" ? <pre className="m-text-doc">{file.content}</pre> : null}
      {isWd ? <DarkmownView docKey={fileKey} source={file.content} tone={tone} /> : null}
    </Screen>
  );
}
