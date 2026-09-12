import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConvId, PollBody } from '@shared/types'
import { POLL_LIMITS } from '@shared/constants'
import { DECISION_OPTIONS, validatePollDraft } from '@shared/poll'
import { useStore } from '@/store'
import { Button } from '@/ui/atoms'
import { SectionLabel, Toggle } from '@/app/chrome'
import { trapTabWithin } from '@/app/ChannelMenu'
import { toast } from '@/app/toasts'

// The composer's poll dialog. Same scrim/dialog pattern as CalendarDialog
// (role="dialog", aria-modal, Esc closes, Tab trapped). Validation happens here
// so the form can say what is wrong; main validates again, because everything
// that arrives over the bridge is untrusted.

const CLOSE_CHOICES: { label: string; hours: number }[] = [
  { label: 'No deadline', hours: 0 },
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: '24 hours', hours: 24 },
]

interface Draft {
  id: string
  text: string
}

let nextLocalId = 0
const localId = (): string => `d${nextLocalId++}`

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{hint}</div>}
    </div>
  )
}

export function PollDialog({ conv, label, onClose }: { conv: ConvId; label: string; onClose: () => void }) {
  const send = useStore((s) => s.send)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<Draft[]>(() => [
    { id: localId(), text: '' },
    { id: localId(), text: '' },
  ])
  const [multi, setMulti] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [decision, setDecision] = useState(false)
  const [closeHours, setCloseHours] = useState(0)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const questionRef = useRef<HTMLInputElement>(null)
  const lastOptionRef = useRef<HTMLInputElement>(null)
  const focusLast = useRef(false)

  useEffect(() => {
    questionRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A freshly added option should be the one you are typing in.
  useEffect(() => {
    if (!focusLast.current) return
    focusLast.current = false
    lastOptionRef.current?.focus()
  }, [options.length])

  /**
   * The Quick decision preset: Yes / No / Abstain, single choice, and
   * `decision: true` so a closed poll can say "Decided: Yes (4–1)" instead of
   * making everyone count the rows. Turning it off hands the options back.
   */
  function toggleDecision(on: boolean): void {
    setDecision(on)
    if (on) {
      setOptions(DECISION_OPTIONS.map((o) => ({ id: o.id, text: o.text })))
      setMulti(false)
    } else {
      setOptions([
        { id: localId(), text: '' },
        { id: localId(), text: '' },
      ])
    }
  }

  const draft = useMemo<PollBody>(
    () => ({
      question: question.trim(),
      // A blank row in the middle is a slip, not an option: drop the empties,
      // and let validation speak up only if too few are left.
      options: options
        .filter((o) => o.text.trim() !== '')
        .map((o) => ({ id: decision ? o.id : '', text: o.text.trim() })),
      multi,
      anonymous,
      ...(decision ? { decision: true } : {}),
    }),
    [question, options, multi, anonymous, decision],
  )

  const problem = validatePollDraft(draft)
  const errorText =
    problem === 'poll-question-empty'
      ? 'Ask a question first.'
      : problem === 'poll-too-few-options'
        ? `Give people at least ${POLL_LIMITS.minOptions} options to choose from.`
        : problem === 'poll-too-many-options'
          ? `A poll holds at most ${POLL_LIMITS.maxOptions} options.`
          : problem === 'poll-duplicate-option'
            ? 'Two options say the same thing — one answer cannot win twice.'
            : problem
              ? 'Fill in every option, or remove the empty ones.'
              : ''

  async function create(): Promise<void> {
    setAttempted(true)
    if (problem || busy) return
    setBusy(true)
    // The deadline is counted from the press, not from whenever this dialog
    // happened to render — it can sit open for a long while. Main restates it
    // on the share clock (`calibrateClosesAt`), which is what readers compare
    // against; this side only says how long the author wants.
    const poll: PollBody =
      closeHours > 0 ? { ...draft, closesAt: Date.now() + closeHours * 3600_000 } : draft
    try {
      await send(conv, { kind: 'poll', text: poll.question, poll })
      onClose()
    } catch (err) {
      setBusy(false)
      const msg = err instanceof Error ? err.message : String(err)
      toast(
        msg.includes('queued')
          ? 'Poll queued — it will publish when the team folder is back'
          : 'Could not send that poll',
        msg.includes('queued') ? 'info' : 'danger',
      )
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
        ref={dialogRef}
        role="dialog"
        aria-label="New poll"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapTabWithin(dialogRef.current, e)}
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
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>New poll</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Posts to {label}</span>
        </div>

        <div className="sem-scroll" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
          <Field label="Question">
            <input
              ref={questionRef}
              className="sem-input"
              value={question}
              maxLength={POLL_LIMITS.maxQuestionChars}
              aria-label="Poll question"
              title="Poll question"
              placeholder="Ship on Friday?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
            />
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>Quick decision</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                Yes / No / Abstain. When you close it, the poll says which way it went — abstentions don’t count,
                a tie is no decision.
              </span>
            </span>
            <Toggle on={decision} onChange={toggleDecision} label="Quick decision" />
          </div>

          <Field
            label="Options"
            hint={decision ? 'The quick-decision preset sets these.' : `${POLL_LIMITS.minOptions}–${POLL_LIMITS.maxOptions} options.`}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {options.map((o, i) => (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    ref={i === options.length - 1 ? lastOptionRef : undefined}
                    className="sem-input"
                    value={o.text}
                    disabled={decision}
                    maxLength={POLL_LIMITS.maxOptionChars}
                    aria-label={`Option ${i + 1}`}
                    title={`Option ${i + 1}`}
                    placeholder={i === 0 ? 'Yes, ship it' : i === 1 ? 'Wait for Monday' : `Option ${i + 1}`}
                    onChange={(e) =>
                      setOptions((prev) => prev.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      if (i === options.length - 1 && options.length < POLL_LIMITS.maxOptions && o.text.trim()) {
                        focusLast.current = true
                        setOptions((prev) => [...prev, { id: localId(), text: '' }])
                      } else {
                        void create()
                      }
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    type="button"
                    className="sem-focus"
                    aria-label={`Remove option ${i + 1}`}
                    title="Remove this option"
                    disabled={decision || options.length <= POLL_LIMITS.minOptions}
                    onClick={() => setOptions((prev) => prev.filter((x) => x.id !== o.id))}
                    style={{
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      border: 'none',
                      borderRadius: 'var(--r-sm)',
                      background: 'transparent',
                      color: 'var(--text-3)',
                      cursor: decision || options.length <= POLL_LIMITS.minOptions ? 'default' : 'pointer',
                      opacity: decision || options.length <= POLL_LIMITS.minOptions ? 0.4 : 1,
                      fontSize: 14,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {!decision && options.length < POLL_LIMITS.maxOptions && (
                <button
                  type="button"
                  className="sem-focus"
                  onClick={() => {
                    focusLast.current = true
                    setOptions((prev) => [...prev, { id: localId(), text: '' }])
                  }}
                  style={{
                    alignSelf: 'flex-start',
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    color: 'var(--accent-text)',
                    fontSize: 12,
                    fontFamily: 'var(--font-ui)',
                    cursor: 'pointer',
                  }}
                >
                  + Add option
                </button>
              )}
            </div>
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>Multiple choice</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                People can pick more than one option.
              </span>
            </span>
            <Toggle on={multi} onChange={setMulti} label="Multiple choice" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>Anonymous</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                Hides who voted for what in the app. Every vote is still a signed event on the share, so anyone
                with the folder can work it out — this is politeness, not secrecy.
              </span>
            </span>
            <Toggle on={anonymous} onChange={setAnonymous} label="Anonymous" />
          </div>

          <Field label="Closes in">
            <div role="radiogroup" aria-label="Closes in" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CLOSE_CHOICES.map((c) => (
                <button
                  key={c.hours}
                  type="button"
                  role="radio"
                  aria-checked={closeHours === c.hours}
                  className="sem-chipbtn sem-focus"
                  onClick={() => setCloseHours(c.hours)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 'var(--r-full)',
                    border: `1px solid ${closeHours === c.hours ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: closeHours === c.hours ? 'var(--accent-soft)' : 'transparent',
                    color: closeHours === c.hours ? 'var(--accent-text)' : 'var(--text-2)',
                    fontSize: 12,
                    fontFamily: 'var(--font-ui)',
                    cursor: 'pointer',
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>

          {attempted && errorText && (
            <div role="alert" style={{ fontSize: 12, color: 'var(--danger)', lineHeight: '16px' }}>
              {errorText}
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
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Anyone on an older Chat sees a line telling them to update.
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? 'Sending…' : 'Create poll'}
          </Button>
        </div>
      </div>
    </div>
  )
}
