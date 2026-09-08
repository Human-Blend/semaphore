import { useMemo } from 'react'
import type { MessageView } from '@shared/merge'
import type { Attachment, BodyEntity, ConvId } from '@shared/types'
import { isMediaAttachment, segmentMessage } from './parse'
import { CodeBlock } from './CodeBlock'
import { LinkCard } from './LinkCard'
import { MediaAttachment } from './MediaAttachment'
import { FileTile } from './FileTile'
import './content.css'

// The message-body dispatcher (spec §4). Text with linkified URLs, mention
// pills and inline code chips; full code blocks; GIFs; media boxes; file
// tiles; link preview cards. Body text is always selectable.

export function MessageBody({ view }: { view: MessageView }) {
  if (view.deleted) {
    return (
      <em style={{ color: 'var(--text-3)', fontSize: 15, lineHeight: '22px' }}>message deleted</em>
    )
  }

  const media = view.attachments.filter(isMediaAttachment)
  const files = view.attachments.filter((a) => !isMediaAttachment(a))
  const gifUrl =
    view.body.kind === 'gif' && /^https?:\/\//i.test(view.body.text.trim())
      ? view.body.text.trim()
      : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, alignItems: 'flex-start' }}>
      {view.body.kind === 'code' ? (
        <div style={{ alignSelf: 'stretch', minWidth: 0 }}>
          <CodeBlock text={view.body.text} lang={view.body.lang ?? null} />
        </div>
      ) : view.body.kind === 'gif' ? (
        gifUrl ? (
          <RemoteGif url={gifUrl} />
        ) : media.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
            GIF unavailable
          </span>
        ) : null
      ) : view.body.text ? (
        <TextBody text={view.body.text} entities={view.body.entities} />
      ) : null}

      {media.length > 0 && <MediaGroup media={media} conv={view.conv} eventId={view.id} />}
      {files.map((att) => (
        <FileTile key={att.blobId} att={att} />
      ))}
      {view.linkPreview && <LinkCard preview={view.linkPreview} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function TextBody({ text, entities }: { text: string; entities?: BodyEntity[] }) {
  const parts = useMemo(() => segmentMessage(text, entities), [text, entities])
  return (
    <div
      style={{
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        userSelect: 'text',
        fontSize: 15,
        lineHeight: '22px',
        color: 'var(--text-1)',
        maxWidth: '72ch',
        cursor: 'text',
      }}
    >
      {parts.map((p, i) => {
        switch (p.kind) {
          case 'link':
            return (
              <a
                key={i}
                className="sem-link"
                href={p.url}
                title={`Open ${p.url}`}
                onClick={(e) => {
                  e.preventDefault()
                  void window.bridge.app.openExternal(p.url).catch(() => {})
                }}
              >
                {p.text}
              </a>
            )
          case 'code':
            return (
              <code
                key={i}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.875em',
                  background: 'var(--bg-raised)',
                  color: 'var(--accent-text)',
                  borderRadius: 4,
                  padding: '1px 4px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {p.text}
              </code>
            )
          case 'mention':
            return (
              <span
                key={i}
                title={
                  p.special === 'here'
                    ? 'Notifies everyone currently online'
                    : p.device
                      ? `Mentions device ${p.device.slice(0, 8)}`
                      : 'Mention'
                }
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-text)',
                  borderRadius: 'var(--r-xs)',
                  padding: '0 3px',
                  fontWeight: 500,
                }}
              >
                {p.text}
              </span>
            )
          default:
            return <span key={i}>{p.text}</span>
        }
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** GIF sent as a plain URL (picker result / pasted). Autoplays by nature. */
function RemoteGif({ url }: { url: string }) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden',
        background: 'var(--bg-raised)',
        maxWidth: 420,
      }}
    >
      <img
        src={url}
        alt="GIF"
        draggable={false}
        style={{ display: 'block', maxWidth: '100%', maxHeight: 320, minWidth: 120, minHeight: 80 }}
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 6,
          left: 6,
          padding: '1px 6px',
          borderRadius: 'var(--r-full)',
          background: 'rgba(0, 0, 0, 0.55)',
          color: '#fff',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: '16px',
          fontWeight: 500,
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        GIF
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------

/** 1 → natural box; 2–4 → 2-col grid; 5+ → 2×2 with a "+N" scrim tile. */
function MediaGroup({
  media,
  conv,
  eventId,
}: {
  media: Attachment[]
  conv: ConvId
  eventId: string
}) {
  if (media.length === 1) {
    return <MediaAttachment att={media[0]} conv={conv} eventId={eventId} />
  }
  const visible = media.slice(0, 4)
  const overflow = media.length - 4
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 206px)',
        gap: 4,
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        maxWidth: '100%',
      }}
    >
      {visible.map((att, i) => (
        <MediaAttachment
          key={att.blobId}
          att={att}
          conv={conv}
          eventId={eventId}
          cell={{ w: 206, h: 140 }}
          overflowCount={i === 3 && overflow > 0 ? overflow : undefined}
        />
      ))}
    </div>
  )
}
