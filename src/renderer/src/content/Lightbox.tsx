import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, MsgPayload } from '@shared/types'
import { useStore } from '@/store'
import { formatBytes } from '@/ui/atoms'
import { blobUrl, middleTruncate } from './parse'
import { CloseIcon, DownloadIcon } from './icons'
import './content.css'

// Spec §4.1 — full-window media lightbox. Reads store.lightbox itself; renders
// nothing when closed. Esc or click-outside closes; Save As streams from the
// blob service.

function findAttachment(
  events: ReturnType<typeof useStore.getState>['events'][string] | undefined,
  eventId: string,
  blobId: string,
): Attachment | null {
  if (!events) return null
  // Fast path: the exact event.
  for (const ev of events) {
    if (ev.id === eventId && ev.payload.t === 'msg') {
      const att = (ev.payload as MsgPayload).attachments?.find((a) => a.blobId === blobId)
      if (att) return att
    }
  }
  // Fallback: any message in the conversation carrying this blob.
  for (const ev of events) {
    if (ev.payload.t === 'msg') {
      const att = (ev.payload as MsgPayload).attachments?.find((a) => a.blobId === blobId)
      if (att) return att
    }
  }
  return null
}

export function Lightbox() {
  const lightbox = useStore((s) => s.lightbox)
  const events = useStore((s) => (lightbox ? s.events[lightbox.conv] : undefined))
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const att = useMemo(
    () => (lightbox ? findAttachment(events, lightbox.eventId, lightbox.blobId) : null),
    [lightbox, events],
  )

  const open = lightbox !== null && att !== null

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useStore.getState().openLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Reset transient state when the target changes.
  useEffect(() => {
    setNote(null)
  }, [lightbox?.blobId])

  if (!open || !att) return null

  const close = (): void => useStore.getState().openLightbox(null)
  const isVideo = att.mime.startsWith('video/')
  const url = blobUrl(att)

  const saveAs = (): void => {
    window.bridge.files.saveBlobAs(att.blobId, att.name).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setNote(
        msg.includes('not-implemented')
          ? 'File service lands in the next build'
          : 'Could not save — the share may be unreachable',
      )
      if (noteTimer.current) clearTimeout(noteTimer.current)
      noteTimer.current = setTimeout(() => setNote(null), 2600)
    })
  }

  return (
    <div
      className="sem-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${att.name}`}
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Top chrome */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 52,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px 0 16px',
          userSelect: 'none',
        }}
      >
        <span style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#fff', whiteSpace: 'nowrap' }}>
            {middleTruncate(att.name, 48)}
          </span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>
            {formatBytes(att.size)}
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {note && (
          <span style={{ fontSize: 12, color: 'var(--warning)', whiteSpace: 'nowrap' }}>{note}</span>
        )}
        <button
          onClick={saveAs}
          title={`Save ${att.name} as…`}
          aria-label={`Save ${att.name} as…`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 28,
            padding: '0 10px',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 'var(--r-sm)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
          }}
        >
          <DownloadIcon size={13} />
          Save As
        </button>
        <button
          onClick={close}
          title="Close (Esc)"
          aria-label="Close media viewer"
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 'var(--r-sm)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          <CloseIcon size={15} />
        </button>
      </div>

      {/* Media, centered and scaled to fit */}
      <div className="sem-lightbox-media" onClick={(e) => e.stopPropagation()} style={{ display: 'flex' }}>
        {isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            aria-label={att.name}
            style={{
              maxWidth: 'calc(100vw - 96px)',
              maxHeight: 'calc(100vh - 128px)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--elev-3)',
            }}
          />
        ) : (
          <img
            src={url}
            alt={att.name}
            draggable={false}
            style={{
              maxWidth: 'calc(100vw - 96px)',
              maxHeight: 'calc(100vh - 128px)',
              objectFit: 'contain',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--elev-3)',
            }}
          />
        )}
      </div>
    </div>
  )
}
