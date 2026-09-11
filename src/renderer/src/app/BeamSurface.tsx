import { useEffect, useState } from 'react'
import type { BeamOfferView, BeamProgressView } from '@shared/bridge'
import { useStore } from '@/store'
import { safeThumbSrc } from '@/content/parse'
import { Avatar, Button, DeviceChip, formatBytes, Spinner } from '@/ui/atoms'

// Spec §6 — the AirDrop-feel receive surface: incoming-offer cards and live
// transfer capsules, stacked top-right under the titlebar. The sender's
// device chip renders at FULL contrast here — the accept decision is the
// security moment.

export function BeamSurface() {
  const offers = useStore((s) => s.beamOffers)
  const progress = useStore((s) => s.beamProgress)
  const presence = useStore((s) => s.presence)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const dismiss = (dropId: string) =>
    setDismissed((d) => {
      const next = new Set(d)
      next.add(dropId)
      return next
    })

  const activeOffers = offers.filter((o) => !dismissed.has(o.dropId) && !progress[o.dropId])
  const activeProgress = Object.values(progress).filter((p) => !dismissed.has(p.dropId))

  if (activeOffers.length === 0 && activeProgress.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 52,
        right: 12,
        // Above every full-window overlay (diagram editor 1100, lightbox
        // 1000): an incoming beam is a notification, and one a drawing surface
        // can hide is not a notification. Ladder: app/toasts.tsx.
        zIndex: 1150,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 320,
      }}
    >
      {activeOffers.map((o) => (
        <OfferCard key={o.dropId} offer={o} presence={presence} onDismiss={() => dismiss(o.dropId)} />
      ))}
      {activeProgress.map((p) => (
        <ProgressCapsule key={p.dropId} p={p} presence={presence} onDismiss={() => dismiss(p.dropId)} />
      ))}
    </div>
  )
}

function senderOf(presence: ReturnType<typeof useStore.getState>['presence'], deviceId: string) {
  return presence.find((x) => x.deviceId === deviceId)
}

function OfferCard({
  offer,
  presence,
  onDismiss,
}: {
  offer: BeamOfferView
  presence: ReturnType<typeof useStore.getState>['presence']
  onDismiss: () => void
}) {
  const sender = senderOf(presence, offer.fromDeviceId)
  const flagged = sender?.trust === 'flagged'
  const [busy, setBusy] = useState(false)

  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
        backdropFilter: 'blur(20px) saturate(1.2)',
        border: `1px solid ${flagged ? 'var(--warning)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--elev-3)',
        padding: 14,
        animation: 'sem-rise var(--t-base) var(--ease-pop)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ position: 'relative' }}>
          <Avatar name={sender?.name ?? '?'} size={36} />
          <span
            style={{
              position: 'absolute',
              inset: -3,
              borderRadius: 'var(--r-md)',
              border: '2px solid var(--flare)',
              opacity: 0.6,
              animation: 'sem-pulse 1.6s ease-in-out infinite',
              pointerEvents: 'none',
            }}
          />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
            {sender?.name ?? 'Teammate'} wants to send you a file
          </div>
          <div style={{ marginTop: 2 }}>
            {sender && <DeviceChip hostname={sender.hostname} fingerprint={sender.fingerprint} warn={flagged} full />}
          </div>
        </div>
      </div>

      {flagged && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 10px',
            borderRadius: 'var(--r-md)',
            background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
            fontSize: 12,
            color: 'var(--text-2)',
            lineHeight: '17px',
          }}
        >
          ⚠ This device is new for its display name — verify with the sender in person before accepting.
        </div>
      )}

      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          borderRadius: 'var(--r-md)',
          background: 'var(--bg-raised)',
        }}
      >
        {safeThumbSrc(offer.thumb) ? (
          <img src={safeThumbSrc(offer.thumb)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 'var(--r-sm)', filter: 'blur(2px)' }} />
        ) : (
          <span style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', color: 'var(--accent-text)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>
            {(offer.name.split('.').pop() ?? 'bin').slice(0, 3).toUpperCase()}
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{offer.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {formatBytes(offer.size)}
            {offer.note ? ` · “${offer.note}”` : ''}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.bridge.beams.decline(offer.dropId).finally(onDismiss)
          }}
        >
          Decline
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.bridge.beams.accept(offer.dropId).catch(onDismiss)
          }}
        >
          {busy ? <Spinner size={13} /> : 'Accept'}
        </Button>
      </div>
    </div>
  )
}

function ProgressCapsule({
  p,
  presence,
  onDismiss,
}: {
  p: BeamProgressView
  presence: ReturnType<typeof useStore.getState>['presence']
  onDismiss: () => void
}) {
  const peer = senderOf(presence, p.peerDeviceId)
  const pct = p.size > 0 ? Math.min(100, Math.round((p.bytesDone / p.size) * 100)) : 0
  const terminal = ['saved', 'declined', 'failed', 'canceled', 'expired'].includes(p.state)

  // Auto-dismiss successful transfers after 6s
  useEffect(() => {
    if (p.state !== 'saved') return
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [p.state, onDismiss])

  const label =
    p.state === 'saved'
      ? p.direction === 'receive'
        ? 'Received'
        : `Delivered to ${peer?.name ?? 'teammate'}`
      : p.state === 'declined'
        ? `${peer?.name ?? 'They'} declined`
        : p.state === 'failed'
          ? 'Transfer failed'
          : p.state === 'canceled'
            ? 'Canceled'
            : p.state === 'expired'
              ? 'Expired — not picked up'
              : p.state === 'waiting'
                ? `Waiting for ${peer?.name ?? 'teammate'} to accept…`
                : p.direction === 'send'
                  ? `Beaming to ${peer?.name ?? 'teammate'}`
                  : `Receiving from ${peer?.name ?? 'teammate'}`

  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--elev-2)',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>{p.state === 'saved' ? '✅' : p.state === 'failed' || p.state === 'declined' ? '✕' : '⚡'}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: p.state === 'failed' ? 'var(--danger)' : 'var(--text-1)' }}>{label}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.name} · {formatBytes(p.size)}
            {!terminal && p.state === 'transferring' ? ` · ${pct}% · ${p.transport === 'p2p' ? 'P2P direct' : 'via shared folder'}` : ''}
          </div>
        </div>
        {p.state === 'saved' && p.savedPath && (
          <button
            onClick={() => void window.bridge.app.showInFolder(p.savedPath!)}
            style={{ border: 'none', background: 'transparent', color: 'var(--accent-text)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Show
          </button>
        )}
        {(terminal || p.state === 'waiting') && (
          <button
            onClick={() => {
              if (p.state === 'waiting' && p.direction === 'send') void window.bridge.beams.cancel(p.dropId).catch(() => {})
              onDismiss()
            }}
            title={p.state === 'waiting' ? 'Cancel' : 'Dismiss'}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', fontSize: 14, cursor: 'pointer' }}
          >
            ×
          </button>
        )}
      </div>
      {!terminal && (
        <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: 'var(--bg-raised)', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: p.state === 'waiting' || p.state === 'connecting' ? '100%' : `${pct}%`,
              background: 'var(--flare)',
              opacity: p.state === 'waiting' || p.state === 'connecting' ? 0.3 : 1,
              transition: 'width 300ms var(--ease-standard)',
            }}
          />
        </div>
      )}
    </div>
  )
}
