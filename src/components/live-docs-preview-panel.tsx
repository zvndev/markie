// The Live Docs preview, step M1 (super-nightly): a panel that runs the folder
// the main process accepted and shows it in a native view laid over this
// panel's body. The native view is not part of this page. It draws on top of
// everything here, so the panel hides it whenever another overlay is open.
//
// This is a proof, not the finished area: no file tree, editor or problems
// list. Those come with the Live Docs area (steps M3 and M4).
import { useEffect, useRef, useState } from "react";
import {
  getElectronAPI,
  type LiveDocsPreviewChoice,
  type LiveDocsPreviewStatus,
} from "@/lib/electron";

const BUTTON = "markie-overlay-button rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-accent/40 hover:text-foreground disabled:opacity-40";

interface LiveDocsPreviewPanelProps {
  /** What the folder picker answered when the command ran. */
  choice: LiveDocsPreviewChoice;
  /** Another overlay is open over the panel; the native view would cover it. */
  suspended: boolean;
  onClose: () => void;
}

function messageOf(value: { message?: string; error?: string }) {
  return value.message || value.error || "Something went wrong.";
}

export function LiveDocsPreviewPanel({ choice: initialChoice, suspended, onClose }: LiveDocsPreviewPanelProps) {
  const api = getElectronAPI()?.liveDocsPreview;
  const [choice, setChoice] = useState(initialChoice);
  const [status, setStatus] = useState<LiveDocsPreviewStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const project = choice.ok ? choice.project : null;
  const phase = !choice.ok ? "rejected" : (status?.phase ?? "starting");
  const ready = phase === "ready";

  // Run whatever folder main accepted, and stop it when the folder changes or
  // the panel closes.
  useEffect(() => {
    if (!api || !project) return;
    let live = true;
    setStatus({ ok: true, phase: "starting", project });
    const off = api.onStatus((next) => { if (live) setStatus(next); });
    void api.start().then((next) => {
      if (!live || !next || next.phase === "stopped") return;
      // A refusal from the private build's lock carries no phase.
      setStatus(next.phase ? next : { ...next, ok: false, phase: "error" });
    });
    return () => {
      live = false;
      off?.();
      void api.stop();
    };
  }, [api, project, attempt]);

  // Tell main where the native view goes, and hide it unless it is ready and
  // nothing else is open on top.
  useEffect(() => {
    const body = bodyRef.current;
    if (!api || !body) return;
    const visible = ready && !suspended;
    const send = () => {
      const rect = body.getBoundingClientRect();
      void api.layout({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, visible });
    };
    send();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(send);
    observer?.observe(body);
    window.addEventListener("resize", send);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [api, ready, suspended]);

  // Escape reaches this page only while it has focus. Inside the preview, the
  // page gets the key, the way any web page would.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !suspended) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suspended]);

  const chooseAgain = async () => {
    if (!api) return;
    const next = await api.choose();
    if (next.ok || next.code !== "canceled") setChoice(next);
  };

  const title = project?.name ?? "Darkmown project";
  const statusLine = phase === "ready"
    ? [status?.url, status?.node ? `Node ${status.node.version}` : null].filter(Boolean).join(" · ")
    : phase === "starting"
      ? "Starting darkmown dev…"
      : phase === "rejected"
        ? "Not a Darkmown project"
        : "Not running";

  return (
    <section
      aria-label="Darkmown project preview"
      data-live-docs-phase={phase}
      className="markie-overlay-panel overlay-popover-enter fixed inset-x-3 bottom-3 top-12 z-[60] flex flex-col overflow-hidden rounded-xl"
    >
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3">
        <span className="markie-overlay-section">Preview</span>
        <span className="min-w-0 truncate text-[13px] text-foreground" title={project?.root}>{title}</span>
        <span role="status" className="min-w-0 truncate text-[12px] text-muted">{statusLine}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {phase === "error" ? (
            <button type="button" className={BUTTON} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          ) : null}
          <button type="button" className={BUTTON} onClick={() => void chooseAgain()}>Choose folder…</button>
          <button type="button" aria-label="Close preview" className="markie-overlay-close text-[15px] leading-none" onClick={onClose}>×</button>
        </div>
      </header>
      <div ref={bodyRef} data-live-docs-preview-body className="relative min-h-0 flex-1 bg-background">
        {!ready ? (
          <div className="flex h-full flex-col gap-3 overflow-auto p-6 text-[13px]">
            {phase === "starting" ? (
              <p className="text-muted">Starting the project&apos;s own darkmown dev with your Node…</p>
            ) : null}
            {phase === "rejected" && !choice.ok ? (
              <p role="alert" className="text-foreground">{messageOf(choice)}</p>
            ) : null}
            {phase === "error" || phase === "stopped" ? (
              <p role="alert" className="text-foreground">{status ? messageOf(status) : "The preview stopped."}</p>
            ) : null}
            {status?.log?.length ? (
              <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 text-[11.5px] leading-relaxed text-muted whitespace-pre-wrap">
                {status.log.join("\n")}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
