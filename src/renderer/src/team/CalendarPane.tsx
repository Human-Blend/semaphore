import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CalendarItem, Occurrence } from '@shared/calendar'
import { addDays, daysBetween, materializeCalendar, occurrencesInRange, ymd } from '@shared/calendar'
import { TEAM_CONV } from '@shared/constants'
import { useStore, selfOf } from '@/store'
import { Button } from '@/ui/atoms'
import { truncate } from '@/app/chrome'
import { IconCalendar, IconChevronLeft, IconChevronRight, IconPlus } from '@/app/icons'
import { CalendarDialog } from './CalendarDialog'

// Spec §1.3 — the team calendar pane. Owns the whole centre column (no
// ChannelHeader, no right rail): its own 52px header, a Mon–Sun month grid and
// a 90-day Upcoming list, both reading `team:calendar` through the ordinary
// event path. Every date computation comes from @shared/calendar — this file
// only parses 'YYYY-MM-DD' into its parts for weekday/label purposes.

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** Upcoming horizon, in days (spec §1.3). */
const HORIZON_DAYS = 90
/** Chips a month cell shows before collapsing the rest into "+N more". */
const CHIPS_PER_CELL = 3
/** Tallest the day popover can grow before it scrolls its own content. */
const POPOVER_MAX_H = 300

// ---------------------------------------------------------------------------
// Local ymd helpers — parsing only, never arithmetic.

function dateOf(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
}

function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`
}

/** First of the month `n` months from `monthStart` — rolls the year over. */
function shiftMonth(monthStart: string, n: number): string {
  return ymd(new Date(Number(monthStart.slice(0, 4)), Number(monthStart.slice(5, 7)) - 1 + n, 1))
}

function monthLabel(monthStart: string): string {
  return `${MONTHS[Number(monthStart.slice(5, 7)) - 1]} ${monthStart.slice(0, 4)}`
}

function dayNumber(day: string): string {
  return String(Number(day.slice(8, 10)))
}

function weekdayShort(day: string): string {
  return WEEKDAYS[(dateOf(day).getDay() + 6) % 7]
}

function hueVar(n: number): string {
  return `var(--hue-${((Math.trunc(n) % 8) + 8) % 8})`
}

function chipBg(n: number): string {
  return `color-mix(in oklab, ${hueVar(n)} 18%, transparent)`
}

function isBirthday(tag: string): boolean {
  return /birthday/i.test(tag)
}

/** Human phrasing for how far off an occurrence is, relative to `today`. */
function whenLabel(occ: Occurrence, today: string): string {
  const n = daysBetween(today, occ.date)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n > 1) return `in ${n} days`
  const left = daysBetween(today, occ.end)
  if (left <= 0) return 'Ends today'
  return `ends in ${left} day${left === 1 ? '' : 's'}`
}

function spanLabel(occ: Occurrence): string {
  const span = daysBetween(occ.date, occ.end) + 1
  return span > 1 ? `${occ.date} → ${occ.end} (${span} days)` : occ.date
}

/**
 * One bucket per calendar day in [from, to] — a multi-day entry lands in every
 * day it covers (spec: a chip per day, no spanning bars). Occurrences arrive
 * sorted by date then title, so each bucket keeps that order.
 */
function bucketByDay(occs: Occurrence[], from: string, to: string): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>()
  for (const occ of occs) {
    let day = daysBetween(from, occ.date) < 0 ? from : occ.date
    const last = daysBetween(occ.end, to) < 0 ? to : occ.end
    // The window is at most 42 days wide, so the guard can never bite in
    // practice — it only stops a malformed span from spinning forever.
    for (let guard = 0; guard < 64 && daysBetween(day, last) >= 0; guard++) {
      const list = map.get(day)
      if (list) list.push(occ)
      else map.set(day, [occ])
      day = addDays(day, 1)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Pieces

function TagChip({ tag, color }: { tag: string; color: number }) {
  if (!tag) return null
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: hueVar(color),
        background: chipBg(color),
        border: `1px solid color-mix(in oklab, ${hueVar(color)} 34%, transparent)`,
        borderRadius: 'var(--r-xs)',
        padding: '1px 5px',
        lineHeight: '14px',
        userSelect: 'none',
      }}
    >
      {tag}
    </span>
  )
}

/** A single entry as it appears inside a month cell or the day popover. */
function EntryChip({
  occ,
  onOpen,
  wide,
}: {
  occ: Occurrence
  onOpen: () => void
  wide?: boolean
}) {
  const { item } = occ
  const label = `${item.tag ? `${item.tag}: ` : ''}${item.title} — ${spanLabel(occ)}${
    item.annual ? ' · repeats every year' : ''
  }`
  return (
    <button
      className="sem-focus"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      title={label}
      aria-label={`Edit ${label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        minWidth: 0,
        height: wide ? 24 : 18,
        padding: '0 5px',
        border: `1px solid color-mix(in oklab, ${hueVar(item.color)} 26%, transparent)`,
        borderRadius: 'var(--r-xs)',
        background: chipBg(item.color),
        color: hueVar(item.color),
        font: 'inherit',
        fontSize: 11,
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'background var(--t-instant) var(--ease-standard)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = `color-mix(in oklab, ${hueVar(item.color)} 30%, transparent)`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = chipBg(item.color)
      }}
    >
      {item.tag && (
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            opacity: 0.85,
            maxWidth: wide ? 120 : 58,
            ...truncate,
          }}
        >
          {item.tag}
        </span>
      )}
      <span style={{ ...truncate, flex: 1, minWidth: 0, fontWeight: 500 }}>
        {isBirthday(item.tag) ? '🎂 ' : ''}
        {item.title}
      </span>
      {item.annual && (
        <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.75, fontSize: 10 }}>
          ↻
        </span>
      )}
    </button>
  )
}

function DayCell({
  day,
  inMonth,
  isToday,
  occs,
  onAdd,
  onOpen,
  onMore,
}: {
  day: string
  inMonth: boolean
  isToday: boolean
  occs: Occurrence[]
  onAdd: () => void
  onOpen: (item: CalendarItem) => void
  onMore: (rect: DOMRect) => void
}) {
  const shown = occs.slice(0, CHIPS_PER_CELL)
  const hidden = occs.length - shown.length
  return (
    <div
      role="gridcell"
      aria-label={`${weekdayShort(day)} ${day}${occs.length ? ` — ${occs.length} entr${occs.length === 1 ? 'y' : 'ies'}` : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
        minHeight: 0,
        padding: 4,
        borderRight: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border-subtle)',
        background: inMonth ? undefined : 'color-mix(in srgb, var(--bg-sidebar) 45%, transparent)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: 20, flexShrink: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 20,
            height: 20,
            padding: '0 4px',
            borderRadius: 'var(--r-full)',
            fontSize: 12,
            fontWeight: isToday ? 700 : 500,
            color: isToday ? 'var(--accent-text)' : inMonth ? 'var(--text-2)' : 'var(--text-3)',
            border: isToday ? '1px solid var(--accent)' : '1px solid transparent',
            userSelect: 'none',
          }}
        >
          {dayNumber(day)}
        </span>
      </div>

      {shown.map((occ) => (
        <EntryChip key={`${occ.item.id}:${occ.date}`} occ={occ} onOpen={() => onOpen(occ.item)} />
      ))}

      {hidden > 0 && (
        <button
          className="sem-focus"
          onClick={(e) => {
            e.stopPropagation()
            onMore(e.currentTarget.getBoundingClientRect())
          }}
          title={`Show all ${occs.length} entries on ${day}`}
          aria-label={`Show all ${occs.length} entries on ${day}`}
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-3)',
            font: 'inherit',
            fontSize: 11,
            textAlign: 'left',
            padding: '0 5px',
            cursor: 'pointer',
          }}
        >
          +{hidden} more
        </button>
      )}

      <button
        className="sem-focus"
        onClick={onAdd}
        title={`Add an entry on ${day}`}
        aria-label={`Add an entry on ${day}`}
        style={{
          flex: 1,
          minHeight: 12,
          border: 'none',
          background: 'transparent',
          borderRadius: 'var(--r-xs)',
          cursor: 'pointer',
          transition: 'background var(--t-instant) var(--ease-standard)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-raised)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      />
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <span style={{ color: 'var(--text-3)', opacity: 0.7 }} aria-hidden="true">
        <IconCalendar size={40} />
      </span>
      <div style={{ fontSize: 14, color: 'var(--text-2)', maxWidth: 320, lineHeight: '20px' }}>
        No dates yet — add a release, a freeze or a birthday.
      </div>
      <Button onClick={onAdd}>Add an entry</Button>
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: 'month' | 'upcoming'; onChange: (v: 'month' | 'upcoming') => void }) {
  const options: { v: 'month' | 'upcoming'; label: string }[] = [
    { v: 'month', label: 'Month' },
    { v: 'upcoming', label: 'Upcoming' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Calendar view"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={view === o.v}
          title={`${o.label} view`}
          aria-label={`${o.label} view`}
          className="sem-focus"
          onClick={() => onChange(o.v)}
          style={{
            height: 24,
            padding: '0 12px',
            border: 'none',
            borderRadius: 'var(--r-xs)',
            fontSize: 12,
            fontWeight: view === o.v ? 600 : 400,
            fontFamily: 'var(--font-ui)',
            color: view === o.v ? 'var(--text-1)' : 'var(--text-3)',
            background: view === o.v ? 'var(--bg-raised)' : 'transparent',
            cursor: 'pointer',
            transition: 'background var(--t-fast) var(--ease-standard), color var(--t-fast) var(--ease-standard)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="sem-focus"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--r-sm)',
        background: 'transparent',
        color: 'var(--text-2)',
        cursor: 'pointer',
        transition: 'background var(--t-instant) var(--ease-standard)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-raised)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------

export function CalendarPane() {
  const events = useStore((s) => s.events[TEAM_CONV.calendar])
  const ensureEvents = useStore((s) => s.ensureEvents)
  const presence = useStore((s) => s.presence)
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)

  useEffect(() => {
    void ensureEvents(TEAM_CONV.calendar)
  }, [ensureEvents])

  // Recomputed every render: a string, so the memos below only re-run on a real
  // day change (the pane can be open across midnight).
  const today = ymd(new Date())

  const [view, setView] = useState<'month' | 'upcoming'>('month')
  const [month, setMonth] = useState<string>(() => monthStartOf(ymd(new Date())))
  const [dialog, setDialog] = useState<{ entry: CalendarItem | null; date: string } | null>(null)
  const [popover, setPopover] = useState<{ day: string; x: number; y: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverH, setPopoverH] = useState(POPOVER_MAX_H)

  const items = useMemo(() => materializeCalendar(events ?? []), [events])

  const nameOf = useCallback(
    (deviceId: string): string => {
      if (self && deviceId === self.deviceId) return self.displayName
      const p = presence.find((x) => x.deviceId === deviceId)
      return p ? p.name : deviceId.slice(0, 8)
    },
    [presence, self],
  )

  const openNew = useCallback((date: string) => {
    setPopover(null)
    setDialog({ entry: null, date })
  }, [])

  const openEdit = useCallback((item: CalendarItem) => {
    setPopover(null)
    setDialog({ entry: item, date: item.start })
  }, [])

  // Esc closes the day popover; the dialog owns its own Esc (and is never open
  // at the same time — opening it clears the popover).
  useEffect(() => {
    if (!popover) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setPopover(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover])

  // The 5–6 row Mon-start grid for the displayed month, plus the days that
  // spill in from the neighbouring months.
  const grid = useMemo(() => {
    const first = month
    const last = addDays(shiftMonth(month, 1), -1)
    const offset = (dateOf(first).getDay() + 6) % 7
    const start = addDays(first, -offset)
    // 5 rows minimum so the grid does not resize month to month; February
    // starting on a Monday in a non-leap year is the only 4-row case, and
    // 6 rows is common.
    const rows = Math.max(5, Math.ceil((daysBetween(start, last) + 1) / 7))
    const days: string[] = []
    for (let i = 0; i < rows * 7; i++) days.push(addDays(start, i))
    return { start, end: addDays(start, rows * 7 - 1), rows, days }
  }, [month])

  const byDay = useMemo(
    () => bucketByDay(occurrencesInRange(items, grid.start, grid.end), grid.start, grid.end),
    [items, grid],
  )

  const upcomingGroups = useMemo(() => {
    const occs = occurrencesInRange(items, today, addDays(today, HORIZON_DAYS))
    const out: { day: string; list: Occurrence[] }[] = []
    for (const occ of occs) {
      const tail = out[out.length - 1]
      if (tail && tail.day === occ.date) tail.list.push(occ)
      else out.push({ day: occ.date, list: [occ] })
    }
    return out
  }, [items, today])

  const monthPrefix = month.slice(0, 7)
  const popoverOccs = popover ? (byDay.get(popover.day) ?? []) : []

  // The popover grows with the day's entries, so its top is clamped against the
  // height it actually took: a fixed guess pushes the trailing chips and the
  // "Add an entry" button below the viewport edge on a bottom-row day, where
  // nothing can scroll them back (the box is position:fixed). It starts at the
  // maximum so even the first paint, before the measurement, cannot clip.
  useLayoutEffect(() => {
    if (!popover) {
      setPopoverH(POPOVER_MAX_H)
      return
    }
    const el = popoverRef.current
    if (el) setPopoverH(el.offsetHeight)
  }, [popover, popoverOccs.length])

  const headerCell: CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
    textAlign: 'center',
    padding: '6px 0',
    borderRight: '1px solid var(--border-subtle)',
    borderBottom: '1px solid var(--border-subtle)',
    userSelect: 'none',
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)',
        animation: 'sem-fade var(--t-base) var(--ease-standard)',
      }}
    >
      {/* 52px own header (spec §1.3) */}
      <div
        style={{
          height: 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px 0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          minWidth: 0,
        }}
      >
        <span style={{ color: 'var(--text-2)' }} aria-hidden="true">
          <IconCalendar size={17} />
        </span>
        <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
          Team calendar
        </span>

        {view === 'month' && (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 6 }}>
              <NavButton label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
                <IconChevronLeft size={16} />
              </NavButton>
              <NavButton label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
                <IconChevronRight size={16} />
              </NavButton>
            </span>
            <span
              aria-live="polite"
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', whiteSpace: 'nowrap', minWidth: 116 }}
            >
              {monthLabel(month)}
            </span>
            <button
              className="sem-chip-btn"
              onClick={() => setMonth(monthStartOf(ymd(new Date())))}
              title="Jump to the current month"
              aria-label="Jump to the current month"
              style={{ height: 24, padding: '0 10px' }}
            >
              Today
            </button>
          </>
        )}

        <span style={{ flex: 1, minWidth: 0 }} />

        <ViewToggle view={view} onChange={setView} />
        <Button
          onClick={() => openNew(view === 'month' && monthPrefix !== today.slice(0, 7) ? month : today)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <span aria-hidden="true" style={{ display: 'inline-flex' }}>
            <IconPlus size={14} />
          </span>
          Add
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState onAdd={() => openNew(today)} />
      ) : view === 'month' ? (
        <div className="sem-scroll" style={{ flex: 1, minHeight: 0, padding: 12 }}>
          <div
            role="grid"
            aria-label={`${monthLabel(month)} calendar`}
            aria-rowcount={grid.rows + 1}
            aria-colcount={7}
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: grid.rows * 94 + 28,
              border: '1px solid var(--border-subtle)',
              borderRight: 'none',
              borderBottom: 'none',
              borderRadius: 'var(--r-md)',
              overflow: 'hidden',
              background: 'var(--bg-panel)',
            }}
          >
            <div role="row" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', flexShrink: 0 }}>
              {WEEKDAYS.map((w) => (
                <div key={w} role="columnheader" style={headerCell}>
                  {w}
                </div>
              ))}
            </div>
            {Array.from({ length: grid.rows }, (_, r) => (
              <div
                key={r}
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {grid.days.slice(r * 7, r * 7 + 7).map((day) => (
                  <DayCell
                    key={day}
                    day={day}
                    inMonth={day.slice(0, 7) === monthPrefix}
                    isToday={day === today}
                    occs={byDay.get(day) ?? []}
                    onAdd={() => openNew(day)}
                    onOpen={openEdit}
                    onMore={(rect) => setPopover({ day, x: rect.left, y: rect.bottom + 4 })}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="sem-scroll" style={{ flex: 1, minHeight: 0, padding: '8px 16px 24px' }}>
          {upcomingGroups.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
              Nothing in the next {HORIZON_DAYS} days.
            </div>
          ) : (
            upcomingGroups.map((g) => (
              <div key={g.day} style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
                <div
                  style={{
                    width: 46,
                    flexShrink: 0,
                    textAlign: 'center',
                    paddingTop: 2,
                    userSelect: 'none',
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: g.day === today ? 'var(--accent-text)' : 'var(--text-3)',
                    }}
                  >
                    {weekdayShort(g.day)}
                  </div>
                  <div
                    style={{
                      fontSize: 19,
                      fontWeight: 600,
                      lineHeight: '24px',
                      color: g.day === today ? 'var(--accent-text)' : 'var(--text-1)',
                    }}
                  >
                    {dayNumber(g.day)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {MONTHS[Number(g.day.slice(5, 7)) - 1].slice(0, 3)}
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {g.list.map((occ) => (
                    <button
                      key={`${occ.item.id}:${occ.date}`}
                      className="sem-row sem-focus"
                      onClick={() => openEdit(occ.item)}
                      title={`Edit ${occ.item.title} — ${spanLabel(occ)}`}
                      aria-label={`Edit ${occ.item.title} — ${spanLabel(occ)}`}
                      style={{
                        width: '100%',
                        gap: 10,
                        minHeight: 44,
                        padding: '6px 10px',
                        borderRadius: 'var(--r-md)',
                        background: 'var(--bg-panel)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 3,
                          alignSelf: 'stretch',
                          borderRadius: 'var(--r-full)',
                          background: hueVar(occ.item.color),
                          flexShrink: 0,
                        }}
                      />
                      <TagChip tag={occ.item.tag} color={occ.item.color} />
                      <span
                        style={{
                          ...truncate,
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          fontWeight: 500,
                          color: 'var(--text-1)',
                        }}
                      >
                        {isBirthday(occ.item.tag) ? '🎂 ' : ''}
                        {occ.item.title}
                        {occ.item.annual && (
                          <span aria-hidden="true" style={{ color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
                            ↻
                          </span>
                        )}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                        {whenLabel(occ, today)}
                      </span>
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: 11,
                          color: 'var(--text-3)',
                          whiteSpace: 'nowrap',
                          maxWidth: 140,
                          ...truncate,
                        }}
                      >
                        {nameOf(occ.item.author)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {popover && (
        <div
          role="presentation"
          onClick={() => setPopover(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 70 }}
        >
          <div
            role="dialog"
            ref={popoverRef}
            aria-label={`Entries on ${popover.day}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.max(8, Math.min(popover.x, window.innerWidth - 268)),
              top: Math.max(8, Math.min(popover.y, window.innerHeight - popoverH - 8)),
              width: 260,
              maxHeight: POPOVER_MAX_H,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: 10,
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--elev-3)',
              animation: 'sem-rise var(--t-fast) var(--ease-standard)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
                {weekdayShort(popover.day)} {popover.day}
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="sem-focus"
                onClick={() => setPopover(null)}
                title="Close"
                aria-label="Close the day list"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-3)',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 12,
                }}
              >
                Close
              </button>
            </div>
            {popoverOccs.map((occ) => (
              <EntryChip key={`${occ.item.id}:${occ.date}`} occ={occ} wide onOpen={() => openEdit(occ.item)} />
            ))}
            <button
              className="sem-chip-btn"
              onClick={() => openNew(popover.day)}
              title={`Add an entry on ${popover.day}`}
              aria-label={`Add an entry on ${popover.day}`}
              style={{ marginTop: 4, justifyContent: 'center' }}
            >
              Add an entry
            </button>
          </div>
        </div>
      )}

      {dialog && (
        <CalendarDialog entry={dialog.entry} defaultDate={dialog.date} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}
