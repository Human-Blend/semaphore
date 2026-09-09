import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CalendarEntry } from '@shared/types'
import { daysBetween, isYmd, newEntryId } from '@shared/calendar'
import { CALENDAR } from '@shared/constants'
import { Button } from '@/ui/atoms'
import { SectionLabel, Toggle } from '@/app/chrome'
import { toast } from '@/app/toasts'

// Spec §1.3 — the add/edit dialog for a team calendar entry. Same scrim/dialog
// pattern as SettingsModal (role="dialog", aria-modal, Esc closes). Validation
// happens here *before* the bridge call; main re-validates independently
// because renderer input is untrusted.

const TAG_SUGGESTIONS = ['Release', 'Feature freeze', 'Code freeze', 'Birthday', 'Holiday', 'Milestone']
const TAG_LIST_ID = 'sem-cal-tags'

const MAX_TITLE = 120
const MAX_TAG = 24
const MAX_NOTES = 2000

function hueVar(n: number): string {
  return `var(--hue-${((Math.trunc(n) % 8) + 8) % 8})`
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{hint}</div>}
    </div>
  )
}

function Swatches({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {Array.from({ length: CALENDAR.hues }, (_, i) => (
        <button
          key={i}
          role="radio"
          aria-checked={value === i}
          aria-label={`Colour ${i + 1} of ${CALENDAR.hues}`}
          title={`Colour ${i + 1}`}
          className="sem-focus"
          onClick={() => onChange(i)}
          style={{
            width: 22,
            height: 22,
            padding: 0,
            border: 'none',
            borderRadius: 'var(--r-full)',
            background: hueVar(i),
            cursor: 'pointer',
            boxShadow: value === i ? `0 0 0 2px var(--bg-panel), 0 0 0 4px ${hueVar(i)}` : 'none',
            transition: 'box-shadow var(--t-fast) var(--ease-standard)',
          }}
        />
      ))}
    </div>
  )
}

export function CalendarDialog({
  entry,
  defaultDate,
  onClose,
}: {
  entry: CalendarEntry | null
  defaultDate: string
  onClose: () => void
}) {
  const editing = entry !== null
  const [title, setTitle] = useState(entry?.title ?? '')
  const [tag, setTag] = useState(entry?.tag ?? '')
  const [color, setColor] = useState(entry?.color ?? 5)
  const [start, setStart] = useState(entry?.start ?? defaultDate)
  const [end, setEnd] = useState(entry?.end ?? defaultDate)
  const [annual, setAnnual] = useState(entry?.annual ?? false)
  const [notes, setNotes] = useState(entry?.notes ?? '')
  const [attempted, setAttempted] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  // Hoisted so a retry after a failed save reuses the same id (LWW on the
  // share, not a second entry).
  const [draftId] = useState(() => (entry ? entry.id : newEntryId()))
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmedTitle = title.trim()
  const trimmedTag = tag.trim()

  const error = useMemo(() => {
    if (!trimmedTitle) return 'Give the entry a title.'
    if (trimmedTitle.length > MAX_TITLE) return `Titles are at most ${MAX_TITLE} characters.`
    if (trimmedTag.length > MAX_TAG) return `Tags are at most ${MAX_TAG} characters.`
    if (!isYmd(start)) return 'Pick a start date.'
    if (!isYmd(end)) return 'Pick an end date.'
    if (daysBetween(start, end) < 0) return 'The end date is before the start date.'
    if (notes.length > MAX_NOTES) return `Notes are at most ${MAX_NOTES} characters.`
    return ''
  }, [trimmedTitle, trimmedTag, start, end, notes])

  // The date-order mistake is shown the moment it happens; everything else
  // waits until the first Save so the form does not shout at an empty draft.
  const dateOrderBroken = isYmd(start) && isYmd(end) && daysBetween(start, end) < 0
  const visibleError = attempted ? error : dateOrderBroken ? 'The end date is before the start date.' : ''

  async function save() {
    setAttempted(true)
    if (error || busy) return
    const next: CalendarEntry = {
      id: draftId,
      title: trimmedTitle,
      tag: trimmedTag,
      color,
      start,
      end,
      annual,
      notes: notes.trim(),
    }
    setBusy(true)
    try {
      const { queued } = await window.bridge.calendar.put(next)
      toast(
        queued
          ? 'Saved — it will publish when the team folder is back'
          : editing
            ? 'Calendar entry updated'
            : 'Calendar entry added',
        queued ? 'info' : 'success',
      )
      onClose()
    } catch {
      setBusy(false)
      toast('Could not save that entry — the team folder may be unreachable', 'danger')
    }
  }

  async function remove() {
    if (!entry || busy) return
    setBusy(true)
    try {
      const { queued } = await window.bridge.calendar.remove(entry.id)
      toast(
        queued
          ? 'Delete queued — it will publish when the team folder is back'
          : 'Calendar entry deleted',
        queued ? 'info' : 'success',
      )
      onClose()
    } catch {
      setBusy(false)
      toast('Could not delete that entry — the team folder may be unreachable', 'danger')
    }
  }

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        role="dialog"
        aria-label={editing ? 'Edit calendar entry' : 'New calendar entry'}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '16px 20px 12px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>
            {editing ? 'Edit entry' : 'New entry'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Visible to the whole team</span>
        </div>

        <div className="sem-scroll" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Title">
            <input
              ref={titleRef}
              className="sem-input"
              value={title}
              maxLength={MAX_TITLE}
              aria-label="Entry title"
              title="Entry title"
              placeholder="Release 1.2, Team offsite, Ana's birthday…"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </Field>

          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="Tag" hint="Shown as a chip. Anything with “birthday” in it gets a cake.">
                <input
                  className="sem-input"
                  list={TAG_LIST_ID}
                  value={tag}
                  maxLength={MAX_TAG}
                  aria-label="Entry tag"
                  title="Entry tag"
                  placeholder="Release"
                  onChange={(e) => setTag(e.target.value)}
                />
                <datalist id={TAG_LIST_ID}>
                  {TAG_SUGGESTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </Field>
            </div>
            <div style={{ flexShrink: 0 }}>
              <Field label="Colour">
                <div style={{ paddingTop: 5 }}>
                  <Swatches value={color} onChange={setColor} />
                </div>
              </Field>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="Start">
                <input
                  type="date"
                  className="sem-input"
                  value={start}
                  aria-label="Start date"
                  title="Start date"
                  onChange={(e) => {
                    const v = e.target.value
                    setStart(v)
                    // Dragging the start past the end is a slip, not an intent:
                    // carry the end along instead of forcing a second edit.
                    if (isYmd(v) && isYmd(end) && daysBetween(v, end) < 0) setEnd(v)
                  }}
                />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="End" hint="Same as the start for a single day.">
                <input
                  type="date"
                  className="sem-input"
                  value={end}
                  aria-label="End date"
                  title="End date"
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>Repeats every year</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                Same month and day every year from {start || 'the start date'} on. Feb 29 shows on Feb 28 in
                non-leap years.
              </span>
            </span>
            <Toggle on={annual} onChange={setAnnual} label="Repeats every year" />
          </div>

          <Field label="Notes">
            <textarea
              className="sem-input"
              value={notes}
              maxLength={MAX_NOTES}
              rows={3}
              aria-label="Notes"
              title="Notes"
              placeholder="Optional detail — who to ping, what ships, where to be."
              onChange={(e) => setNotes(e.target.value)}
              style={{ height: 68, padding: '8px 10px', resize: 'none', lineHeight: '18px' }}
            />
          </Field>

          {visibleError && (
            <div role="alert" style={{ fontSize: 12, color: 'var(--danger)', lineHeight: '16px' }}>
              {visibleError}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          {editing &&
            (confirmDelete ? (
              <>
                <span style={{ fontSize: 12, color: 'var(--warning)' }}>Delete for everyone?</span>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                  Yes, delete
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
