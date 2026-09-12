import { useEffect, useMemo, useState } from 'react'
import type { MessageView } from '@shared/merge'
import type { PollBody } from '@shared/types'
import { pollQuestionFor } from '@shared/poll'
import { useStore, selfOf } from '@/store'
import { toast } from '@/app/toasts'
import { closesInLabel, countdownTickMs, decisionOutcome, nextChoice, tallyPoll, voterLine } from './polls'

// The poll message tile: the question, one row per option with its bar, count
// and share of the voters, and — for the author — the button that closes it.
//
// Everything it draws comes from events already in the store: the poll body
// rides in the message, and every vote is a `vot` event in the same log. A
// click publishes one `vot` and nothing else; the row moves when the event
// comes back through the store, which is also how a peer's vote arrives.

export function PollTile({ view }: { view: MessageView }) {
  const poll = view.body.poll
  const boot = useStore((s) => s.boot)
  const presence = useStore((s) => s.presence)
  const self = selfOf(boot)
  const me = self?.deviceId ?? ''
  const [busy, setBusy] = useState(false)
  /**
   * `closesAt` is share time (main restates what the author picked —
   * `calibrateClosesAt`), so "is it closed?" has to be asked in share time too.
   * On the local wall clock a machine an hour fast closed every timed poll an
   * hour early, for that person only, and main then refused the votes everybody
   * else could still cast. The offset rides the `health` push; 0 until one lands,
   * which is exactly the old behaviour.
   */
  const offsetMs = useStore((s) => s.health.offsetMs ?? 0)
  const [now, setNow] = useState(() => Date.now() + offsetMs)

  // Only a poll with a live deadline ticks, and only as fast as its own
  // countdown line can change (once a second in the last minute).
  const tick = poll ? countdownTickMs(poll, now) : 0
  useEffect(() => {
    setNow(Date.now() + offsetMs)
    if (tick === 0) return
    const t = window.setInterval(() => setNow(Date.now() + offsetMs), tick)
    return () => window.clearInterval(t)
  }, [offsetMs, tick])

  const nameOf = useMemo(() => {
    const names = new Map<string, string>()
    for (const p of presence) names.set(p.deviceId, p.name)
    if (self) names.set(self.deviceId, self.displayName)
    return (device: string): string => names.get(device) ?? device.slice(0, 8)
  }, [presence, self])

  const result = useMemo(
    () => (poll ? tallyPoll(poll, view.votes, { now, me }) : null),
    [poll, view.votes, now, me],
  )

  if (!poll || !result) {
    // A poll body that did not survive the trip (truncated, or hand-made).
    return (
      <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
        📊 {pollQuestionFor(view.body)} — this poll arrived without its options
      </span>
    )
  }

  const decided = decisionOutcome(poll, result)
  const countdown = closesInLabel(poll, now)
  const isAuthor = me !== '' && view.authorDevice === me
  /** Ties the option group to the question it answers (`aria-labelledby`). */
  const questionId = `sem-poll-q-${view.id}`

  async function castVote(optionId: string): Promise<void> {
    if (!poll || result?.closed || busy) return
    const choice = nextChoice(poll, result?.myChoice ?? [], optionId)
    setBusy(true)
    try {
      await window.bridge.chat.vote(view.conv, view.id, choice)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(
        msg.includes('poll-closed')
          ? 'That poll is closed now'
          : msg.includes('queued') || msg.includes('ENOENT')
            ? 'Could not record that vote — the team folder may be unreachable'
            : 'Could not record that vote',
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  async function close(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await window.bridge.chat.closePoll(view.conv, view.id)
      toast('Poll closed', 'success')
    } catch {
      toast('Could not close that poll — the team folder may be unreachable', 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        width: 420,
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: '12px 14px 10px',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-raised)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 13 }}>
          📊
        </span>
        <span
          id={questionId}
          style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-1)', lineHeight: '19px' }}
        >
          {poll.question}
        </span>
      </div>

      {/* The rows are the answers to one question: grouped and labelled by it,
          so a screen reader announces "Ship on Friday?, group" before reading
          options that would otherwise be loose buttons in a message. */}
      <div role="group" aria-labelledby={questionId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {result.options.map((o) => (
          <OptionRow
            key={o.id}
            option={o}
            poll={poll}
            closed={result.closed}
            busy={busy}
            voted={result.myChoice.length > 0}
            names={poll.anonymous ? null : o.voters.map(nameOf)}
            onPick={() => void castVote(o.id)}
          />
        ))}
      </div>

      {decided && result.closed && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: decided.decided ? 'var(--accent-text)' : 'var(--text-2)',
          }}
        >
          {decided.label}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-3)', flexWrap: 'wrap' }}>
        <span>{voterLine(result)}</span>
        {poll.multi && !result.closed && <span>· pick as many as you like</span>}
        {poll.anonymous && <span title="Names are hidden here — every vote is still a signed event on the share">· anonymous</span>}
        {countdown && !result.closed && <span>· {countdown}</span>}
        <span style={{ flex: 1 }} />
        {isAuthor && !result.closed && (
          <button onClick={() => void close()} disabled={busy} style={linkBtn} title="Close this poll for everyone">
            Close poll
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: 'var(--accent-text)',
  fontSize: 11,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
}

function OptionRow({
  option,
  poll,
  closed,
  busy,
  voted,
  names,
  onPick,
}: {
  option: { id: string; text: string; count: number; percent: number; mine: boolean; leading: boolean }
  poll: PollBody
  closed: boolean
  busy: boolean
  voted: boolean
  /** null when the poll is anonymous. */
  names: string[] | null
  onPick: () => void
}) {
  // Before anyone has voted the bar would be a full-width slab behind every
  // row; a poll nobody has answered should look empty, not unanimous.
  const fill = option.count === 0 ? 0 : Math.max(4, option.percent)
  const title = closed
    ? 'This poll is closed'
    : option.mine
      ? poll.multi
        ? 'Click to take this pick back'
        : 'Click to take your vote back'
      : `Vote for “${option.text}”`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <button
        type="button"
        className="sem-focus"
        aria-pressed={option.mine}
        // `aria-disabled`, not `disabled`: a closed poll is a *result*, and a
        // disabled button is skipped by the keyboard and by a screen reader —
        // which made the outcome of every finished poll unreadable to anyone not
        // using a mouse. The click is refused by `castVote` (and here) instead.
        aria-disabled={closed || busy}
        onClick={() => {
          if (closed || busy) return
          onPick()
        }}
        title={title}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 30,
          padding: '5px 10px',
          textAlign: 'left',
          borderRadius: 'var(--r-sm)',
          border: `1px solid ${option.mine ? 'var(--accent)' : 'var(--border-subtle)'}`,
          background: 'var(--bg-panel)',
          color: 'var(--text-1)',
          fontSize: 13,
          fontFamily: 'var(--font-ui)',
          cursor: closed ? 'default' : 'pointer',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: `${fill}%`,
            background: option.mine
              ? 'var(--accent-soft)'
              : option.leading && (closed || voted)
                ? 'color-mix(in srgb, var(--accent-soft) 60%, transparent)'
                : 'var(--bg-raised)',
            transition: 'width var(--t-base) var(--ease-glide)',
            pointerEvents: 'none',
          }}
        />
        <span style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {option.mine && <span aria-hidden>✓ </span>}
          {option.text}
        </span>
        <span style={{ position: 'relative', fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
          {option.count} · {option.percent}%
        </span>
      </button>
      {names && names.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-3)',
            paddingLeft: 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={names.join(', ')}
        >
          {names.join(', ')}
        </div>
      )}
    </div>
  )
}
