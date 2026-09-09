import type { MouseEvent } from 'react'
import type { LinkPreview } from '@shared/types'
import { middleTruncate } from './parse'
import { CopyIcon, ExternalIcon, GlobeIcon, InfoIcon } from './icons'
import './content.css'

// Spec §4.3 — Apple-Messages-style link preview cards. Previews are fetched
// once by the sender and embedded encrypted; a failed fetch renders an honest
// degraded card, never fake data.

function openUrl(url: string): void {
  void window.bridge.app.openExternal(url).catch(() => {})
}

function copyUrl(url: string): void {
  void window.bridge.app.copyText(url).catch(() => {})
}

function HoverActions({ url }: { url: string }) {
  const stop = (e: MouseEvent, fn: () => void): void => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }
  return (
    <div
      className="sem-reveal"
      style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}
    >
      <button
        className="sem-scrim-btn"
        title="Copy link"
        aria-label="Copy link"
        onClick={(e) => stop(e, () => copyUrl(url))}
      >
        <CopyIcon size={14} />
      </button>
      <button
        className="sem-scrim-btn"
        title="Open in browser"
        aria-label="Open in browser"
        onClick={(e) => stop(e, () => openUrl(url))}
      >
        <ExternalIcon size={14} />
      </button>
    </div>
  )
}

export function LinkCard({ preview }: { preview: LinkPreview }) {
  if (preview.failed) return <DegradedCard preview={preview} />
  return <FullCard preview={preview} />
}

function FullCard({ preview }: { preview: LinkPreview }) {
  return (
    <div
      className="sem-reveal-host"
      role="link"
      tabIndex={0}
      title={preview.url}
      aria-label={`Open link: ${preview.title ?? preview.url}`}
      onClick={() => openUrl(preview.url)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openUrl(preview.url)
      }}
      style={{
        position: 'relative',
        // Fixed width: the footer swaps domain ↔ full URL on hover, and a
        // shrink-to-fit card would jump; also keeps the hover actions clear
        // of a short title.
        width: 360,
        maxWidth: '100%',
        boxSizing: 'border-box',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-panel)',
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {preview.img && (
        <img
          src={preview.img}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            display: 'block',
            width: '100%',
            height: 180,
            objectFit: 'cover',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        />
      )}
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {preview.title && (
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: '18px',
              color: 'var(--text-1)',
              paddingRight: preview.img ? 0 : 68, // hover actions sit here when no image
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {preview.title}
          </div>
        )}
        {preview.desc && (
          <div
            style={{
              fontSize: 12,
              lineHeight: '16px',
              color: 'var(--text-3)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {preview.desc}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            marginTop: 2,
            color: 'var(--text-3)',
          }}
        >
          <GlobeIcon size={12} />
          <span
            className="sem-linkcard-domain"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            {preview.domain}
          </span>
          <span
            className="sem-linkcard-url"
            style={{
              fontSize: 11,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {preview.url}
          </span>
        </div>
      </div>
      <HoverActions url={preview.url} />
    </div>
  )
}

// Say what actually happened: a blocked network is the common case on the
// target LAN, but a dead link or a page without metadata is not the network's
// fault.
const DEGRADED: Record<NonNullable<LinkPreview['reason']>, { line: string; why: string }> = {
  network: {
    line: 'Preview unavailable — network restricted',
    why: 'This network blocks external requests. The link still opens in your browser.',
  },
  http: {
    line: 'Preview unavailable — the page returned an error',
    why: 'The site answered with an error status (e.g. 404). The link may be dead or private.',
  },
  nometa: {
    line: 'No preview for this page',
    why: 'The page has no title or preview image to show.',
  },
}

function DegradedCard({ preview }: { preview: LinkPreview }) {
  // A newer sender may ship a reason this build doesn't know; fall back to
  // the generic line instead of crashing the row.
  const degraded = DEGRADED[preview.reason ?? 'network'] ?? DEGRADED.network
  return (
    <div
      className="sem-reveal-host"
      role="link"
      tabIndex={0}
      title={preview.url}
      aria-label={`Open link: ${preview.url}`}
      onClick={() => openUrl(preview.url)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openUrl(preview.url)
      }}
      style={{
        position: 'relative',
        maxWidth: 360,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 10px',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-panel)',
        cursor: 'pointer',
        userSelect: 'none',
        boxSizing: 'border-box',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--r-sm)',
          background: 'var(--bg-raised)',
          color: 'var(--text-3)',
        }}
      >
        <GlobeIcon size={16} />
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
          {middleTruncate(preview.url, 40)}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--text-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {degraded.line}
          <span
            title={degraded.why}
            aria-label="Why is there no preview?"
            style={{ display: 'inline-flex', cursor: 'help' }}
          >
            <InfoIcon size={12} />
          </span>
        </span>
      </span>
      <HoverActions url={preview.url} />
    </div>
  )
}
