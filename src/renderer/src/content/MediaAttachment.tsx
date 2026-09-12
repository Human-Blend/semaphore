import type { CSSProperties } from 'react'
import type { Attachment, ConvId } from '@shared/types'
import { useStore } from '@/store'
import { fitMediaBox, formatDuration, safeThumbSrc } from './parse'
import { useBlobMedia } from './useBlobMedia'
import './content.css'

// Spec §4.1 — inline media. The box is reserved from event metadata (w/h) so
// nothing reflows; the embedded blurred thumb paints instantly underneath and
// the decrypted stream (sfblob://) crossfades on top when it arrives.
//
// A failed stream is a *state*, not a verdict: useBlobMedia retries it on a
// backoff (and at once when the share comes back), keeping the blurred thumb
// and the "warming up" pill up meanwhile. Only main saying 404 — which it
// reserves for a blob the sweep really took — turns into "cleaned up".

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
  const media = useBlobMedia(att)
  const box = cell ?? fitMediaBox(att.w, att.h)
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

  // `att.thumb` is whatever the sending client wrote into the event. It is
  // meant to be a tiny inline WebP; a remote URL there would turn opening a
  // conversation into a callback to someone else's server (`img-src https:` is
  // in the CSP), so anything but a data: URI is dropped.
  const thumbSrc = safeThumbSrc(att.thumb)
  const thumbLayer = thumbSrc ? (
    <img
      src={thumbSrc}
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
        {media.phase !== 'expired' && (
          <video
            src={media.src}
            controls
            preload="metadata"
            aria-label={att.name}
            onError={media.onError}
            onLoadedMetadata={media.onLoad}
            // Hidden rather than unmounted while a retry is in flight: the
            // element that keeps its place is the one whose `src` swap is a
            // new request, and a broken <video> paints its own error chrome.
            style={{ ...fill, background: 'transparent', opacity: media.phase === 'retrying' ? 0 : 1 }}
          />
        )}
        {media.phase === 'retrying' && <WarmingUp />}
        {media.phase === 'expired' && <CleanedUp />}
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
      {media.phase !== 'expired' &&
        (isVideo ? (
          <video
            src={media.src}
            muted
            preload="metadata"
            onError={media.onError}
            onLoadedMetadata={media.onLoad}
            style={{ ...fill, opacity: media.phase === 'retrying' ? 0 : 1 }}
          />
        ) : (
          <img
            src={media.src}
            alt={att.name}
            draggable={false}
            onError={media.onError}
            onLoad={media.onLoad}
            style={{ ...fill, opacity: media.phase === 'retrying' ? 0 : 1 }}
          />
        ))}
      {media.phase === 'retrying' && <WarmingUp />}
      {media.phase === 'expired' && <CleanedUp />}
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

/** Honest fallback while the sfblob service is not streaming yet — and while a retry is pending. */
export function WarmingUp() {
  return (
    <span
      className="sem-shimmer"
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: 8,
        pointerEvents: 'none',
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

/**
 * The blob is gone: main answered 404, which it now says only for a file the
 * media sweep actually took — never for a share it could not reach.
 */
export function CleanedUp() {
  return (
    <span
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-raised)',
        color: 'var(--text-3)',
        fontSize: 12,
        padding: 12,
        textAlign: 'center',
        pointerEvents: 'none',
      }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>
        🧹
      </span>
      this file was cleaned up by retention
    </span>
  )
}
