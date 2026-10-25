// Line icons at the weight of the platform's own: 1.8px strokes on a 24px grid.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const ChevronLeft = (p: IconProps) => <Icon {...p}><path d="M15 5l-7 7 7 7" strokeWidth={2.4} /></Icon>;
export const ChevronRight = (p: IconProps) => <Icon {...p}><path d="M9.5 6l6 6-6 6" strokeWidth={2.2} /></Icon>;
export const ShareIcon = (p: IconProps) => <Icon {...p}><path d="M12 3.5v11" /><path d="M8 7.2l4-3.7 4 3.7" /><path d="M8.5 10.5H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5" /></Icon>;
export const GearIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Icon>
);
export const SearchIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></Icon>;
export const ClearIcon = (p: IconProps) => <Icon {...p} fill="currentColor" stroke="none"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.54 12.12a1 1 0 0 1-1.42 1.42L12 13.41l-2.12 2.13a1 1 0 0 1-1.42-1.42L10.59 12 8.46 9.88a1 1 0 0 1 1.42-1.42L12 10.59l2.12-2.13a1 1 0 0 1 1.42 1.42L13.41 12Z" /></Icon>;
export const SparkleIcon = (p: IconProps) => <Icon {...p} fill="currentColor" stroke="none"><path d="M12 2.5c.4 3.9 1.6 5.1 5.5 5.5-3.9.4-5.1 1.6-5.5 5.5-.4-3.9-1.6-5.1-5.5-5.5 3.9-.4 5.1-1.6 5.5-5.5Zm6.5 10c.25 2.2.9 2.85 3 3-2.1.15-2.75.8-3 3-.25-2.2-.9-2.85-3-3 2.1-.15 2.75-.8 3-3ZM6 14.5c.2 1.6.7 2.1 2.3 2.3-1.6.2-2.1.7-2.3 2.3-.2-1.6-.7-2.1-2.3-2.3 1.6-.2 2.1-.7 2.3-2.3Z" /></Icon>;
export const PeopleIcon = (p: IconProps) => <Icon {...p}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" /><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17.2 14.4c1.8.5 3 2.1 3.3 4.6" /></Icon>;
export const LockIcon = (p: IconProps) => <Icon {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.2" /><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" /></Icon>;
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3l7.5 3v5.6c0 4.4-3.1 8.2-7.5 9.4-4.4-1.2-7.5-5-7.5-9.4V6Z" /><path d="M9 12.2l2.2 2.2L15.3 10" /></Icon>;
export const AlertIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.4v.1" strokeWidth={2.6} /></Icon>;
export const MailIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="5.5" width="18" height="13" rx="2.4" /><path d="M3.8 7l8.2 6 8.2-6" /></Icon>;
export const DocIcon = (p: IconProps) => <Icon {...p}><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5" /></Icon>;
export const ResetIcon = (p: IconProps) => <Icon {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4.5v4h4" /></Icon>;
