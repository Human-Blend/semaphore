import type { CalPayload, CalendarEntry, VerifiedEvent } from './types'
import { CALENDAR } from './constants'

// Reader-side merge of the 'team:calendar' event log into calendar entries,
// plus the pure date arithmetic the panes need. No I/O, no Date-locale
// dependence beyond ymd() (which deliberately reads the *local* calendar day).
//
// A "ymd" throughout this file is a plain calendar date 'YYYY-MM-DD' with no
// timezone attached: 2026-03-14 is the same day everywhere.

export interface CalendarItem extends CalendarEntry {
  author: string // deviceId of the last writer
  updatedId: string // event id (stem) of the winning put
}

export interface Occurrence {
  item: CalendarItem
  date: string // 'YYYY-MM-DD' of this occurrence's start
  end: string // 'YYYY-MM-DD' inclusive
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Date helpers

/** Local calendar date of a Date — 'today' must mean the user's today. */
export function ymd(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True for a syntactically well-formed *and real* calendar date. */
export function isYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(t)) return false
  // Reject 2026-02-31 style overflow (Date.parse of an ISO date is strict in
  // V8, but re-render to be certain across engines).
  return fromEpochDay(Math.floor(t / DAY_MS)) === s
}

function epochDay(a: string): number {
  return Math.floor(Date.parse(`${a}T00:00:00Z`) / DAY_MS)
}

function fromEpochDay(days: number): string {
  const d = new Date(days * DAY_MS)
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(day: string, n: number): string {
  return fromEpochDay(epochDay(day) + n)
}

/** Whole days from `a` to `b` (negative when b precedes a). */
export function daysBetween(a: string, b: string): number {
  return epochDay(b) - epochDay(a)
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Same month/day in `year`; Feb 29 lands on Feb 28 in non-leap years. */
function inYear(day: string, year: number): string {
  const mm = day.slice(5, 7)
  let dd = day.slice(8, 10)
  if (mm === '02' && dd === '29' && !isLeap(year)) dd = '28'
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`
}

/** 16 hex chars — works in the renderer (WebCrypto) and in main/node. */
export function newEntryId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// Materialization

function validEntry(e: unknown): e is CalendarEntry {
  if (!e || typeof e !== 'object') return false
  const c = e as Record<string, unknown>
  if (typeof c.id !== 'string' || c.id.length === 0) return false
  if (typeof c.title !== 'string' || typeof c.tag !== 'string' || typeof c.notes !== 'string') return false
  if (typeof c.annual !== 'boolean') return false
  if (typeof c.color !== 'number' || !Number.isInteger(c.color) || c.color < 0 || c.color >= CALENDAR.hues) return false
  if (!isYmd(c.start) || !isYmd(c.end)) return false
  if (daysBetween(c.start as string, c.end as string) < 0) return false
  return true
}

/**
 * LWW by `entry.id` in stem order: the last 'put' wins, a 'del' tombstones an
 * entry, and a later 'put' resurrects it (a tombstone only beats an *older*
 * put). Unverified events and malformed entries are ignored outright, so a
 * garbage write can never erase a good earlier one.
 */
export function materializeCalendar(events: VerifiedEvent[]): CalendarItem[] {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const live = new Map<string, CalendarItem | null>() // null = tombstoned

  for (const ev of sorted) {
    if (!ev.verified) continue
    const p = ev.payload as CalPayload
    if (!p || p.t !== 'cal') continue
    if (p.op === 'del') {
      if (typeof p.id !== 'string' || p.id.length === 0) continue
      live.set(p.id, null)
      continue
    }
    if (p.op !== 'put') continue
    if (!validEntry(p.entry)) continue
    const e = p.entry
    live.set(e.id, {
      id: e.id,
      title: e.title,
      tag: e.tag,
      color: e.color,
      start: e.start,
      end: e.end,
      annual: e.annual,
      notes: e.notes,
      author: ev.author,
      updatedId: ev.id,
    })
  }

  const items: CalendarItem[] = []
  for (const v of live.values()) if (v) items.push(v)
  items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return items
}

// ---------------------------------------------------------------------------
// Occurrences

function sortOccurrences(list: Occurrence[]): Occurrence[] {
  list.sort((a, b) =>
    a.date < b.date
      ? -1
      : a.date > b.date
        ? 1
        : a.item.title < b.item.title
          ? -1
          : a.item.title > b.item.title
            ? 1
            : 0,
  )
  return list
}

/**
 * Every occurrence whose own [date, end] span intersects [fromYmd, toYmd].
 * Annual entries repeat on the same month/day in every year of the window at
 * or after their first year; Feb 29 falls back to Feb 28.
 */
export function occurrencesInRange(items: CalendarItem[], fromYmd: string, toYmd: string): Occurrence[] {
  const out: Occurrence[] = []
  if (!isYmd(fromYmd) || !isYmd(toYmd) || daysBetween(fromYmd, toYmd) < 0) return out

  const fromYear = Number(fromYmd.slice(0, 4))
  const toYear = Number(toYmd.slice(0, 4))

  for (const item of items) {
    const span = daysBetween(item.start, item.end)
    if (!item.annual) {
      if (daysBetween(fromYmd, item.end) >= 0 && daysBetween(item.start, toYmd) >= 0) {
        out.push({ item, date: item.start, end: item.end })
      }
      continue
    }
    const firstYear = Number(item.start.slice(0, 4))
    // A multi-day annual entry can start in the previous year and run into the
    // window, so start one year early.
    for (let y = fromYear - 1; y <= toYear; y++) {
      if (y < firstYear) continue
      const date = inYear(item.start, y)
      const end = addDays(date, span)
      if (daysBetween(fromYmd, end) >= 0 && daysBetween(date, toYmd) >= 0) out.push({ item, date, end })
    }
  }

  return sortOccurrences(out)
}

/** The next `limit` occurrences that have not finished before `todayYmd`. */
export function upcoming(items: CalendarItem[], todayYmd: string, limit: number): Occurrence[] {
  if (!isYmd(todayYmd) || limit <= 0) return []
  const list = occurrencesInRange(items, todayYmd, addDays(todayYmd, 365))
  return list.slice(0, limit)
}
