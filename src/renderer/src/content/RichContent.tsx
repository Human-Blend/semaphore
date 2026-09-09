import { useMemo, useState } from 'react'
import type { MessageView } from '@shared/merge'
import type { Attachment, BodyEntity, ConvId } from '@shared/types'
import { isMediaAttachment, sameUrl, segmentMessage } from './parse'
import { LinkIcon } from './icons'
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
  // The card carries the link, so the raw URL leaves the prose: a message
  // that is only the URL shows just the card; inside a sentence it becomes a
  // domain chip (full URL on hover).
  const previewUrl = view.linkPreview?.url ?? null
  const textIsOnlyLink =
    previewUrl !== null && view.body.kind === 'text' && bodyIsJustLink(view.body.text, view.body.entities, previewUrl)
  // A pack GIF travels as its pack id, not bytes: every client has the same
  // bundled pack, so this costs zero share I/O. Remote (searched) GIFs travel
  // as an https URL.
  const gifUrl =
    view.body.kind === 'gif'
      ? view.body.packId
        ? `sfgif://pack/${view.body.packId}.gif`
        : /^(https?|sfgif):\/\//i.test(view.body.text.trim())
          ? view.body.text.trim()
          : null
      : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, alignItems: 'flex-start' }}>
      {view.body.kind === 'code' ? (
        <div style={{ alignSelf: 'stretch', minWidth: 0 }}>
          <CodeBlock text={view.body.text} lang={view.body.lang ?? null} />
        </div>
      ) : view.body.kind === 'gif' ? (
        gifUrl ? (
          <RemoteGif url={gifUrl} compact={!!view.body.packId} />
        ) : media.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
            GIF unavailable
          </span>
        ) : null
      ) : view.body.text && !textIsOnlyLink ? (
        <TextBody text={view.body.text} entities={view.body.entities} previewUrl={previewUrl} />
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

function bodyIsJustLink(text: string, entities: BodyEntity[] | undefined, url: string): boolean {
  const parts = segmentMessage(text, entities)
  return parts.every((p) => (p.kind === 'link' ? sameUrl(p.url, url) : p.kind === 'text' && p.text.trim() === ''))
}

function TextBody({
  text,
  entities,
  previewUrl,
}: {
  text: string
  entities?: BodyEntity[]
  previewUrl: string | null
}) {
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
          case 'link': {
            const chip = previewUrl !== null && sameUrl(p.url, previewUrl)
            return (
              <a
                key={i}
                className={chip ? 'sem-link sem-link-chip' : 'sem-link'}
                href={p.url}
                title={chip ? p.url : `Open ${p.url}`}
                onClick={(e) => {
                  e.preventDefault()
                  void window.bridge.app.openExternal(p.url).catch(() => {})
                }}
              >
                {chip ? (
                  <>
                    <LinkIcon size={11} />
                    {domainOf(p.url)}
                  </>
                ) : (
                  p.text
                )}
              </a>
            )
          }
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

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------

/** GIF sent as a plain URL (picker result / pasted). Autoplays by nature. */
function RemoteGif({ url, compact }: { url: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    // A pack id this client's bundled pack doesn't carry (older/newer build),
    // or a remote GIF this network blocks. Say so instead of showing a void.
    return (
      <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
        GIF unavailable on this machine
      </span>
    )
  }
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        maxWidth: compact ? 160 : 420,
        background: compact ? 'transparent' : 'var(--bg-raised)',
        border: compact ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <img
        src={url}
        alt="GIF"
        draggable={false}
        onError={() => setFailed(true)}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: compact ? 160 : 320,
          minWidth: compact ? 0 : 120,
          minHeight: compact ? 0 : 80,
        }}
      />
      {!compact && (
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
      )}
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
