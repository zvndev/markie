const FORMAT_STYLE: Record<string, { accent: string; soft: string; short: string }> = {
  markdown: { accent: "#7dd3fc", soft: "rgba(56,189,248,.18)", short: "MD" },
  docx: { accent: "#60a5fa", soft: "rgba(59,130,246,.20)", short: "W" },
  doc: { accent: "#93c5fd", soft: "rgba(96,165,250,.16)", short: "W" },
  rtf: { accent: "#2dd4bf", soft: "rgba(45,212,191,.17)", short: "Aa" },
  odt: { accent: "#38bdf8", soft: "rgba(14,165,233,.18)", short: "OD" },
  text: { accent: "#a1a1aa", soft: "rgba(161,161,170,.16)", short: "TXT" },
  darkmown: { accent: "#fbbf24", soft: "rgba(251,191,36,.17)", short: "WD" },
  csv: { accent: "#4ade80", soft: "rgba(74,222,128,.16)", short: "CSV" },
  json: { accent: "#facc15", soft: "rgba(250,204,21,.15)", short: "{ }" },
  yaml: { accent: "#fb7185", soft: "rgba(251,113,133,.16)", short: "YML" },
  xml: { accent: "#fb923c", soft: "rgba(251,146,60,.16)", short: "</>" },
  html: { accent: "#f97316", soft: "rgba(249,115,22,.16)", short: "</>" },
  other: { accent: "#a1a1aa", soft: "rgba(161,161,170,.13)", short: "FILE" },
};

type MarkSize = "sm" | "md" | "lg";
const SIZES: Record<MarkSize, readonly [number, number]> = { sm: [29, 35], md: [40, 48], lg: [58, 70] };

function FormatGlyph({ format, accent }: { format: string; accent: string }) {
  const line = { stroke: accent, strokeWidth: 2.6, strokeLinecap: "round" as const, opacity: 0.88 };
  if (format === "csv") return <g stroke={accent} strokeWidth="1.7" opacity="0.9"><path d="M13 25h22M13 32h22M13 39h22M20 19v25M28 19v25" /></g>;
  if (format === "darkmown") return <g><path d="M29 18a8 8 0 1 0 6 13 10 10 0 0 1-6-13Z" fill={accent} opacity="0.92" /><circle cx="17" cy="38" r="2.2" fill={accent} /><path d="M22 38h10" {...line} strokeWidth="2" /></g>;
  if (format === "json") return <text x="24" y="35" textAnchor="middle" fill={accent} fontSize="15" fontWeight="700" fontFamily="ui-monospace, monospace">{"{ }"}</text>;
  if (format === "xml" || format === "html") return <text x="24" y="35" textAnchor="middle" fill={accent} fontSize="14" fontWeight="700" fontFamily="ui-monospace, monospace">{"</>"}</text>;
  if (format === "yaml") return <g><path d="M14 23h7M25 23h9M14 31h5M23 31h11M14 39h9" {...line} /></g>;
  if (format === "markdown") return <g><path d="M14 21h13M14 29h20M14 37h16" {...line} /><path d="M31 16v7M28.5 20.5 31 23l2.5-2.5" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" /></g>;
  if (format === "docx" || format === "doc") return <g><text x="17" y="30" fill={accent} fontSize="17" fontWeight="750" fontFamily="Georgia, serif">W</text><path d="M24 24h10M14 34h20M14 41h14" {...line} strokeWidth="2.1" /></g>;
  if (format === "rtf") return <g><text x="13" y="30" fill={accent} fontSize="15" fontStyle="italic" fontWeight="700" fontFamily="Georgia, serif">Aa</text><path d="M14 37h20M14 43h13" {...line} strokeWidth="2" /></g>;
  if (format === "odt") return <g><circle cx="18" cy="24" r="5" fill="none" stroke={accent} strokeWidth="2.4" /><path d="M27 24h7M14 35h20M14 42h14" {...line} strokeWidth="2.1" /></g>;
  if (format === "text") return <g><path d="M14 22h20M14 29h20M14 36h13M14 43h17" {...line} strokeWidth="2" /></g>;
  return <g><path d="M14 25h20M14 33h16M14 41h11" {...line} /></g>;
}

/** A miniature sheet, not a generic file icon: each format has its own mark
 * and a tint derived from the application family users already recognize. */
export function DocumentFormatMark({ format, size = "md" }: { format: string; size?: MarkSize }) {
  const style = FORMAT_STYLE[format] ?? FORMAT_STYLE.other;
  const [width, height] = SIZES[size];
  const gradientId = `fmt-${format.replace(/[^a-z0-9]/gi, "")}-${size}`;
  return (
    <span
      data-document-format-mark={format}
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center drop-shadow-[0_5px_10px_rgba(0,0,0,0.18)]"
      style={{ width, height }}
    >
      <svg width={width} height={height} viewBox="0 0 48 58" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="8" y1="4" x2="40" y2="54" gradientUnits="userSpaceOnUse">
            <stop stopColor={style.soft} />
            <stop offset="0.48" stopColor="var(--surface-2)" />
            <stop offset="1" stopColor="var(--background)" />
          </linearGradient>
        </defs>
        <path d="M10 4h19l9 9v38a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill={`url(#${gradientId})`} stroke={style.accent} strokeOpacity="0.58" />
        <path d="M29 4v9h9" fill={style.soft} stroke={style.accent} strokeOpacity="0.48" strokeLinejoin="round" />
        <path d="M7 7.5A2.5 2.5 0 0 1 10 5h18" stroke="var(--foreground)" strokeOpacity="0.14" />
        <FormatGlyph format={format} accent={style.accent} />
        <text x="24" y="52" textAnchor="middle" fill={style.accent} fontSize={style.short.length > 3 ? 5.5 : 6.5} fontWeight="750" letterSpacing="0.08em" fontFamily="ui-sans-serif, system-ui">{style.short}</text>
      </svg>
    </span>
  );
}
