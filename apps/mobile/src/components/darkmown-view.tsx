// A Darkmown document, compiled and run exactly as the desktop does it:
// the pinned compiler off-thread, the same sanitizer, the same srcdoc CSP
// (src/lib/darkmown/preview.ts) and the same frame sandbox
// (src/lib/darkmown/frame.ts). Until the person trusts this exact source the
// preview is static: scriptless, every control disabled.
//
// Trust is for this source, in this viewing, only. A reload that brings
// different text, leaving the document, or "Revoke" ends it.
//
// The frame is as tall as the document, not the screen. The running frame
// has no channel back to say how tall it is (frame.ts), so the height comes
// from the static preview: the same scriptless srcdoc, laid out once in a
// hidden frame at the same width and measured. With no script in it and no
// way to run one, reading its layout is all that frame is for.
import { useEffect, useRef, useState } from "react";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
import { darkmownFrameSandbox, projectDarkmownTheme } from "@/lib/darkmown/frame";
import type { Tone } from "../lib/theme-mode";
import { AlertIcon, ResetIcon, ShieldIcon } from "./icons";

interface DarkmownViewProps {
  docKey: string;
  source: string;
  tone: Tone;
}

interface Built {
  source: string;
  trusted: boolean;
  reset: number;
  scheme: Tone | null;
  srcDoc?: string;
  warnings?: string[];
  error?: string;
}

// The empty sandbox plus same-origin: still no script, forms, popups or
// navigation, and the host can read the layout.
const MEASURE_SANDBOX = "allow-same-origin";

export function DarkmownView({ docKey, source, tone }: DarkmownViewProps) {
  const [grant, setGrant] = useState<{ docKey: string; source: string } | null>(null);
  const [reset, setReset] = useState(0);
  const [built, setBuilt] = useState<Built | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<{ source: string; width: number; height: number } | null>(null);
  const trusted = grant?.docKey === docKey && grant.source === source;
  // A static preview bakes its color scheme in; a running one is told by message.
  const scheme = trusted ? null : tone;
  const toneRef = useRef(tone);
  toneRef.current = tone;

  useEffect(() => {
    const controller = new AbortController();
    const requested = { source, trusted, reset, scheme };
    compileDarkmownPreview(source, trusted, { signal: controller.signal, colorScheme: toneRef.current }).then(
      (preview) => { if (!controller.signal.aborted) setBuilt({ ...requested, ...preview }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setBuilt({ ...requested, error: error instanceof Error ? error.message : "Darkmown could not build this document." });
      }
    );
    return () => controller.abort();
  }, [source, trusted, reset, scheme]);

  const current = built && built.source === source && built.trusted === trusted && built.reset === reset && built.scheme === scheme ? built : null;

  useEffect(() => {
    if (trusted && current?.srcDoc) projectDarkmownTheme(frame.current, tone);
  }, [trusted, current?.srcDoc, tone]);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const height = measured?.source === source ? measured.height : null;
  const measureDoc = !trusted && current?.srcDoc && width > 0 && !(measured?.source === source && measured.width === width) ? current.srcDoc : null;

  return (
    <div className="m-wd">
      {trusted ? (
        <div className="m-wd-bar is-trusted" role="status">
          <ShieldIcon size={18} />
          <span className="m-wd-bar-text"><strong>Trusted</strong> Local state only</span>
          <button type="button" className="m-chip-button" onClick={() => setReset((value) => value + 1)}><ResetIcon size={15} />Reset</button>
          <button type="button" className="m-chip-button" onClick={() => setGrant(null)}>Revoke</button>
        </div>
      ) : (
        <div className="m-wd-card">
          <div className="m-wd-card-text">
            <strong>Interactive document</strong>
            <span>Trust this document to enable its local controls. It runs with local state only: no network, files, accounts or storage.</span>
          </div>
          <button type="button" className="m-button m-button-primary m-button-small" onClick={() => setGrant({ docKey, source })}>Trust this document</button>
        </div>
      )}
      {current?.warnings?.length ? <p className="m-wd-warning" role="status">{current.warnings.join(" ")}</p> : null}
      <div ref={wrap} className="m-wd-frame-wrap" style={height ? { flexGrow: 0, height } : undefined}>
        {measureDoc ? (
          <iframe
            key={`measure-${width}`}
            className="m-wd-measure"
            title=""
            aria-hidden="true"
            tabIndex={-1}
            sandbox={MEASURE_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={measureDoc}
            onLoad={(event) => {
              const root = event.currentTarget.contentDocument?.documentElement;
              if (root?.scrollHeight) setMeasured({ source, width, height: Math.ceil(root.scrollHeight) });
            }}
          />
        ) : null}
        {current?.error ? (
          <div className="m-empty m-empty-compact" role="alert">
            <AlertIcon size={26} />
            <p>{current.error}</p>
            <button type="button" className="m-button m-button-secondary m-button-small" onClick={() => setReset((value) => value + 1)}>Try again</button>
          </div>
        ) : current?.srcDoc ? (
          <iframe
            ref={frame}
            key={`${docKey}-${trusted}-${reset}-${scheme ?? "runtime"}`}
            className="m-wd-frame"
            title="Interactive document"
            sandbox={darkmownFrameSandbox(trusted)}
            referrerPolicy="no-referrer"
            style={{ colorScheme: tone }}
            onLoad={() => { if (trusted) projectDarkmownTheme(frame.current, toneRef.current); }}
            srcDoc={current.srcDoc}
          />
        ) : (
          <p className="m-loading-line" role="status"><span className="m-spinner" aria-hidden="true" />Building the document</p>
        )}
      </div>
    </div>
  );
}
