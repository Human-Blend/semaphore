import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { POLL } from '@shared/constants'
import { IconCheck, IconWarn } from './icons'

// Spec §10 — the flagship honesty banner. Amber while the share is
// unreachable (with a live retry countdown), deepening to danger after 60s,
// flipping green briefly on reconnect.

const RETRY_S = Math.round(POLL.remountMs / 1000)

export function HealthBanner() {
  const health = useStore((s) => s.health)
  const queued = useStore((s) => s.outboxQueued)

  const [downSince, setDownSince] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const [reconnected, setReconnected] = useState<number | null>(null) // queued count at flip
  const prevReachable = useRef(true)

  useEffect(() => {
    const was = prevReachable.current
    if (!health.reachable && was) {
      setDownSince(Date.now())
      setReconnected(null)
    }
    if (health.reachable && !was) {
      setDownSince(null)
      setReconnected(queued) // capture the queue size at the moment of the flip
      const t = window.setTimeout(() => setReconnected(null), 3000)
      return () => window.clearTimeout(t)
    }
    return undefined
    // queued intentionally omitted: we only sample it when reachability flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.reachable])

  useEffect(() => {
    prevReachable.current = health.reachable
  }, [health.reachable])

  useEffect(() => {
    if (downSince === null) return undefined
    const iv = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(iv)
  }, [downSince])
  void tick

  if (reconnected !== null) {
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          flexShrink: 0,
          padding: '0 16px',
          fontSize: 13,
          color: 'var(--success)',
          background: 'color-mix(in srgb, var(--success) 10%, transparent)',
          borderBottom: '1px solid var(--border-subtle)',
          animation: 'sem-banner-in var(--t-base) var(--ease-standard)',
        }}
      >
        <IconCheck size={15} />
        <span>
          Reconnected
          {reconnected > 0
            ? ` — sending ${reconnected} queued message${reconnected === 1 ? '' : 's'}`
            : ' — all caught up'}
        </span>
      </div>
    )
  }

  if (health.reachable || downSince === null) return null

  const downFor = Math.floor((Date.now() - downSince) / 1000)
  const severe = downFor >= 60
  const countdown = RETRY_S - (downFor % RETRY_S)
  const color = severe ? 'var(--danger)' : 'var(--warning)'

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 40,
        flexShrink: 0,
        padding: '0 16px',
        fontSize: 13,
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        borderBottom: '1px solid var(--border-subtle)',
        animation: 'sem-banner-in var(--t-base) var(--ease-standard)',
      }}
    >
      <IconWarn size={15} />
      <span style={{ color: 'var(--text-1)' }}>
        {severe
          ? 'Still trying — check VPN or the network drive. Messages you send are queued on this machine.'
          : 'Team folder unreachable — messages queue on this machine.'}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-3)' }}>
        {queued > 0 && (
          <span>
            {queued} queued
          </span>
        )}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>retrying in {countdown}s</span>
      </span>
    </div>
  )
}
