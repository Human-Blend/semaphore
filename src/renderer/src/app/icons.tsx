import type { ReactNode } from 'react'

// Tiny inline stroke icons — no icon library ships with Semaphore.

interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

export function IconSearch({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5 16.2 16.2" />
    </Svg>
  )
}

export function IconPlus({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconGear({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.5M12 18.7v2.5M2.8 12h2.5M18.7 12h2.5M5.4 5.4l1.8 1.8M16.8 16.8l1.8 1.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8" />
    </Svg>
  )
}

export function IconPin({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 4h6l1 7 2.5 2.5V15h-11v-1.5L10 11l-1-7z" />
      <path d="M12 15v6" />
    </Svg>
  )
}

export function IconPanel({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M15 4.5v15" />
    </Svg>
  )
}

export function IconX({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

export function IconFolder({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z" />
    </Svg>
  )
}

export function IconCheck({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 13l4.2 4.2L19 7" />
    </Svg>
  )
}

export function IconWarn({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5 22 20.5H2L12 3.5z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.6v.2" />
    </Svg>
  )
}

export function IconLock({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  )
}

export function IconUsers({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.2 20c0-3.2 2.6-5.8 5.8-5.8s5.8 2.6 5.8 5.8" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M17.8 14.4c2.4.4 4.2 2.4 4.2 5" />
    </Svg>
  )
}

export function IconInfo({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <path d="M12 8v.2" />
    </Svg>
  )
}

export function IconBolt({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13 3 5 13.5h5L11 21l8-10.5h-5L13 3z" />
    </Svg>
  )
}

export function IconArrowUp({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}

export function IconFile({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v4h4" />
    </Svg>
  )
}

