// The Markie logo and mark as inline SVG (src/lib/brand.ts).
//
// MarkieLogo is the full lockup. Its lettering is currentColor, so a parent's
// text color picks ink on light surfaces and white on dark ones; the underline
// stays brand red. The brand pack sets 120px as its smallest width.
//
// MarkieSymbol is the underline alone, for surfaces too small for the lockup.
// `thick` adds the favicon's optical stroke, which keeps it legible under ~32px.
import {
  BRAND_COLORS,
  LETTERING_PATH,
  LOGO_TRANSFORM,
  LOGO_VIEWBOX,
  SMALL_SYMBOL_STROKE,
  SYMBOL_TRANSFORM,
  SYMBOL_VIEWBOX,
  UNDERLINE_PATH,
} from "@/lib/brand";

const LOGO_RATIO = 246 / 563;
const SYMBOL_RATIO = 109 / 364;

export function MarkieLogo({ width = 120, className, title = "Markie" }: { width?: number; className?: string; title?: string | null }) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      width={width}
      height={Math.round(width * LOGO_RATIO)}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      data-brand="logo"
    >
      <g transform={LOGO_TRANSFORM}>
        <path fill="currentColor" fillRule="evenodd" d={LETTERING_PATH} />
        <path fill={BRAND_COLORS.red} fillRule="evenodd" d={UNDERLINE_PATH} />
      </g>
    </svg>
  );
}

export function MarkieSymbol({ width = 24, thick = width < 40, className }: { width?: number; thick?: boolean; className?: string }) {
  return (
    <svg
      viewBox={SYMBOL_VIEWBOX}
      width={width}
      height={Math.max(1, Math.round(width * SYMBOL_RATIO))}
      className={className}
      aria-hidden="true"
      overflow="visible"
      data-brand="symbol"
    >
      <g transform={SYMBOL_TRANSFORM}>
        <path
          fill={BRAND_COLORS.red}
          fillRule="evenodd"
          d={UNDERLINE_PATH}
          {...(thick ? { stroke: BRAND_COLORS.red, strokeWidth: SMALL_SYMBOL_STROKE,strokeLinejoin: "round" as const } : {})}
        />
      </g>
    </svg>
  );
}
