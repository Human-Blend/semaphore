import type { CSSProperties, ReactNode } from 'react'
import type { PresenceStateKind } from '@shared/types'

// Shared UI atoms — the identity/presence building blocks every surface uses.
// Owned here so chat, sidebar, and beam surfaces render identity identically.

const HUES = ['--hue-0', '--hue-1', '--hue-2', '--hue-3', '--hue-4', '--hue-5', '--hue-6', '--hue-7']

export function identityHue(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `var(${HUES[h % HUES.length]})`
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function Avatar({
  name,
  size = 36,
  presence,
  desaturate,
}: {
  name: string
  size?: number
  presence?: PresenceStateKind | null
  desaturate?: boolean
}) {
  const hue = identityHue(name)
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 'var(--r-md)',
          background: hue,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 600,
          fontSize: size * 0.38,
          filter: desaturate ? 'saturate(0.6) brightness(0.85)' : undefined,
          userSelect: 'none',
        }}
      >
        {initialsOf(name)}
      </div>
      {presence !== undefined && presence !== null && (
        <span
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: size >= 32 ? 12 : 10,
            height: size >= 32 ? 12 : 10,
            borderRadius: '50%',
            background: presence === 'offline' ? 'transparent' : `var(--presence-${presence})`,
            border:
              presence === 'offline'
                ? '2px solid var(--presence-offline)'
                : '2px solid var(--bg-sidebar)',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  )
}

/** The anti-impersonation chip: hostname + key fingerprint. */
export function DeviceChip({
  hostname,
  fingerprint,
  warn,
  full,
}: {
  hostname: string
  fingerprint: string
  warn?: boolean
  full?: boolean
}) {
  return (
    <span
      title={`Device ${hostname} · key fingerprint ${fingerprint}\nThis label is derived from the key that signed the message — it cannot be typed or chosen.`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 500,
        color: warn ? 'var(--warning)' : full ? 'var(--text-1)' : 'var(--text-3)',
        background: warn ? 'color-mix(in srgb, var(--warning) 12%, transparent)' : 'var(--bg-raised)',
        border: `1px solid ${warn ? 'var(--warning)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--r-xs)',
        padding: '1px 5px',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {warn ? '⚠ ' : ''}
      {hostname}·{fingerprint.slice(0, 4)}
    </span>
  )
}

export function PresenceDot({ state, size = 10 }: { state: PresenceStateKind; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: state === 'offline' ? 'transparent' : `var(--presence-${state})`,
        border: state === 'offline' ? '2px solid var(--presence-offline)' : 'none',
        boxSizing: 'border-box',
      }}
    />
  )
}

export function IconButton({
  label,
  onClick,
  children,
  active,
  danger,
  size = 28,
}: {
  label: string
  onClick?: () => void
  children: ReactNode
  active?: boolean
  danger?: boolean
  size?: number
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--r-sm)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: danger ? 'var(--danger)' : active ? 'var(--accent-text)' : 'var(--text-2)',
        cursor: 'pointer',
        transition: 'background var(--t-instant) var(--ease-standard)',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-raised)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = active ? 'var(--accent-soft)' : 'transparent'
      }}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid var(--border-strong)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'sem-spin 0.8s linear infinite',
      }}
    />
  )
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  style,
  type,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  style?: CSSProperties
  type?: 'button' | 'submit'
}) {
  const base: CSSProperties = {
    padding: '7px 14px',
    borderRadius: 'var(--r-sm)',
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: '1px solid transparent',
    transition: 'background var(--t-fast) var(--ease-standard)',
    fontFamily: 'var(--font-ui)',
  }
  const variants: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--on-accent)' },
    ghost: { background: 'transparent', color: 'var(--text-2)', borderColor: 'var(--border-strong)' },
    danger: { background: 'transparent', color: 'var(--danger)', borderColor: 'var(--danger)' },
  }
  return (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}>
      {children}
    </button>
  )
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDayDivider(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return 'Today'
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
