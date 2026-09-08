import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import type { ConvId } from '@shared/types'
import type { MaterializedLog, MessageView, SysView } from '@shared/merge'
import { useStore } from '@/store'
import { formatDayDivider, formatTime } from '@/ui/atoms'
import { MessageRow } from './MessageRow'
import { dayKeyOf, hlcMsOf, sysLine, type ChipData } from './util'

// Virtualized message area: day dividers, unread divider, system rows,
// grouped flat rows, jump-to-latest pill, DM read receipts, markRead.

type Item =
  | { kind: 'msg'; key: string; m: MessageView; groupStart: boolean; pop: boolean }
  | { kind: 'sys'; key: string; s: SysView }
  | { kind: 'day'; key: string; ms: number }
  | { kind: 'unread'; key: string }

const GROUP_WINDOW_MS = 5 * 60_000

const ListHeader = () => <div style={{ height: 12 }} />
const ListFooter = () => <div style={{ height: 10 }} />

interface Props {
  conv: ConvId
  log: MaterializedLog
  loaded: boolean
  selfId: string
  anchorRead: string
  label: string
  editingId: string | null
  chipOf: (device: string) => ChipData
  nameOf: (device: string) => string
  getMessage: (id: string) => MessageView | undefined
  onReply: (id: string) => void
  onEditStart: (id: string) => void
  onEditDone: () => void
  onSeed: (text: string) => void
}

export function MessageList({
  conv,
  log,
  loaded,
  selfId,
  anchorRead,
  label,
  editingId,
  chipOf,
  nameOf,
  getMessage,
  onReply,
  onEditStart,
  onEditDone,
  onSeed,
}: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const leftAtRef = useRef<string | null>(null)

  const items = useMemo<Item[]>(() => {
    const stream: ({ t: 'm'; v: MessageView } | { t: 's'; v: SysView })[] = [
      ...log.messages.map((v) => ({ t: 'm' as const, v })),
      ...log.sys.map((v) => ({ t: 's' as const, v })),
    ].sort((a, b) => (a.v.id < b.v.id ? -1 : 1))

    const fresh = initializedRef.current
    const seen = seenRef.current
    const next: Item[] = []
    let lastDay = ''
    let prevMsg: MessageView | null = null
    let unreadPlaced = false

    for (const entry of stream) {
      const day = dayKeyOf(entry.v.hlcMs)
      if (day !== lastDay) {
        next.push({ kind: 'day', key: `day-${day}`, ms: entry.v.hlcMs })
        lastDay = day
        prevMsg = null
      }
      if (entry.t === 's') {
        next.push({ kind: 'sys', key: entry.v.id, s: entry.v })
        prevMsg = null
        continue
      }
      const m = entry.v
      if (!unreadPlaced && anchorRead !== '' && m.id > anchorRead && m.authorDevice !== selfId) {
        next.push({ kind: 'unread', key: 'unread' })
        prevMsg = null
        unreadPlaced = true
      }
      // Unverified messages always start a group so the warning badge and
      // identity chip are visible right where the doubt is.
      const groupStart =
        !prevMsg ||
        prevMsg.authorDevice !== m.authorDevice ||
        m.hlcMs - prevMsg.hlcMs > GROUP_WINDOW_MS ||
        m.verified === false
      const pop = fresh && !seen.has(m.id) && m.authorDevice === selfId
      next.push({ kind: 'msg', key: m.id, m, groupStart, pop })
      prevMsg = m
    }

    if (loaded) {
      seenRef.current = new Set(log.messages.map((m) => m.id))
      initializedRef.current = true
    }
    return next
  }, [log, selfId, anchorRead, loaded])

  const newestId = log.messages.length > 0 ? log.messages[log.messages.length - 1].id : null

  // DM read receipt for my newest message.
  const cursors = useStore((s) => s.cursors[conv])
  const receiptFor = useMemo(() => {
    if (!conv.startsWith('dm:') || !cursors) return null
    const peer = Object.keys(cursors).find((d) => d !== selfId)
    if (!peer) return null
    const cur = cursors[peer]
    let mineNewest: MessageView | null = null
    for (let i = log.messages.length - 1; i >= 0; i--) {
      const m = log.messages[i]
      if (m.authorDevice === selfId) {
        mineNewest = m
        break
      }
    }
    if (!mineNewest || mineNewest.deleted) return null
    if (cur.read && cur.read >= mineNewest.id)
      return { id: mineNewest.id, text: `Read ${formatTime(hlcMsOf(cur.read))}` }
    if (cur.ingested && cur.ingested >= mineNewest.id) return { id: mineNewest.id, text: 'Delivered' }
    return null
  }, [conv, cursors, log, selfId])

  // Mark read while parked at the bottom with app focus.
  useEffect(() => {
    if (!newestId) return
    const mark = (): void => {
      if (atBottomRef.current && document.hasFocus()) useStore.getState().markRead(conv, newestId)
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [conv, newestId, atBottom])

  // Track where we left the bottom, for the jump pill count.
  useEffect(() => {
    atBottomRef.current = atBottom
    if (atBottom) leftAtRef.current = null
    else if (leftAtRef.current === null) leftAtRef.current = newestId ?? ''
  }, [atBottom, newestId])

  const newCount = useMemo(() => {
    if (atBottom || leftAtRef.current === null) return 0
    const from = leftAtRef.current
    let n = 0
    for (let i = log.messages.length - 1; i >= 0; i--) {
      const m = log.messages[i]
      if (m.id <= from) break
      if (m.authorDevice !== selfId) n++
    }
    return n
  }, [atBottom, log, selfId])

  const renderItem = useCallback(
    (_index: number, it: Item) => {
      switch (it.kind) {
        case 'day':
          return <DayDivider ms={it.ms} />
        case 'unread':
          return <UnreadDivider />
        case 'sys':
          return <SysRow line={sysLine(it.s, nameOf)} />
        case 'msg':
          return (
            <MessageRow
              conv={conv}
              m={it.m}
              groupStart={it.groupStart}
              pop={it.pop}
              selfId={selfId}
              chip={chipOf(it.m.authorDevice)}
              receipt={receiptFor && receiptFor.id === it.m.id ? receiptFor.text : null}
              isEditing={editingId === it.m.id}
              getMessage={getMessage}
              nameOf={nameOf}
              onReply={onReply}
              onEditStart={onEditStart}
              onEditDone={onEditDone}
            />
          )
      }
    },
    [conv, selfId, chipOf, nameOf, getMessage, onReply, onEditStart, onEditDone, editingId, receiptFor],
  )

  if (!loaded && items.length === 0) return <SkeletonRows />
  if (loaded && items.length === 0) return <EmptyState conv={conv} label={label} onSeed={onSeed} />

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Virtuoso<Item>
        ref={virtuosoRef}
        style={{ height: '100%' }}
        data={items}
        computeItemKey={(_i, it) => it.key}
        itemContent={renderItem}
        followOutput="smooth"
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        atBottomStateChange={(b) => {
          atBottomRef.current = b
          setAtBottom(b)
        }}
        increaseViewportBy={{ top: 600, bottom: 200 }}
        components={{ Header: ListHeader, Footer: ListFooter }}
      />
      {newCount > 0 && (
        <button
          className="sem-jump"
          title="Jump to the latest messages"
          aria-label={`Jump to ${newCount} new message${newCount > 1 ? 's' : ''}`}
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' })
          }
          style={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 'var(--r-full)',
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            boxShadow: 'var(--elev-2)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          ↓ {newCount} new message{newCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function DayDivider({ ms }: { ms: number }) {
  return (
    <div style={{ position: 'relative', textAlign: 'center', padding: '14px 0 4px', userSelect: 'none' }}>
      <div
        aria-hidden
        style={{ position: 'absolute', left: 16, right: 16, top: 'calc(50% + 5px)', height: 1, background: 'var(--border-subtle)' }}
      />
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-2)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-full)',
          padding: '3px 10px',
        }}
      >
        {formatDayDivider(ms)}
      </span>
    </div>
  )
}

function UnreadDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px 4px', userSelect: 'none' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--accent)' }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-text)', letterSpacing: '0.08em' }}>NEW</span>
    </div>
  )
}

function SysRow({ line }: { line: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '4px 24px', fontSize: 12, color: 'var(--text-3)' }}>{line}</div>
  )
}

function SkeletonRows() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', padding: '16px 16px 0' }} aria-label="Loading messages">
      {[72, 44, 58, 36, 64, 50].map((w, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 22 }}>
          <div className="sem-skel" style={{ width: 36, height: 36, borderRadius: 'var(--r-md)', flexShrink: 0 }} />
          <div style={{ flex: 1, paddingTop: 2 }}>
            <div className="sem-skel" style={{ width: '22%', height: 12, borderRadius: 4, marginBottom: 8 }} />
            <div className="sem-skel" style={{ width: `${w}%`, height: 12, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ conv, label, onSeed }: { conv: ConvId; label: string; onSeed: (text: string) => void }) {
  const isDm = conv.startsWith('dm:')
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        textAlign: 'center',
        padding: '0 32px',
        userSelect: 'none',
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-1)' }}>
        This is the very beginning of {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
        {isDm
          ? 'Messages here are end-to-end encrypted; beams go device-to-device.'
          : 'Every message here is encrypted on the shared folder.'}
      </div>
      <button
        className="sem-hello"
        title="Pre-fill the composer with a greeting"
        onClick={() => onSeed('Hello team! \u{1F44B}')}
        style={{
          marginTop: 8,
          padding: '6px 14px',
          borderRadius: 'var(--r-full)',
          border: '1px solid var(--border-strong)',
          background: 'transparent',
          color: 'var(--text-2)',
          fontSize: 13,
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        Say hello {'\u{1F44B}'}
      </button>
    </div>
  )
}
