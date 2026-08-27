"use client";

// The rich pane builds a TipTap editor at render time. A throw in that binding
// is not catchable inside the component, and uncaught it takes the whole
// window down. Source mode is right there and holds the same document, so the
// fallback is an offer rather than an apology.
export function RichPaneError({
  onSwitchToSource,
  onReload,
}: {
  onSwitchToSource: () => void;
  onReload: () => void;
}) {
  return (
    <div role="alert" className="h-full w-full overflow-auto flex items-center justify-center p-8">
      <div className="max-w-[420px] flex flex-col gap-3 text-center">
        <p className="text-[13px] text-muted">
          The rich editor hit an error. Switch to Source to keep editing.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onSwitchToSource}
            className="h-8 px-3 rounded-md border border-border bg-surface hover:bg-surface-2 text-[13px]"
          >
            Switch to Source
          </button>
          <button
            type="button"
            onClick={onReload}
            className="h-8 px-3 rounded-md border border-border text-muted hover:text-foreground text-[13px]"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
