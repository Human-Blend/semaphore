import { describe, expect, it } from 'vitest'
import {
  addDays,
  daysBetween,
  materializeCalendar,
  newEntryId,
  occurrencesInRange,
  upcoming,
  ymd,
  type CalendarItem,
} from './calendar'
import type { CalPayload, CalendarEntry, VerifiedEvent } from './types'

const CONV = 'team:calendar' as const

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'a1b2c3d4e5f60718',
    title: 'Release 1.1',
    tag: 'Release',
    color: 3,
    start: '2026-03-10',
    end: '2026-03-10',
    annual: false,
    notes: '',
    ...over,
  }
}

let n = 0
function ev(payload: CalPayload, over: Partial<VerifiedEvent> = {}): VerifiedEvent {
  n += 1
  return {
    id: `17000000000${String(n).padStart(2, '0')}-0001-aaaaaaaa`,
    type: 'cal',
    payload,
    author: 'aaaaaaaabbbbbbbb',
    verified: true,
    receivedAt: 0,
    ...over,
  }
}

function put(e: CalendarEntry, over: Partial<VerifiedEvent> = {}): VerifiedEvent {
  return ev({ t: 'cal', conv: CONV, op: 'put', entry: e }, over)
}

function del(id: string, over: Partial<VerifiedEvent> = {}): VerifiedEvent {
  return ev({ t: 'cal', conv: CONV, op: 'del', id }, over)
}

function item(over: Partial<CalendarItem> = {}): CalendarItem {
  return { ...entry(), author: 'aaaaaaaabbbbbbbb', updatedId: 'x', ...over }
}

describe('date helpers', () => {
  it('ymd reads the local calendar day', () => {
    expect(ymd(new Date(2026, 2, 9, 23, 30))).toBe('2026-03-09')
    expect(ymd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })

  it('addDays crosses months, years and leap days', () => {
    expect(addDays('2026-03-10', 5)).toBe('2026-03-15')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('daysBetween is signed and inclusive of neither end', () => {
    expect(daysBetween('2026-03-10', '2026-03-13')).toBe(3)
    expect(daysBetween('2026-03-13', '2026-03-10')).toBe(-3)
    expect(daysBetween('2026-03-10', '2026-03-10')).toBe(0)
  })

  it('newEntryId is 16 hex and does not repeat', () => {
    const a = newEntryId()
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(newEntryId())
  })
})

describe('materializeCalendar', () => {
  it('is last-writer-wins by entry id in stem order, whatever the array order', () => {
    const first = put(entry({ title: 'Release 1.1' }))
    const second = put(entry({ title: 'Release 1.1 (slipped)', start: '2026-03-17', end: '2026-03-17' }))
    const items = materializeCalendar([second, first])
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Release 1.1 (slipped)')
    expect(items[0].start).toBe('2026-03-17')
    expect(items[0].updatedId).toBe(second.id)
    expect(items[0].author).toBe('aaaaaaaabbbbbbbb')
  })

  it('keeps separate ids apart and sorts by start then title', () => {
    const a = put(entry({ id: '1111111111111111', title: 'Zebra', start: '2026-03-10', end: '2026-03-10' }))
    const b = put(entry({ id: '2222222222222222', title: 'Alpha', start: '2026-03-10', end: '2026-03-10' }))
    const c = put(entry({ id: '3333333333333333', title: 'Earlier', start: '2026-01-02', end: '2026-01-02' }))
    expect(materializeCalendar([a, b, c]).map((i) => i.title)).toEqual(['Earlier', 'Alpha', 'Zebra'])
  })

  it('tombstones a put, and a newer put resurrects it', () => {
    const p1 = put(entry())
    const d = del(entry().id)
    expect(materializeCalendar([p1, d])).toEqual([])

    const p2 = put(entry({ title: 'Back on' }))
    const items = materializeCalendar([p1, d, p2])
    expect(items.map((i) => i.title)).toEqual(['Back on'])
  })

  it('a tombstone older than the put does not remove it', () => {
    const d = del(entry().id) // written first — lower stem
    const p = put(entry()) // written second — higher stem
    expect(d.id < p.id).toBe(true)
    expect(materializeCalendar([p, d]).map((i) => i.id)).toEqual([entry().id])
  })

  it('drops invalid entries without clobbering a good earlier one', () => {
    const good = put(entry({ title: 'Good' }))
    const badDate = put(entry({ title: 'Bad', start: '2026-3-1' }))
    const overflowDate = put(entry({ title: 'Bad', start: '2026-02-31', end: '2026-02-31' }))
    const backwards = put(entry({ title: 'Bad', start: '2026-03-10', end: '2026-03-09' }))
    const hue = put(entry({ title: 'Bad', color: 8 }))
    const negHue = put(entry({ title: 'Bad', color: -1 }))
    const fracHue = put(entry({ title: 'Bad', color: 1.5 }))
    const items = materializeCalendar([good, badDate, overflowDate, backwards, hue, negHue, fracHue])
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Good')
  })

  it('skips unverified events and non-cal payloads', () => {
    const forged = put(entry({ title: 'Forged' }), { verified: false })
    expect(materializeCalendar([forged])).toEqual([])

    const other = ev({ t: 'cal', conv: CONV, op: 'put', entry: entry() })
    const notCal = { ...other, payload: { t: 'msg' } as unknown as CalPayload }
    expect(materializeCalendar([notCal as VerifiedEvent])).toEqual([])
  })
})

describe('occurrencesInRange', () => {
  it('includes a multi-day entry that merely overlaps the window', () => {
    const freeze = item({ id: 'f1', title: 'Code freeze', start: '2026-03-08', end: '2026-03-20' })
    const occ = occurrencesInRange([freeze], '2026-03-15', '2026-03-16')
    expect(occ).toHaveLength(1)
    expect(occ[0]).toMatchObject({ date: '2026-03-08', end: '2026-03-20' })
  })

  it('excludes entries entirely outside the window', () => {
    const past = item({ id: 'p', start: '2026-01-01', end: '2026-01-02' })
    const future = item({ id: 'f', start: '2027-01-01', end: '2027-01-02' })
    expect(occurrencesInRange([past, future], '2026-03-01', '2026-03-31')).toEqual([])
  })

  it('expands annual entries to every year at or after the first, across a year boundary', () => {
    const bday = item({ id: 'b', title: 'Ana', tag: 'Birthday', annual: true, start: '2020-12-30', end: '2020-12-30' })
    const dates = occurrencesInRange([bday], '2026-06-01', '2028-06-01').map((o) => o.date)
    expect(dates).toEqual(['2026-12-30', '2027-12-30'])
  })

  it('does not expand an annual entry before its first year', () => {
    const bday = item({ id: 'b', annual: true, start: '2027-05-04', end: '2027-05-04' })
    expect(occurrencesInRange([bday], '2025-01-01', '2026-12-31')).toEqual([])
  })

  it('lands Feb 29 on Feb 28 in non-leap years and back on Feb 29 in leap years', () => {
    const leap = item({ id: 'l', title: 'Leapling', annual: true, start: '2024-02-29', end: '2024-02-29' })
    const dates = occurrencesInRange([leap], '2025-01-01', '2028-12-31').map((o) => o.date)
    expect(dates).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'])
  })

  it('keeps an annual entry the same length each year', () => {
    const week = item({ id: 'w', annual: true, start: '2025-12-29', end: '2026-01-04' })
    const occ = occurrencesInRange([week], '2027-01-01', '2027-01-02')
    expect(occ).toHaveLength(1)
    expect(occ[0]).toMatchObject({ date: '2026-12-29', end: '2027-01-04' })
  })

  it('sorts by date then title and rejects a backwards window', () => {
    const a = item({ id: 'a', title: 'Beta', start: '2026-03-10', end: '2026-03-10' })
    const b = item({ id: 'b', title: 'Alpha', start: '2026-03-10', end: '2026-03-10' })
    const c = item({ id: 'c', title: 'Gamma', start: '2026-03-09', end: '2026-03-09' })
    expect(occurrencesInRange([a, b, c], '2026-03-01', '2026-03-31').map((o) => o.item.title)).toEqual([
      'Gamma',
      'Alpha',
      'Beta',
    ])
    expect(occurrencesInRange([a], '2026-03-31', '2026-03-01')).toEqual([])
  })
})

describe('upcoming', () => {
  it('orders by date and honours the limit', () => {
    const items = [
      item({ id: '1', title: 'Third', start: '2026-04-01', end: '2026-04-01' }),
      item({ id: '2', title: 'First', start: '2026-03-09', end: '2026-03-09' }),
      item({ id: '3', title: 'Second', start: '2026-03-20', end: '2026-03-20' }),
      item({ id: '4', title: 'Past', start: '2026-01-01', end: '2026-01-01' }),
    ]
    expect(upcoming(items, '2026-03-09', 2).map((o) => o.item.title)).toEqual(['First', 'Second'])
    expect(upcoming(items, '2026-03-09', 10).map((o) => o.item.title)).toEqual(['First', 'Second', 'Third'])
  })

  it('keeps an entry that started earlier but is still running', () => {
    const running = item({ id: 'r', title: 'Freeze', start: '2026-03-01', end: '2026-03-20' })
    expect(upcoming([running], '2026-03-09', 5)).toHaveLength(1)
  })

  it('returns nothing for a non-positive limit or a bad date', () => {
    const it1 = item({ id: 'x', start: '2026-03-10', end: '2026-03-10' })
    expect(upcoming([it1], '2026-03-09', 0)).toEqual([])
    expect(upcoming([it1], 'nope', 5)).toEqual([])
  })
})
