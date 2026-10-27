// The Markie app mark: the red underline (src/lib/brand.ts) on the app icon's
// tile, white in the light theme and brand dark in the dark one, as the iOS
// AppIcon's default and dark variants are. scripts/icons.mjs draws the launch
// screens from the same path.
import { BRAND_COLORS, SYMBOL_TRANSFORM, SYMBOL_VIEWBOX, UNDERLINE_PATH } from "@/lib/brand";

export function MarkieMark({ size = 56 }: { size?: number }) {
  return (
    <span className="m-mark" style={{ width: size, height: size, borderRadius: size * 0.2237 }} aria-hidden="true">
      <svg viewBox="0 0 1024 1024" width={size} height={size}>
        {/* 74% of the tile's width, centered: the AppIcon's own proportions. */}
        <svg x="132" y="398" width="760" height="228" viewBox={SYMBOL_VIEWBOX} overflow="visible">
          <g transform={SYMBOL_TRANSFORM}>
            <path fill={BRAND_COLORS.red} fillRule="evenodd" d={UNDERLINE_PATH} stroke={BRAND_COLORS.red} strokeWidth={size < 48 ? 8 : 0} strokeLinejoin="round" />
          </g>
        </svg>
      </svg>
    </span>
  );
}
