import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import type { DocumentSession } from "@/lib/document-session";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
import { darkmownFrameSandbox, darkmownLinkFromMessage, projectDarkmownTheme } from "@/lib/darkmown/frame";
import type { WebFileHandle } from "@/lib/web-files";
import { editorThemeForTokens, findTheme, loadThemeStore, THEME_APPLIED_EVENT, type ThemeTokens } from "@/lib/theme";
import { TextDocumentEditor } from "./text-document-editor";

type PreviewMode = "source" | "preview" | "split";
const VIEW_COMMANDS = ["view-darkmown-source", "view-darkmown-preview", "view-darkmown-split"] as const;
interface PreviewRevision {
  epoch: string;
  source: string;
  generation: number;
  trusted: boolean;
  reset: number;
  colorScheme: "light" | "dark" | null;
  pictureBase: string | null;
}
interface PreviewResult extends PreviewRevision { srcDoc?: string; warnings?: string[]; error?: string }
/**
 * Live Docs on the desktop (super-nightly): what a .wd needs from outside its
 * sandbox to read like the document it is. Both halves end in main, which
 * checks them again (electron/darkmown-preview.js).
 */
export interface DarkmownLiveDocs {
  /** A picture scope for the document's folder, or null when it has none. */
  pictureBase(source: { handle?: WebFileHandle; markdownPath?: string }): Promise<string | null>;
  /** Open a link the user clicked in the preview. */
  openLink(href: string): void;
}
interface DarkmownDocumentEditorProps {
  session: DocumentSession;
  /** Pictures, clicked links and the CodeMirror source. Null keeps the offline preview. */
  liveDocs?: DarkmownLiveDocs | null;
  readOnly?: boolean;
  active?: boolean;
  onChange: (text: string) => void;
  onRestoreText?: (text: string) => void;
  onFlushReady: (flush: (() => string | null) | null) => void;
  onCommandsReady?: (target: DocumentCommandTarget | null) => void;
}

function sameRevision(left: PreviewRevision | null, right: PreviewRevision): boolean {
  return !!left && left.epoch === right.epoch && left.source === right.source && left.generation === right.generation && left.trusted === right.trusted && left.reset === right.reset && left.colorScheme === right.colorScheme && left.pictureBase === right.pictureBase;
}

/** Authored source is the document. Runtime state exists only in the disposable opaque frame. */
export function DarkmownDocumentEditor({ session, liveDocs = null, readOnly = false, active = true, onChange, onRestoreText, onFlushReady, onCommandsReady }: DarkmownDocumentEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<PreviewMode>("split");
  const [grant, setGrant] = useState<{ epoch: string; source: string; generation: number } | null>(null);
  const [reset, setReset] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [sourceCommands, setSourceCommands] = useState<DocumentCommandTarget | null>(null);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">(() => {
    // The applied tone is the truth (color mode, templates); the store is the fallback before first paint.
    const applied = typeof document === "undefined" ? undefined : document.documentElement.dataset.themeTone;
    if (applied === "light" || applied === "dark") return applied;
    const store = loadThemeStore();
    return editorThemeForTokens(findTheme(store, store.activeId).tokens);
  });
  const allowed = active && !readOnly;
  const trusted = allowed && grant?.epoch === session.epoch && grant.source === session.text && grant.generation === session.generation;
  const staticColorScheme = trusted ? null : previewTheme;
  const latestTheme = useRef(previewTheme); latestTheme.current = previewTheme;
  // Pictures resolve against the saved file's folder, or, for a copy Make
  // interactive has not saved yet, the Markdown file it came from. Main
  // answers with a scope for that folder, never with a path.
  const links = !!liveDocs;
  const pictureHandle = liveDocs ? session.handle : undefined;
  const pictureOrigin = liveDocs && !session.handle ? session.pictureOrigin : undefined;
  const pictureSource = pictureHandle ?? pictureOrigin ?? null;
  const [picture, setPicture] = useState<{ source: WebFileHandle | string; base: string | null } | null>(null);
  useEffect(() => {
    if (!liveDocs || (!pictureHandle && !pictureOrigin)) return;
    let live = true;
    const source = (pictureHandle ?? pictureOrigin)!;
    const settle = (base: string | null) => { if (live) setPicture({ source, base }); };
    liveDocs.pictureBase(pictureHandle ? { handle: pictureHandle } : { markdownPath: pictureOrigin }).then(settle, () => settle(null));
    return () => { live = false; };
  }, [liveDocs, pictureHandle, pictureOrigin]);
  // undefined while the scope is being asked for, so the first preview does not flash without its pictures.
  const pictureBase = !pictureSource ? null : picture?.source === pictureSource ? picture.base : undefined;
  const revision: PreviewRevision = { epoch: session.epoch, source: session.text, generation: session.generation, trusted, reset, colorScheme: staticColorScheme, pictureBase: pictureBase ?? null };
  const currentResult = sameRevision(result, revision) ? result : null;
  const canPreview = active && mode !== "source" && pictureBase !== undefined;
  const current = useRef({ allowed, mode, sourceCommands });
  current.current = { allowed, mode, sourceCommands };
  const projectPreviewTheme = useCallback(() => {
    if (trusted && currentResult?.srcDoc) projectDarkmownTheme(previewFrame.current, previewTheme);
  }, [trusted, currentResult?.srcDoc, previewTheme]);
  useEffect(() => { projectPreviewTheme(); }, [projectPreviewTheme]);

  useEffect(() => {
    const applyPreviewTheme = (event: Event) => {
      const detail = (event as CustomEvent<{ editorTheme?: "light" | "dark"; tokens?: ThemeTokens }>).detail;
      if (detail?.editorTheme) setPreviewTheme(detail.editorTheme);
      else if (detail?.tokens) setPreviewTheme(editorThemeForTokens(detail.tokens));
    };
    window.addEventListener(THEME_APPLIED_EVENT, applyPreviewTheme);
    return () => window.removeEventListener(THEME_APPLIED_EVENT, applyPreviewTheme);
  }, []);

  // Render-time revision checks remove a stale executable frame before this cleanup runs.
  useEffect(() => { setGrant(null); }, [session.epoch, session.text, session.generation, allowed]);
  useEffect(() => {
    if (!canPreview) return;
    let disposed = false;
    const controller = new AbortController();
    const base = pictureBase ?? null;
    const requested = { epoch: session.epoch, source: session.text, generation: session.generation, trusted, reset, colorScheme: staticColorScheme, pictureBase: base };
    void compileDarkmownPreview(session.text, trusted, { signal: controller.signal, colorScheme: latestTheme.current, links, pictureBase: base }).then(
      (preview) => { if (!disposed) setResult({ ...requested, ...preview }); },
      (error: unknown) => { if (!disposed) setResult({ ...requested, error: error instanceof Error ? error.message : "Darkmown could not build this preview." }); },
    );
    return () => { disposed = true; controller.abort(); };
  }, [session.epoch, session.text, session.generation, trusted, reset, canPreview, staticColorScheme, links, pictureBase]);

  // The link bridge's one message. darkmownLinkFromMessage believes it only
  // from this frame, after a real click; main checks the URL again.
  useEffect(() => {
    if (!liveDocs) return;
    const receive = (event: MessageEvent) => {
      const href = darkmownLinkFromMessage(event, previewFrame.current);
      if (href && host.current && !host.current.closest("[inert]")) liveDocs.openLink(href);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [liveDocs]);

  const registerSourceCommands = useCallback((target: DocumentCommandTarget | null) => setSourceCommands(target), []);
  const execute = useCallback((command: string) => {
    if (!host.current || host.current.closest("[inert]") || !current.current.allowed) return;
    if (VIEW_COMMANDS.includes(command as typeof VIEW_COMMANDS[number])) {
      setMode(command.slice("view-darkmown-".length) as PreviewMode);
      return;
    }
    if (command === "find" && current.current.mode === "preview") setMode("split");
    current.current.sourceCommands?.execute(command);
  }, []);
  const enabledKey = allowed ? [...VIEW_COMMANDS, ...(sourceCommands?.enabledCommands ?? [])].join("|") : "";
  useEffect(() => {
    onCommandsReady?.({ enabledCommands: enabledKey ? enabledKey.split("|") : [], execute });
    return () => onCommandsReady?.(null);
  }, [enabledKey, execute, onCommandsReady]);
  const changeSource = (text: string) => { setGrant(null); onChange(text); };
  const restoreSource = (text: string) => { setGrant(null); (onRestoreText ?? onChange)(text); };
  const revealSource = () => setMode((currentMode) => currentMode === "preview" ? "split" : currentMode);

  return <div ref={host} className="docs-darkmown-host" data-darkmown-trusted={trusted ? "true" : "false"}>
    <TextDocumentEditor session={session} readOnly={readOnly || !active} onChange={changeSource} onRestoreText={restoreSource} onFlushReady={onFlushReady} onCommandsReady={registerSourceCommands} onFindRequested={revealSource} onSourceEditRequested={revealSource} renderSource={(source) => <div className={`docs-darkmown-panes docs-darkmown-mode-${mode}`}>
      <section className="docs-darkmown-source" aria-label="Darkmown source" hidden={mode === "preview"}>{source}</section>
      {canPreview ? <section className="docs-darkmown-preview" aria-label="Darkmown preview">
        <header className="docs-darkmown-preview-header">
          <div className="docs-darkmown-preview-label"><strong>Document preview</strong><span>{trusted ? "Trusted · Edits revoke trust" : "Controls inactive"}</span></div>
          <div className="docs-darkmown-trust-actions">{trusted ? <><button type="button" disabled={!allowed} onClick={() => { if (!host.current?.closest("[inert]")) setReset((value) => value + 1); }}>Reset state</button><button type="button" onClick={() => setGrant(null)}>Revoke trust</button></> : <button type="button" className="docs-primary" disabled={!allowed} onClick={() => { if (allowed && !host.current?.closest("[inert]")) setGrant({ epoch: session.epoch, source: session.text, generation: session.generation }); }}>Trust this document</button>}</div>
        </header>
        <p className="docs-darkmown-security">{liveDocs ? "Local state only. Pictures come from this document’s folder and links open in your browser. No network, accounts or persistent storage." : "Local state only. No network, files, accounts or persistent storage."}</p>
        {currentResult?.warnings?.length ? <div className="docs-darkmown-warnings" role="status">{currentResult.warnings.join(" ")}</div> : null}
        {currentResult?.error ? <div className="docs-error" role="alert"><span>{currentResult.error}</span><button type="button" disabled={!allowed} onClick={() => setReset((value) => value + 1)}>Retry preview</button></div> : currentResult?.srcDoc ? <iframe ref={previewFrame} key={`${session.epoch}-${session.generation}-${trusted}-${reset}-${staticColorScheme ?? "runtime"}-${currentResult.pictureBase ?? "offline"}`} title="Darkmown document preview" sandbox={darkmownFrameSandbox(trusted, { links })} referrerPolicy="no-referrer" style={{ colorScheme: previewTheme }} onLoad={projectPreviewTheme} srcDoc={currentResult.srcDoc} /> : <p className="docs-loading" role="status">Building document preview…</p>}
      </section> : null}
    </div>} />
  </div>;
}
