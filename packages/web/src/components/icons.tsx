import type { JSX, SVGProps } from 'react';

/** Shared look for the UI's small line icons: 14px, drawn in the current text colour. */
function Svg({ className, children, ...rest }: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

interface IconProps {
  className?: string;
}

/** A push pin; filled when the chat is pinned. */
export function PinIcon({ filled = false, className }: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M6.5 1.5h3v4.5l2.5 2.5v1h-8v-1l2.5-2.5z" fill={filled ? 'currentColor' : 'none'} />
      <path d="M5.5 1.5h5M8 9.5v5" />
    </Svg>
  );
}

export function FolderPlusIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1z" />
      <path d="M8 7.5v4M6 9.5h4" />
    </Svg>
  );
}

export function GearIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="2" />
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </Svg>
  );
}

export function ChartIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M2.5 13.5h11M4.5 13.5v-4M8 13.5v-8M11.5 13.5v-6" />
    </Svg>
  );
}

/** A door with an arrow leaving it: Sign out. */
export function SignOutIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
      <path d="M10.5 5l3 3-3 3M13.5 8h-7" />
    </Svg>
  );
}
