import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { CalPayload, CalendarEntry } from '@shared/types'
import { CALENDAR, TEAM_CONV } from '@shared/constants'
import { daysBetween, isYmd } from '@shared/calendar'
import type { AppController } from '../appController'

// Team-calendar IPC slice. Reading is via the existing chat:events channel —
// the calendar is just an event log — so the only handlers here are the two
// writes, and both re-validate the renderer's entry from scratch: the renderer
// is sandboxed web code and its input is untrusted. Anything that would not
// survive materializeCalendar() is rejected here rather than written to the
// share as a permanently-dropped record.

const MAX = { title: 120, tag: 24, notes: 2000 } as const
const ID_RE = /^[0-9a-f]{16}$/

/** Throws with a short, renderer-showable reason. */
function validateEntry(input: unknown): CalendarEntry {
  const bad = (why: string): never => {
    throw new Error(`invalid-entry: ${why}`)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('not an object')
  const e = input as Record<string, unknown>

  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) bad('id must be 16 hex chars')
  if (typeof e.title !== 'string') bad('title must be a string')
  if (typeof e.tag !== 'string') bad('tag must be a string')
  if (typeof e.notes !== 'string') bad('notes must be a string')
  const title = (e.title as string).trim()
  if (title.length === 0) bad('title is empty')
  if (title.length > MAX.title) bad(`title over ${MAX.title} chars`)
  if ((e.tag as string).length > MAX.tag) bad(`tag over ${MAX.tag} chars`)
  if ((e.notes as string).length > MAX.notes) bad(`notes over ${MAX.notes} chars`)
  if (typeof e.annual !== 'boolean') bad('annual must be a boolean')
  if (typeof e.color !== 'number' || !Number.isInteger(e.color) || e.color < 0 || e.color >= CALENDAR.hues) {
    bad(`color must be an integer 0..${CALENDAR.hues - 1}`)
  }
  if (!isYmd(e.start)) bad('start must be a real YYYY-MM-DD date')
  if (!isYmd(e.end)) bad('end must be a real YYYY-MM-DD date')
  if (daysBetween(e.start as string, e.end as string) < 0) bad('end is before start')

  // Rebuilt field by field: no extra keys reach the canonical-JSON payload.
  return {
    id: e.id as string,
    title,
    tag: e.tag as string,
    color: e.color as number,
    start: e.start as string,
    end: e.end as string,
    annual: e.annual as boolean,
    notes: e.notes as string,
  }
}

export function registerCalendarIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  void getWindow // the calendar has no window-bound surface in main

  const chat = () => {
    const c = controller.chat
    if (!c) throw new Error('not-ready')
    return c
  }
  const conv = TEAM_CONV.calendar

  // Both writes resolve with { queued } — a write the outbox accepted while
  // the share was down is not a failure, and reporting it as one would make
  // the dialog invite a retry that mints a second entry id for one entry.
  ipcMain.handle('calendar:put', async (_e, entry: CalendarEntry) => {
    const clean = validateEntry(entry)
    const payload: CalPayload = { t: 'cal', conv, op: 'put', entry: clean }
    return chat().publishTeam(conv, 'cal', payload)
  })

  ipcMain.handle('calendar:remove', async (_e, id: string) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid-entry: id must be 16 hex chars')
    const payload: CalPayload = { t: 'cal', conv, op: 'del', id }
    return chat().publishTeam(conv, 'cal', payload)
  })
}
