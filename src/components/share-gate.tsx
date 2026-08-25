"use client";

// Share used to answer three different prerequisites with three unrelated
// surfaces: signed out opened Settings, an unsynced file silently opened the
// Library, and a synced file opened the real dialog only once a background
// fetch happened to land. When that fetch failed, `showShare` stayed true with
// nothing rendered, so every later click set an already-true state and did
// nothing at all, forever.
//
// This gate always opens. It resolves its own prerequisites, says which one is
// missing, and offers the action that clears it in place.

import { useCallback, useEffect, useRef, useState } from "react";
import { ShareDialog } from "@/components/share-dialog";
import { SignInForm } from "@/components/sign-in";
import { getElectronAPI } from "@/lib/electron";
import { useAuth } from "@/lib/auth-store";

type Stage =
  | { kind: "loading" }
  | { kind: "unsaved" }
  | { kind: "signed-out" }
  | { kind: "local" }
  | { kind: "ready"; docId: string }
  | { kind: "error"; message: string };

interface ShareGateProps {
  filePath: string | null;
  fileName: string | null;
  /** Current editor text, so an unsynced file can be pushed without a reload. */
  content: string;
  onClose: () => void;
  onChanged: () => void;
}

export function ShareGate({
  filePath,
  fileName,
  content,
  onClose,
  onChanged,
}: ShareGateProps) {
  // The gate reacts to the session rather than sampling a token once, so
  // signing in below re-resolves it in place instead of leaving a dead dialog.
  const { status } = useAuth();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  // Guards against a resolve that lands after the dialog closed or the file
  // changed underneath it.
  const run = useRef(0);

  const resolve = useCallback(() => {
    const ticket = ++run.current;
    const api = getElectronAPI();
    if (!filePath) {
      setStage({ kind: "unsaved" });
      return;
    }
    if (status === "checking") {
      setStage({ kind: "loading" });
      return;
    }
    if (status === "out") {
      setStage({ kind: "signed-out" });
      return;
    }
    if (!api?.registryGet) {
      setStage({ kind: "error", message: "Sharing isn't available in this window." });
      return;
    }
    setStage({ kind: "loading" });
    api
      .registryGet(filePath)
      .then((entry) => {
        if (ticket !== run.current) return;
        setStage(
          entry?.cloud_doc_id
            ? { kind: "ready", docId: entry.cloud_doc_id }
            : { kind: "local" }
        );
      })
      .catch(() => {
        if (ticket !== run.current) return;
        // The old code had no catch here at all, which is how Share became a
        // no-op that never explained itself.
        setStage({
          kind: "error",
          message: "Couldn't check whether this file is synced. Try again.",
        });
      });
  }, [filePath, status]);

  useEffect(() => {
    resolve();
    const token = run;
    return () => {
      // Invalidate any resolve still in flight for the previous file.
      token.current++;
    };
  }, [resolve]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const syncThenShare = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.docSyncOn || !filePath) return;
    setBusy(true);
    try {
      const res = await api.docSyncOn({
        path: filePath,
        name: fileName ?? "untitled.md",
        content,
      });
      if (res.error) {
        setStage({ kind: "error", message: res.error });
        return;
      }
      onChanged();
      resolve();
    } catch {
      setStage({
        kind: "error",
        message: "Couldn't sync this file. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }, [filePath, fileName, content, onChanged, resolve]);

  // Signing in is a prerequisite the gate can clear itself. Sending the user to
  // Settings instead threw away the thing they actually asked for, and they had
  // to find their way back to Share and click it a second time.
  if (stage.kind === "signed-out") {
    return (
      <div
        className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="markie-overlay-panel overlay-panel-enter w-[400px] max-w-[92vw] rounded-xl p-5"
          role="dialog"
          aria-modal="true"
          aria-label="Sign in to share"
        >
          <div className="flex justify-end -mt-1 -mr-1">
            <button className="markie-overlay-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          {/* onDone is not needed: the store publishes the new session, the
              `status` subscription fires, and resolve() runs with it. */}
          <SignInForm reason="share" />
        </div>
      </div>
    );
  }

  // Once the prerequisites are met the real dialog takes over entirely.
  if (stage.kind === "ready") {
    return (
      <ShareDialog
        key={stage.docId}
        docId={stage.docId}
        fileName={fileName ?? "Untitled"}
        onClose={onClose}
        onChanged={onChanged}
      />
    );
  }

  const body = () => {
    switch (stage.kind) {
      case "loading":
        return { line: "Checking this document…", action: null };
      case "unsaved":
        return {
          line: "Save this document to a file before you share it.",
          action: null,
        };
      case "local":
        return {
          line: `${fileName ?? "This document"} is only on this Mac. Syncing it to your account is what makes a share link possible.`,
          action: {
            label: busy ? "Syncing…" : "Sync and share",
            onClick: syncThenShare,
          },
        };
      case "error":
        return { line: stage.message, action: { label: "Try again", onClick: resolve } };
    }
  };

  const { line, action } = body();

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[440px] max-w-[92vw] rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-share-gate-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="markie-share-gate-title" className="text-[14px] font-medium text-foreground">
            Share this document
          </h2>
          <button className="markie-overlay-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{line}</p>
        {action && (
          <div className="mt-4 flex justify-end">
            <button
              className="markie-overlay-button text-[12.5px] px-3 py-1.5 rounded-md bg-accent text-foreground disabled:opacity-60"
              onClick={action.onClick}
              disabled={busy}
            >
              {action.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
