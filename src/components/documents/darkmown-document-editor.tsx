import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import type { DocumentSession } from "@/lib/document-session";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
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
}
interface PreviewResult extends PreviewRevision { srcDoc?: string; warnings?: string[]; error?: string }
interface DarkmownDocumentEditorProps {
  session: DocumentSession;
  readOnly?: boolean;
  active?: boolean;
  onChange: (text: string) => void;
  onRestoreText?: (text: string) => void;
  onFlushReady: (flush: (() => string | null) | null) => void;
  onCommandsReady?: (target: DocumentCommandTarget | null) => void;
}

function sameRevision(left: PreviewRevision | null, right: PreviewRevision): boolean {
  return !!left && left.epoch === right.epoch && left.source === right.source && left.generation === right.generation && left.trusted === right.trusted && left.reset === right.reset && left.colorScheme === right.colorScheme;
}

/** Authored source is the document. Runtime state exists only in the disposable opaque frame. */
export function DarkmownDocumentEditor({ session, readOnly = false, active = true, onChange, onRestoreText, onFlushReady, onCommandsReady }: DarkmownDocumentEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<PreviewMode>("split");
  const [grant, setGrant] = useState<{ epoch: string; source: string; generation: number } | null>(null);
  const [reset, setReset] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [sourceCommands, setSourceCommands] = useState<DocumentCommandTarget | null>(null);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">(() => {
    const store = loadThemeStore();
    return editorThemeForTokens(findTheme(store, store.activeId).tokens);
  });
  const allowed = active && !readOnly;
  const trusted = allowed && grant?.epoch === session.epoch && grant.source === session.text && grant.generation === session.generation;
  const staticColorScheme = trusted ? null : previewTheme;
  const latestTheme = useRef(previewTheme); latestTheme.current = previewTheme;
  const revision: PreviewRevision = { epoch: session.epoch, source: session.text, generation: session.generation, trusted, reset, colorScheme: staticColorScheme };
  const currentResult = sameRevision(result, revision) ? result : null;
  const canPreview = active && mode !== "source";
  const current = useRef({ allowed, mode, sourceCommands });
  current.current = { allowed, mode, sourceCommands };
  const projectPreviewTheme = useCallback(() => {
    if (trusted && currentResult?.srcDoc) previewFrame.current?.contentWindow?.postMessage({ type: "markie:preview-theme", theme: previewTheme }, "*");
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
    const requested = { epoch: session.epoch, source: session.text, generation: session.generation, trusted, reset, colorScheme: staticColorScheme };
    void compileDarkmownPreview(session.text, trusted, { signal: controller.signal, colorScheme: latestTheme.current }).then(
      (preview) => { if (!disposed) setResult({ ...requested, ...preview }); },
      (error: unknown) => { if (!disposed) setResult({ ...requested, error: error instanceof Error ? error.message : "Darkmown could not build this preview." }); },
    );
    return () => { disposed = true; controller.abort(); };
  }, [session.epoch, session.text, session.generation, trusted, reset, canPreview, staticColorScheme]);

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
        <p className="docs-darkmown-security">Local state only. No network, files, accounts or persistent storage.</p>
        {currentResult?.warnings?.length ? <div className="docs-darkmown-warnings" role="status">{currentResult.warnings.join(" ")}</div> : null}
        {currentResult?.error ? <div className="docs-error" role="alert"><span>{currentResult.error}</span><button type="button" disabled={!allowed} onClick={() => setReset((value) => value + 1)}>Retry preview</button></div> : currentResult?.srcDoc ? <iframe ref={previewFrame} key={`${session.epoch}-${session.generation}-${trusted}-${reset}-${staticColorScheme ?? "runtime"}`} title="Darkmown document preview" sandbox={trusted ? "allow-scripts" : ""} referrerPolicy="no-referrer" style={{ colorScheme: previewTheme }} onLoad={projectPreviewTheme} srcDoc={currentResult.srcDoc} /> : <p className="docs-loading" role="status">Building document preview…</p>}
      </section> : null}
    </div>} />
  </div>;
}
