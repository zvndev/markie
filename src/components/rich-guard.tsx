import type { LossRisk } from "@/lib/rich-roundtrip";

const LABELS: Record<LossRisk, string> = {
  "front-matter": "front matter",
  footnotes: "footnotes",
  "raw-html": "raw HTML",
  "html-comments": "HTML comments",
  "display-math": "display math",
  "table-alignment": "table alignment",
  "wrapped-paragraphs": "wrapped lines",
  "reference-links": "reference-style links",
};

export function RichLossBanner({
  risks,
  onEditSource,
  onOverride,
}: {
  risks: LossRisk[];
  onEditSource: () => void;
  onOverride: () => void;
}) {
  const what =
    risks.length > 0
      ? risks.map((r) => LABELS[r]).join(", ")
      : "formatting the rich editor cannot represent";
  return (
    <div
      role="status"
      data-markie-rich-guard
      className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-foreground flex items-center gap-2 flex-wrap"
    >
      <span className="min-w-0">
        Rich editing is off for this file: it uses {what} that the rich editor
        would rewrite.
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onEditSource}
          className="h-6 px-2 rounded-md border border-border bg-surface hover:bg-accent/40 text-[11.5px]"
        >
          Edit in Source
        </button>
        <button
          type="button"
          onClick={onOverride}
          className="h-6 px-2 rounded-md text-muted hover:text-foreground text-[11.5px]"
          title="Rich edits will normalize this document's formatting"
        >
          Edit rich anyway
        </button>
      </span>
    </div>
  );
}
