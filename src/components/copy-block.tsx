import { useState } from "react";

export function CopyBlock({
  label,
  hint,
  text,
}: {
  label: string;
  hint: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — user can select manually */
      }
    );
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted">
          <span className="uppercase tracking-wide font-semibold">{label}</span>{" "}
          <span>{hint}</span>
        </span>
        <button
          onClick={copy}
          className="markie-overlay-button text-[11px] px-2 py-0.5 rounded-md bg-accent text-foreground hover:opacity-90"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="text-[11.5px] leading-relaxed bg-background border border-border rounded-md p-2.5 overflow-x-auto text-foreground/90 whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}
