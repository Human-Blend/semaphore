// Poll helpers shared by the main process (which validates the draft, writes
// the message body and every vote) and the renderer (which builds the draft and
// renders the tile). Pure — no Electron, no DOM — so both sides agree on the
// wire shape and the tests can exercise the decisions without a browser.
//
// The tally/decision arithmetic a tile needs lives in the renderer
// (`src/renderer/src/poll/polls.ts`); what is here is everything both sides
// must agree on: the pre-1.3 fallback line, the limits, option ids, whether a
// poll is closed, and whether a vote is one this poll can accept.

import { POLL_LIMITS } from './constants'
import type { PollBody } from './types'

export const POLL_DEFAULT_QUESTION = 'Untitled poll'

/** The "Quick decision" preset. Its ids are the contract `decision:true` reads. */
export const DECISION_OPTIONS: { id: string; text: string }[] = [
  { id: 'yes', text: 'Yes' },
  { id: 'no', text: 'No' },
  { id: 'abstain', text: 'Abstain' },
]

/** A poll draft cannot close sooner than this, nor further out than this. */
const CLOSES_MIN_MS = 60_000
const CLOSES_MAX_MS = 30 * 24 * 60 * 60_000

export function cleanQuestion(question: string): string {
  const t = (question ?? '').replace(/\s+/g, ' ').trim().slice(0, POLL_LIMITS.maxQuestionChars)
  return t || POLL_DEFAULT_QUESTION
}

export function cleanOptionText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, POLL_LIMITS.maxOptionChars)
}

/**
 * What a pre-1.3 client shows instead of the tile. `MsgBody.text` is the only
 * field an older `materialize()` renders, so it has to carry the whole story —
 * and it has to say what to do about it, because a 1.1/1.2 client cannot vote
 * (it drops the `.vot.e1` files on the floor: its filename regex rejects them).
 */
export function pollFallbackText(question: string): string {
  return `📊 Poll: ${cleanQuestion(question)} — update Chat to vote`
}

/** Recover the question from `pollFallbackText` (and tolerate anything else). */
export function pollQuestionOf(text: string): string {
  const m = /^📊 Poll: (.*) — update Chat to vote$/.exec((text ?? '').trim())
  return cleanQuestion(m ? m[1] : text)
}

/**
 * The question, wherever it can be found: a 1.3 body carries the `PollBody`, a
 * truncated or hand-made one only has the fallback sentence.
 */
export function pollQuestionFor(body: { text: string; poll?: PollBody }): string {
  const q = body.poll?.question
  return q && q.trim() ? cleanQuestion(q) : pollQuestionOf(body.text)
}

/**
 * The one line a poll message gets where there is no room for the tile: a reply
 * quote, the composer's reply bar. Never `body.text` verbatim — that is the
 * sentence written for pre-1.3 clients, and quoting it back at a 1.3 user tells
 * them to update the app they are already running (the diagram lesson, 1.2).
 */
export function pollPreview(body: { text: string; poll?: PollBody }): string {
  return `📊 ${pollQuestionFor(body)}`
}

/** Notification body — the title is already "Ana in #general". */
export function pollNotifySnippet(body: { text: string; poll?: PollBody }): string {
  return `started a poll: ${pollQuestionFor(body)}`.slice(0, 140)
}

// ---------------------------------------------------------------------------
// Draft validation — the renderer checks to keep the dialog honest, main checks
// again because renderer input is untrusted.

export type PollProblem =
  | 'poll-missing'
  | 'poll-question-empty'
  | 'poll-too-few-options'
  | 'poll-too-many-options'
  | 'poll-option-empty'
  | 'poll-duplicate-option'

/**
 * Two options that read the same are a mistake every time, and an expensive one:
 * the ids differ, so the tally splits one answer across two rows and the poll
 * that was going to decide something reports 3–3 between "Friday" and "friday ".
 * Normalized the way the option text itself is (whitespace collapsed, trimmed)
 * and compared case-insensitively, because that is how a reader tells them apart.
 */
export function validatePollDraft(poll: PollBody | undefined | null): PollProblem | null {
  if (!poll || typeof poll !== 'object' || !Array.isArray(poll.options)) return 'poll-missing'
  if (typeof poll.question !== 'string' || poll.question.trim() === '') return 'poll-question-empty'
  if (poll.options.length < POLL_LIMITS.minOptions) return 'poll-too-few-options'
  if (poll.options.length > POLL_LIMITS.maxOptions) return 'poll-too-many-options'
  if (poll.options.some((o) => !o || cleanOptionText(o.text) === '')) return 'poll-option-empty'
  const seen = new Set<string>()
  for (const o of poll.options) {
    const key = cleanOptionText(o.text).toLowerCase()
    if (seen.has(key)) return 'poll-duplicate-option'
    seen.add(key)
  }
  return null
}

/**
 * The body that actually goes on the share: text trimmed to the limits, option
 * ids filled in where the draft left them out (a renderer never has to invent
 * them) and forced unique — a duplicate id would make one vote count twice.
 */
export function normalizePollBody(poll: PollBody): PollBody {
  const used = new Set<string>()
  const options = poll.options.slice(0, POLL_LIMITS.maxOptions).map((o, i) => {
    let id = typeof o?.id === 'string' ? o.id.trim().slice(0, 24) : ''
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || used.has(id)) {
      let n = i + 1
      id = `o${n}`
      while (used.has(id)) id = `o${++n}`
    }
    used.add(id)
    return { id, text: cleanOptionText(o.text) }
  })
  const out: PollBody = {
    question: cleanQuestion(poll.question),
    options,
    multi: poll.multi === true,
    anonymous: poll.anonymous === true,
  }
  if (poll.decision === true) out.decision = true
  if (typeof poll.closesAt === 'number' && Number.isFinite(poll.closesAt) && poll.closesAt > 0) {
    out.closesAt = Math.round(poll.closesAt)
  }
  if (typeof poll.closedAt === 'number' && Number.isFinite(poll.closedAt) && poll.closedAt > 0) {
    out.closedAt = Math.round(poll.closedAt)
  }
  return out
}

/**
 * `closesAt` arrives from the renderer on its own wall clock; every reader
 * compares it against the share clock. Keep the *interval* the author chose and
 * restate it in share time, then hold it to a sane window so a machine hours
 * out of step cannot publish a poll that is already closed (or never closes).
 */
export function calibrateClosesAt(
  closesAt: number | undefined,
  wallNow: number,
  shareNow: number,
): number | undefined {
  if (typeof closesAt !== 'number' || !Number.isFinite(closesAt) || closesAt <= 0) return undefined
  const span = Math.min(Math.max(closesAt - wallNow, CLOSES_MIN_MS), CLOSES_MAX_MS)
  return Math.round(shareNow + span)
}

// ---------------------------------------------------------------------------
// Votes

/**
 * Closed two ways: the author's closing `edt` set `closedAt`, or the deadline
 * the poll was published with has passed — no event needed for that one, every
 * reader works it out for itself.
 */
export function isPollClosed(poll: PollBody, now: number): boolean {
  if (typeof poll.closedAt === 'number' && poll.closedAt > 0) return true
  return typeof poll.closesAt === 'number' && poll.closesAt > 0 && poll.closesAt <= now
}

export type ChoiceProblem = 'unknown-option' | 'single-choice'

/**
 * Validate a vote against the poll it targets and put it in a canonical order:
 * two devices that picked the same options write the same array, so a retract
 * and a re-vote are trivially comparable. `[]` (retract) is always valid.
 */
export function checkChoice(poll: PollBody, choice: string[]): { choice: string[] } | { error: ChoiceProblem } {
  if (!Array.isArray(choice)) return { error: 'unknown-option' }
  const ids = new Set(poll.options.map((o) => o.id))
  const picked = new Set<string>()
  for (const c of choice) {
    if (typeof c !== 'string' || !ids.has(c)) return { error: 'unknown-option' }
    picked.add(c)
  }
  if (!poll.multi && picked.size > 1) return { error: 'single-choice' }
  return { choice: poll.options.filter((o) => picked.has(o.id)).map((o) => o.id) }
}
