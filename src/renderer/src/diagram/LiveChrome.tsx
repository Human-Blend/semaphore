import { useEffect, useRef } from 'react'
import { Button, Spinner } from '@/ui/atoms'
import { trapTabWithin } from '@/app/ChannelMenu'
import type { LiveBoard } from './useLiveBoard'

// The live board's chrome: one pill in the editor header, and the banner that
// replaces it once the host ends the session. Its own module so the header in
// DiagramEditor stays a single line — that file is shared with the fullscreen
// work, and a 60-line pill inlined there is a merge conflict waiting to happen.

const pillBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 10px',
  flexShrink: 0,
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * `Start live session` → the pill → nothing (once it has ended, the banner
 * below the header does the talking). Read-only viewers never see any of it:
 * a board you cannot draw on is not one you can host.
 */
export function LiveControls({
  live,
  viewOnly,
  suppressStart,
}: {
  live: LiveBoard
  viewOnly: boolean
  /** While the "host ended it" banner is up: one message at a time. */
  suppressStart?: boolean
}) {
  if (viewOnly) return null

  if (!live.session) {
    if (suppressStart) return null
    return (
      <button
        onClick={live.start}
        disabled={live.busy !== null}
        title="Open this drawing as a live board — everyone in the conversation can join and draw with you"
        style={{
          ...pillBtn,
          border: '1px solid var(--border-strong)',
          background: 'var(--bg-raised)',
          color: 'var(--text-1)',
          opacity: live.busy !== null ? 0.6 : 1,
        }}
      >
        {live.busy === 'starting' || live.busy === 'joining' ? <Spinner size={11} /> : <Dot color="var(--success)" />}
        {live.busy === 'joining' ? 'Joining…' : 'Start live session'}
      </button>
    )
  }

  const names = live.participants.map((p) => p.name)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span
        // A status, not decoration: the pill is the only place the app says who
        // is on the board, and it changes while the person is drawing — a screen
        // reader has to be told without stealing the focus from the canvas.
        role="status"
        title={
          names.length
            ? `Live board · drawing with ${names.join(', ')}`
            : 'Live board · nobody else is here yet — share the link from the conversation'
        }
        aria-label={
          names.length
            ? `Live board, drawing with ${names.join(', ')}`
            : 'Live board, nobody else has joined yet'
        }
        style={{
          ...pillBtn,
          cursor: 'default',
          border: '1px solid color-mix(in srgb, var(--success) 55%, transparent)',
          background: 'color-mix(in srgb, var(--success) 14%, transparent)',
          color: 'var(--text-1)',
          minWidth: 0,
        }}
      >
        <Dot color="var(--success)" pulse />
        Live
        {live.participants.length > 0 && (
          <>
            <span aria-hidden style={{ color: 'var(--text-3)' }}>
              ·
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {live.participants.slice(0, 3).map((p) => (
                <span
                  key={p.device}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, fontWeight: 500 }}
                >
                  <Dot color={p.color.background} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>
                    {p.name}
                  </span>
                </span>
              ))}
              {live.participants.length > 3 && (
                <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>+{live.participants.length - 3}</span>
              )}
            </span>
          </>
        )}
      </span>
      {live.session.isHost && (
        <button
          onClick={() => void live.end()}
          disabled={live.busy !== null}
          title="End the live board for everyone (the drawing stays here)"
          style={{
            ...pillBtn,
            border: '1px solid var(--border-strong)',
            background: 'var(--bg-raised)',
            color: 'var(--text-2)',
            opacity: live.busy !== null ? 0.6 : 1,
          }}
        >
          {live.busy === 'ending' ? <Spinner size={11} /> : null}
          End session
        </button>
      )}
    </span>
  )
}

/** Shown once the host ends it: the canvas is still yours, it just stopped travelling. */
export function LiveEndedBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'color-mix(in srgb, var(--warning) 12%, var(--bg-panel))',
        color: 'var(--text-2)',
        fontSize: 12.5,
      }}
    >
      <span aria-hidden>⏹</span>
      The host ended this live board. Your copy is still here — keep drawing, export it, or send it to the conversation.
      <span style={{ flex: 1 }} />
      <button
        onClick={onDismiss}
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          color: 'var(--accent-text)',
          fontSize: 12.5,
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  )
}

/**
 * The host closing the editor on a running board. Three outcomes, so this
 * cannot be a `ConfirmDialog`: end it for everyone, leave it running without
 * me, or stay. Esc and the backdrop mean *stay* — the least destructive of the
 * three, and the only one that is undoable by doing nothing.
 */
export function LiveCloseDialog({
  participants,
  busy,
  onEnd,
  onLeave,
  onCancel,
}: {
  participants: number
  busy: boolean
  onEnd: () => void
  onLeave: () => void
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  return (
    <div
      onClick={onCancel}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-label="End the live board for everyone?"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapTabWithin(dialogRef.current, e)}
        style={{
          width: 430,
          maxWidth: 'calc(100vw - 48px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div style={{ padding: '16px 20px 8px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>End the live board for everyone?</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, lineHeight: '18px' }}>
            {participants > 0
              ? `${participants} other ${participants === 1 ? 'person is' : 'people are'} on this board right now. `
              : ''}
            Ending it closes the session for everybody and removes it from the folder. Keeping it running just takes you
            out — anyone can carry on, and you can rejoin from the conversation.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '14px 20px 18px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={onLeave}>
            Keep it running
          </Button>
          <Button variant="danger" disabled={busy} onClick={onEnd}>
            End for everyone
          </Button>
        </div>
      </div>
    </div>
  )
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        // `sem-pulse` is a keyframe in styles/base.css, not a class — same use
        // as the screen-share "recording" dot.
        animation: pulse ? 'sem-pulse 1.6s ease-in-out infinite' : undefined,
      }}
    />
  )
}
