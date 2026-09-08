import { useEffect, useMemo, useState } from 'react'
import type { ConvId } from '@shared/types'
import { useStore } from '@/store'

// A fixed 24px lane between the message list and the composer. Always
// reserved so typing indicators never shift layout.

export function TypingLane({
  conv,
  selfId,
  nameOf,
}: {
  conv: ConvId
  selfId: string
  nameOf: (device: string) => string
}) {
  const typing = useStore((s) => s.typing[conv])
  const [now, setNow] = useState(() => Date.now())

  const names = useMemo(() => {
    if (!typing) return []
    return Object.entries(typing)
      .filter(([device, until]) => device !== selfId && until > now)
      .map(([device]) => nameOf(device))
  }, [typing, selfId, now, nameOf])

  // Tick once a second only while someone is (or just was) typing.
  useEffect(() => {
    if (!typing) return
    const live = Object.entries(typing).some(([d, until]) => d !== selfId && until > Date.now())
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [typing, selfId, now])

  const text =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing`
          : 'several people are typing'

  return (
    <div
      aria-live="polite"
      style={{
        height: 24,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px 0 64px',
        overflow: 'hidden',
      }}
    >
      {text && (
        <>
          <span aria-hidden style={{ display: 'inline-flex', gap: 3 }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="sem-typing-dot"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--text-3)',
                  animationDelay: `${i * 150}ms`,
                }}
              />
            ))}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{text}</span>
        </>
      )}
    </div>
  )
}
