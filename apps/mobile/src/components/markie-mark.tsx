// The Markie app mark: the amber M over a blue point, on graphite. The same
// drawing is rasterized for the native app icons (scripts/icons.mjs).
export const MARKIE_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232327"/><stop offset="1" stop-color="#101012"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<path d="M300 712V318l212 262 212-262v394" fill="none" stroke="url(#m)" stroke-width="112" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="512" cy="742" r="50" fill="#60a5fa"/>
</svg>`;

export function MarkieMark({ size = 56 }: { size?: number }) {
  return (
    <span className="m-mark" style={{ width: size, height: size, borderRadius: size * 0.2237 }} aria-hidden="true">
      <svg viewBox="0 0 1024 1024" width={size} height={size}>
        <defs>
          <linearGradient id="markie-mark-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#232327" /><stop offset="1" stopColor="#101012" /></linearGradient>
          <linearGradient id="markie-mark-m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fcd34d" /><stop offset="1" stopColor="#f59e0b" /></linearGradient>
        </defs>
        <rect width="1024" height="1024" fill="url(#markie-mark-bg)" />
        <path d="M300 712V318l212 262 212-262v394" fill="none" stroke="url(#markie-mark-m)" strokeWidth="112" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="512" cy="742" r="50" fill="#60a5fa" />
      </svg>
    </span>
  );
}
