import type { ReactNode } from "react";
import "./format-badge.css";

// Small, scannable type cues for list rows: a page icon in the type's color
// with the glyph its family is known by, and a colored label. The large
// DocumentFormatMark stays for places with room for a miniature sheet.

export const FORMAT_LABEL: Record<string, { short: string; name: string }> = {
  markdown: { short: "MD", name: "Markdown" },
  docx: { short: "DOCX", name: "Word document" },
  doc: { short: "DOC", name: "Word 97-2004 document" },
  rtf: { short: "RTF", name: "Rich Text" },
  odt: { short: "ODT", name: "OpenDocument text" },
  text: { short: "TXT", name: "Plain text" },
  darkmown: { short: "WD", name: "Darkmown" },
  csv: { short: "CSV", name: "CSV spreadsheet" },
  json: { short: "JSON", name: "JSON" },
  yaml: { short: "YAML", name: "YAML" },
  xml: { short: "XML", name: "XML" },
  html: { short: "HTML", name: "HTML page" },
  other: { short: "FILE", name: "File" },
};

const fmtClass = (format: string) => `markie-fmt markie-fmt-${FORMAT_LABEL[format] ? format : "other"}`;

function Glyph({ format }: { format: string }): ReactNode {
  const line = { stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, fill: "none" };
  switch (format) {
    case "docx":
    case "doc":
      return <path d="M8.2 11.5l1.2 5 1.6-4.2 1.6 4.2 1.2-5" {...line} strokeWidth={1.4} strokeLinejoin="round" />;
    case "rtf":
      return <path d="M9 17l2.6-6.5L14.2 17M10 15h3.2" {...line} strokeWidth={1.4} strokeLinejoin="round" />;
    case "odt":
      return <><circle cx="10.5" cy="13" r="1.9" {...line} strokeWidth={1.3} /><path d="M14 13h2M8.5 17h7" {...line} strokeWidth={1.3} /></>;
    case "csv":
      return <path d="M8 11.5h8M8 14.5h8M8 17.5h8M11 10v9" {...line} strokeWidth={1.2} />;
    case "json":
      return <path d="M10.5 10.5c-1.2 0-1.5.6-1.5 1.6v.8c0 .6-.3 1.1-1 1.1.7 0 1 .5 1 1.1v.8c0 1 .3 1.6 1.5 1.6M13.5 10.5c1.2 0 1.5.6 1.5 1.6v.8c0 .6.3 1.1 1 1.1-.7 0-1 .5-1 1.1v.8c0 1-.3 1.6-1.5 1.6" {...line} strokeWidth={1.2} />;
    case "xml":
    case "html":
      return <path d="M10 11.5L8 14l2 2.5M14 11.5l2 2.5-2 2.5" {...line} strokeWidth={1.4} strokeLinejoin="round" />;
    case "yaml":
      return <path d="M8.5 11.5h3M8.5 14.5h7M10.5 17.5h5" {...line} strokeWidth={1.4} />;
    case "darkmown":
      return <path d="M13.6 10.6a3.4 3.4 0 1 0 2.4 5.2 3.6 3.6 0 0 1-2.4-5.2z" fill="currentColor" />;
    case "markdown":
      return <path d="M7.8 17v-5l2 2.4 2-2.4v5M14.6 12v5M13.2 15.6l1.4 1.4 1.4-1.4" {...line} strokeWidth={1.3} strokeLinejoin="round" />;
    case "text":
      return <path d="M8.5 11.5h7M8.5 14.5h7M8.5 17.5h4.5" {...line} strokeWidth={1.4} />;
    default:
      return <path d="M8.5 13h7M8.5 16h5" {...line} strokeWidth={1.4} />;
  }
}

/** A page in the type's color, with that family's glyph. */
export function FormatFileIcon({ format, size = 15 }: { format: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-format-icon={format} className={`${fmtClass(format)} markie-fmt-icon shrink-0`}>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" fill="color-mix(in srgb, currentColor 12%, transparent)" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M14 2.5V8h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <Glyph format={format} />
    </svg>
  );
}

/** The type as a short colored label. Hidden from assistive tech: the file
 * name beside it already carries the extension, so it would only repeat it. */
export function FormatBadge({ format }: { format: string }) {
  const label = FORMAT_LABEL[format] ?? FORMAT_LABEL.other;
  return <span className={`${fmtClass(format)} markie-fmt-badge shrink-0`} title={label.name} aria-hidden="true" data-format-badge={format}>{label.short}</span>;
}

/** Which server a document lives on, for any server but Markie Cloud. Same
 * shape as the type label, in a neutral color, and read out: unlike the type,
 * nothing else in the row says where the document is. The name is the
 * server's own say; the host beside it is the fact. */
export function ServerBadge({ label, origin }: { label: string; origin: string }) {
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // keep the origin as written
  }
  const where = label === host ? host : `${label} (${host})`;
  return (
    <span
      className="markie-fmt markie-fmt-badge markie-server-badge shrink-0"
      title={`On ${where}`}
      aria-label={`On ${where}`}
      data-server-badge={origin}
    >
      {label}
    </span>
  );
}
