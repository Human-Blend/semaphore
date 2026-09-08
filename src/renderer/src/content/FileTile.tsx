import { useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { formatBytes } from '@/ui/atoms'
import { extOf, fileKindOf, middleTruncate } from './parse'
import { DownloadIcon } from './icons'
import './content.css'

// Spec §4.2 — non-media file tiles: 360×64 card, 40px type-tinted icon with a
// 3-letter extension overlay, middle-truncated name, size meta, hover Download.
// Tiles drag out to the OS via the main process (native file drag).

export function FileTile({ att }: { att: Attachment }) {
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kind = fileKindOf(att.name, att.mime)

  const flashNote = (text: string): void => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 2600)
  }

  const download = (): void => {
    window.bridge.files.saveBlobAs(att.blobId, att.name).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not-implemented')) flashNote('File service lands in the next build')
      else flashNote('Could not save — the share may be unreachable')
    })
  }

  return (
    <div
      className="sem-reveal-host"
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        void window.bridge.files.startDrag(att.blobId, att.name).catch(() => {})
      }}
      title={`${att.name} · ${formatBytes(att.size)}`}
      style={{
        width: 360,
        maxWidth: '100%',
        height: 64,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 12px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-panel)',
        boxSizing: 'border-box',
        userSelect: 'none',
      }}
    >
      {/* Type icon */}
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--r-md)',
          background: kind.tint,
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}
      >
        {kind.family === 'code' ? '{ }' : extOf(att.name)}
      </span>

      {/* Name + meta */}
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-1)',
            whiteSpace: 'nowrap',
          }}
        >
          {middleTruncate(att.name, 34)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: note ? 'var(--warning)' : 'var(--text-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {note ?? formatBytes(att.size)}
        </span>
      </span>

      {/* Hover action */}
      <button
        className="sem-reveal"
        onClick={download}
        title={`Download ${att.name}`}
        aria-label={`Download ${att.name}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 28,
          padding: '0 10px',
          flexShrink: 0,
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--bg-raised)',
          color: 'var(--text-1)',
          fontSize: 12,
          fontWeight: 500,
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        <DownloadIcon size={13} />
        Download
      </button>
    </div>
  )
}
