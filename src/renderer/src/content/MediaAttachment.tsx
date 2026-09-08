import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { Attachment, ConvId } from '@shared/types'
import { useStore } from '@/store'
import { blobUrl, fitMediaBox, formatDuration } from './parse'
import './content.css'

// Spec §4.1 — inline media. The box is reserved from event metadata (w/h) so
// nothing reflows; the embedded blurred thumb paints instantly underneath and
// the decrypted stream (sfblob://) crossfades on top when it arrives.

function ScrimPill({ children, corner }: { children: string; corner: 'tl' | 'br' }) {
  const pos: CSSProperties =
    corner === 'tl' ? { top: 6, left: 6 } : { bottom: 6, right: 6 }
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        ...pos,
        padding: '1px 6px',
        borderRadius: 'var(--r-full)',
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#fff',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: '16px',
        fontWeight: 500,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {children}
    </span>
  )
}

export function MediaAttachment({
  att,
  conv,
  eventId,
  cell,
  overflowCount,
}: {
  att: Attachment
  conv: ConvId
  eventId: string
  /** Fixed grid-cell size (multi-image layouts); omit for the natural box. */
  cell?: { w: number; h: number }
  /** "+N" scrim for the last visible cell of a 5+ grid. */
  overflowCount?: number
}) {
  const [failed, setFailed] = useState(false)
  const box = cell ?? fitMediaBox(att.w, att.h)
  const url = blobUrl(att)
  const isVideo = att.mime.startsWith('video/')
  const isGif = att.mime === 'image/gif'

  const openLightbox = (): void => {
    useStore.getState().openLightbox({ conv, eventId, blobId: att.blobId })
  }

  const frame: CSSProperties = {
    position: 'relative',
    width: box.w,
    height: box.h,
    maxWidth: '100%',
    borderRadius: cell ? 'var(--r-xs)' : 'var(--r-lg)',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden',
    background: 'var(--bg-raised)',
    boxSizing: 'border-box',
    flexShrink: 0,
  }

  const fill: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  }

  const thumbLayer = att.thumb ? (
    <img
      src={att.thumb}
      alt=""
      aria-hidden
      draggable={false}
      style={{ ...fill, filter: 'blur(12px)', transform: 'scale(1.06)' }}
    />
  ) : null

  if (isVideo && !cell) {
    return (
      <div style={frame}>
        {thumbLayer}
        {failed ? (
          <WarmingUp />
        ) : (
          <video
            src={url}
            controls
            preload="metadata"
            aria-label={att.name}
            onError={() => setFailed(true)}
            style={{ ...fill, background: 'transparent' }}
          />
        )}
        {att.durMs !== undefined && <ScrimPill corner="br">{formatDuration(att.durMs)}</ScrimPill>}
      </div>
    )
  }

  // Images, GIFs, and any media rendered as a grid cell.
  return (
    <button
      className="sem-media-btn"
      onClick={openLightbox}
      title={`Open ${att.name}`}
      aria-label={`Open ${att.name} in the lightbox`}
      style={{ ...frame, cursor: 'zoom-in' }}
    >
      {thumbLayer}
      {failed ? (
        <WarmingUp />
      ) : isVideo ? (
        <video src={url} muted preload="metadata" onError={() => setFailed(true)} style={fill} />
      ) : (
        <img
          src={url}
          alt={att.name}
          draggable={false}
          onError={() => setFailed(true)}
          style={fill}
        />
      )}
      {isGif && <ScrimPill corner="tl">GIF</ScrimPill>}
      {isVideo && att.durMs !== undefined && (
        <ScrimPill corner="br">{formatDuration(att.durMs)}</ScrimPill>
      )}
      {overflowCount !== undefined && overflowCount > 0 && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.55)',
            color: '#fff',
            fontSize: 17,
            fontWeight: 600,
            userSelect: 'none',
          }}
        >
          +{overflowCount}
        </span>
      )}
    </button>
  )
}

/** Honest fallback while the sfblob service is not streaming yet. */
function WarmingUp() {
  return (
    <span
      className="sem-shimmer"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: 8,
      }}
    >
      <span
        style={{
          padding: '2px 8px',
          borderRadius: 'var(--r-full)',
          background: 'rgba(0, 0, 0, 0.55)',
          color: 'rgba(255, 255, 255, 0.85)',
          fontSize: 11,
          lineHeight: '16px',
          userSelect: 'none',
        }}
      >
        file service warming up
      </span>
    </span>
  )
}
