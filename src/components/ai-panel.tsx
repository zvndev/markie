"use client";

import { useEffect, useState } from "react";
import { aiChat, AI_TASKS, type AITaskKind } from "@/lib/ai";

interface AIPanelProps {
  task: AITaskKind;
  input: string; // document or selection text
  onInsert: (result: string) => void;
  onClose: () => void;
}

type Phase =
  | { state: "working" }
  | { state: "done"; result: string }
  | { state: "error"; message: string };

export function AIPanel({ task, input, onInsert, onClose }: AIPanelProps) {
  const [phase, setPhase] = useState<Phase>({ state: "working" });

  useEffect(() => {
    let alive = true;
    aiChat(AI_TASKS[task].system, input)
      .then((result) => {
        if (alive) setPhase({ state: "done", result });
      })
      .catch((err: Error) => {
        if (alive) setPhase({ state: "error", message: err.message });
      });
    return () => {
      alive = false;
    };
  }, [task, input]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[480px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
        data-ai-panel
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-semibold text-foreground">
            {AI_TASKS[task].title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close AI panel"
            className="text-muted hover:text-foreground"
          >
            ×
          </button>
        </div>

        {phase.state === "working" && (
          <div className="flex items-center gap-2 text-[13px] text-muted py-6">
            <span className="w-3 h-3 rounded-full border-2 border-muted border-t-transparent animate-spin" />
            Thinking on the local gateway…
          </div>
        )}

        {phase.state === "error" && (
          <div className="text-[13px] text-red-400 py-2">{phase.message}</div>
        )}

        {phase.state === "done" && (
          <>
            <div
              className="text-[13px] text-foreground/90 whitespace-pre-wrap bg-background border border-border rounded-md p-3 mb-3"
              data-ai-result
            >
              {phase.result}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(phase.result)}
                className="text-[12px] text-muted hover:text-foreground px-3 py-1.5"
              >
                Copy
              </button>
              <button
                onClick={() => {
                  onInsert(phase.result);
                  onClose();
                }}
                className="text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90"
              >
                {task === "rewrite" ? "Replace selection" : "Insert at top"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
